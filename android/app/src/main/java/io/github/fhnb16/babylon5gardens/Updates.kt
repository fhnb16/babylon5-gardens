package io.github.fhnb16.babylon5gardens

import android.app.PendingIntent
import android.app.job.*
import android.content.*
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

object Updates {
    private const val DAY = 24L * 60 * 60 * 1000
    private const val MAX_APK = 256L * 1024 * 1024
    private const val FEED = "https://api.github.com/repos/fhnb16/babylon5-gardens/releases/latest"
    private const val RELEASE_PACKAGE = "io.github.fhnb16.babylon5gardens"
    private const val ASSET = "babylon5-gardens.apk"
    private const val JOB_ID = 21300
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile var installing = false
        private set
    private var confirmation: Intent? = null

    private fun supported(c: Context) = c.packageName == RELEASE_PACKAGE
    private fun prefs(c: Context) = c.getSharedPreferences("releases", Context.MODE_PRIVATE)
    private fun apk(c: Context) = File(c.cacheDir, ASSET)
    private fun installed(c: Context) = c.packageManager.getPackageInfo(c.packageName, PackageManager.GET_SIGNING_CERTIFICATES)

    fun schedule(c: Context) {
        val scheduler = c.getSystemService(JobScheduler::class.java)
        if (!supported(c)) {
            scheduler.cancel(JOB_ID)
            return
        }
        if (scheduler.getPendingJob(JOB_ID)?.isPersisted != true) {
            scheduler.schedule(JobInfo.Builder(JOB_ID, ComponentName(c, ReleaseJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(DAY).setPersisted(true).build())
        }
    }

    fun canOffer(c: Context): Boolean {
        val p = prefs(c)
        return p.getLong("offeredVersion", 0) != p.getLong("version", 0) ||
            System.currentTimeMillis() - p.getLong("offeredAt", 0) !in 0 until DAY
    }

    fun deferOffer(c: Context) {
        val p = prefs(c)
        p.edit().putLong("offeredVersion", p.getLong("version", 0))
            .putLong("offeredAt", System.currentTimeMillis()).apply()
    }

    private fun <T> request(url: String, read: (HttpsURLConnection) -> T): T {
        val conn = URL(url).openConnection() as HttpsURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 45000
        conn.setRequestProperty("User-Agent", "Babylon5-Gardens-Android")
        return try { read(conn) } finally { conn.disconnect() }
    }

    private fun versionCode(tag: String): Long {
        val match = Regex("""v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})""").matchEntire(tag)
            ?: error("Неподдерживаемый тег релиза")
        val (major, minor, patch) = match.destructured
        return major.toLong() * 1000000 + minor.toLong() * 1000 + patch.toLong()
    }

    private fun verify(c: Context, file: File, digest: String, code: Long) {
        val hash = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buf = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val size = input.read(buf)
                if (size < 0) break
                hash.update(buf, 0, size)
            }
        }
        val actual = hash.digest().joinToString("") { "%02x".format(it) }
        require(digest == "sha256:$actual") { "Контрольная сумма APK не совпала" }
        val current = installed(c)
        val incoming = c.packageManager.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: error("Android не распознал APK")
        fun signers(info: PackageInfo) = info.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet().orEmpty()
        val expected = signers(current)
        require(incoming.packageName == c.packageName && incoming.longVersionCode == code &&
            code > current.longVersionCode && expected.isNotEmpty() && signers(incoming) == expected) {
            "Версия, пакет или сертификат обновления не совпали"
        }
    }

