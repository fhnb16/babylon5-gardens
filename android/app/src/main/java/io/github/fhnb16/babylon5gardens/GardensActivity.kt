package io.github.fhnb16.babylon5gardens

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.Toast
import java.lang.ref.WeakReference

class GardensActivity : Activity() {
    private lateinit var station: StationView
    private var asking = false
    private var waitingForPermission = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        waitingForPermission = state?.getBoolean("waitingForInstallPermission") == true
        val tv = resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK == Configuration.UI_MODE_TYPE_TELEVISION
        if (tv) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        station = StationView(this, tv, false) { finish() }
        setContentView(station)
        Updates.schedule(this)
    }

    override fun onResume() {
        super.onResume()
        current = WeakReference(this)
        station.onResume()
        if (Updates.showPendingConfirmation(this)) return
        if (waitingForPermission) {
            waitingForPermission = false
            if (packageManager.canRequestPackageInstalls()) install()
            return
        }
        checkUpdates(false)
    }

    fun checkUpdates(manual: Boolean) {
        Updates.check(this, manual) { available, message ->
            runOnUiThread {
                if (isFinishing || isDestroyed || current?.get() !== this) return@runOnUiThread
                if (available && !asking && !Updates.installing && (manual || Updates.canOffer(this))) {
                    Updates.deferOffer(this)
                    if (packageManager.canRequestPackageInstalls()) {
                        install()
                    } else {
                        asking = true
                        AlertDialog.Builder(this).setTitle("Обновление готово")
                            .setMessage(message).setPositiveButton("Установить") { _, _ -> install() }
                            .setNegativeButton("Позже", null).setOnDismissListener { asking = false }.show()
                    }
                } else if (manual) {
                    val status = if (Updates.installing) "Установка уже выполняется" else message
                    Toast.makeText(this, status, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun install() {
        if (!packageManager.canRequestPackageInstalls()) {
            waitingForPermission = true
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            } catch (_: ActivityNotFoundException) {
                waitingForPermission = false
                Toast.makeText(this, "Настройки установки недоступны", Toast.LENGTH_LONG).show()
            }
        } else Updates.install(this)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("waitingForInstallPermission", waitingForPermission)
    }

    override fun dispatchKeyEvent(event: KeyEvent) =
        (::station.isInitialized && station.routeKey(event)) || super.dispatchKeyEvent(event)
    override fun onPause() {
        if (current?.get() === this) current = null
        station.onPause()
        super.onPause()
    }
    override fun onDestroy() { station.release(); super.onDestroy() }

    companion object { var current: WeakReference<GardensActivity>? = null }
}