    fun check(context: Context, manual: Boolean, done: (Boolean, String) -> Unit) {
        val c = context.applicationContext
        if (!supported(c)) {
            done(false, "Обновления из GitHub доступны для релизной сборки")
            return
        }
        executor.execute {
            val p = prefs(c)
            try {
                val target = apk(c)
                val saved = p.getLong("version", 0)
                val current = installed(c).longVersionCode
                if (saved > current) {
                    try {
                        verify(c, target, p.getString("digest", "").orEmpty(), saved)
                        done(true, "Обновление скачано и проверено")
                        return@execute
                    } catch (_: Exception) {
                        target.delete()
                        p.edit().remove("version").remove("digest").remove("checked").apply()
                    }
                } else if (target.exists()) {
                    target.delete()
                    p.edit().remove("version").remove("digest").apply()
                }
                if (!manual && System.currentTimeMillis() - p.getLong("checked", 0) in 0 until DAY) {
                    done(false, "Проверка уже выполнена")
                    return@execute
                }
                val release = request(FEED) { conn ->
                    if (conn.responseCode == 404) null
                    else conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
                }
                if (release == null || release.getBoolean("draft") || release.getBoolean("prerelease") ||
                    versionCode(release.getString("tag_name")) <= current) {
                    p.edit().putLong("checked", System.currentTimeMillis()).apply()
                    done(false, "Новых версий нет")
                    return@execute
                }
                val assets = release.getJSONArray("assets")
                val asset = (0 until assets.length()).map { assets.getJSONObject(it) }
                    .singleOrNull { it.getString("name") == ASSET && it.getString("state") == "uploaded" }
                    ?: error("Подписанный APK ещё не опубликован")
                val expectedSize = asset.getLong("size")
                require(expectedSize in 1..MAX_APK)
                val code = versionCode(release.getString("tag_name"))
                val digest = asset.getString("digest")
                require(Regex("sha256:[0-9a-f]{64}").matches(digest)) { "GitHub не предоставил контрольную сумму APK" }
                val temp = File(c.cacheDir, "$ASSET.part")
                try {
                    request(asset.getString("browser_download_url")) { conn ->
                        conn.inputStream.buffered().use { input -> temp.outputStream().buffered().use { out ->
                            var count = 0L
                            val buf = ByteArray(DEFAULT_BUFFER_SIZE)
                            while (true) {
                                val size = input.read(buf)
                                if (size < 0) break
                                count += size
                                require(count <= expectedSize)
                                out.write(buf, 0, size)
                            }
                            require(count == expectedSize)
                        } }
                    }
                    verify(c, temp, digest, code)
                    check(temp.renameTo(target)) { "Не удалось сохранить APK" }
                    check(p.edit().putLong("version", code).putString("digest", digest)
                        .putLong("checked", System.currentTimeMillis()).commit()) { "Не удалось сохранить сведения об APK" }
                    done(true, "Доступна версия " + release.getString("tag_name"))
                } finally { temp.delete() }
            } catch (e: Exception) {
                done(false, "Не удалось получить обновление: " + (e.localizedMessage ?: "ошибка сети"))
            }
        }
    }

    fun install(c: GardensActivity) {
        if (installing || !supported(c)) return
        installing = true
        val app = c.applicationContext
        executor.execute {
            val installer = app.packageManager.packageInstaller
            var sessionId: Int? = null
            try {
                val file = apk(app)
                val p = prefs(app)
                verify(app, file, p.getString("digest", "").orEmpty(), p.getLong("version", 0))
                val previous = p.getInt("session", -1)
                if (previous >= 0) runCatching { installer.abandonSession(previous) }
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(app.packageName)
                params.setSize(file.length())
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                val id = installer.createSession(params)
                sessionId = id
                check(p.edit().putInt("session", id).commit()) { "Не удалось сохранить сеанс установки" }
                installer.openSession(id).use { session ->
                    session.openWrite("base.apk", 0, file.length()).use { out ->
                        file.inputStream().use { it.copyTo(out) }
                        session.fsync(out)
                    }
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    val callback = PendingIntent.getBroadcast(app, id, Intent(app, InstallResult::class.java), flags)
                    session.commit(callback.intentSender)
                }
            } catch (e: Exception) {
                sessionId?.let { runCatching { installer.abandonSession(it) } }
                sessionId?.let { prefs(app).edit().remove("session").apply() }
                installing = false
                c.runOnUiThread { Toast.makeText(c, "Установка: " + e.localizedMessage, Toast.LENGTH_LONG).show() }
            }
        }
    }

    // Called on the main thread by the installer receiver and the foreground Activity.
    fun showPendingConfirmation(activity: GardensActivity): Boolean {
        val intent = confirmation ?: return false
        confirmation = null
        try {
            activity.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            failConfirmation(activity)
        } catch (_: SecurityException) {
            failConfirmation(activity)
        }
        return true
    }

    private fun failConfirmation(c: Context) {
        val id = prefs(c).getInt("session", -1)
        if (id >= 0) runCatching { c.packageManager.packageInstaller.abandonSession(id) }
        finishInstall(c, false)
    }

    fun onInstallResult(c: Context, id: Int, status: Int, confirm: Intent?) {
        if (id < 0 || id != prefs(c).getInt("session", -1)) return
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            if (confirm == null) {
                failConfirmation(c)
                return
            }
            installing = true
            confirmation = confirm
            GardensActivity.current?.get()?.let(::showPendingConfirmation)
        } else {
            finishInstall(c, status == PackageInstaller.STATUS_SUCCESS)
        }
    }

    private fun finishInstall(c: Context, success: Boolean) {
        prefs(c).edit().remove("session").apply()
        confirmation = null
        installing = false
        if (!success) Toast.makeText(c, "Установка отменена или не удалась", Toast.LENGTH_LONG).show()
    }
}

class ReleaseJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Updates.check(this, false) { _, _ -> jobFinished(params, false) }
        return true
    }
    override fun onStopJob(params: JobParameters) = true
}

class InstallResult : BroadcastReceiver() {
    @Suppress("DEPRECATION")
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        Updates.onInstallResult(context, id, status, intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))
    }
}
