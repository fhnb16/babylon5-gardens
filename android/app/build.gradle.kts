plugins { id("com.android.application") }

val webRoot = rootDir.parentFile
val sourceVersion = file("$webRoot/js/version.js")
val gameVersion = Regex("""export const VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'""")
    .find(sourceVersion.readText())!!.groupValues[1]
val parts = gameVersion.split(".").map(String::toInt)
require(parts[1] < 1000 && parts[2] < 1000)
val keystorePath = providers.environmentVariable("ANDROID_KEYSTORE_PATH")

android {
    namespace = "io.github.fhnb16.babylon5gardens"
    compileSdk = 34
    defaultConfig {
        applicationId = "io.github.fhnb16.babylon5gardens"
        minSdk = 28
        targetSdk = 34
        versionName = gameVersion
        versionCode = parts[0] * 1000000 + parts[1] * 1000 + parts[2]
    }
    if (keystorePath.isPresent) {
        signingConfigs.create("distribution") {
            storeFile = file(keystorePath.get())
            storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").get()
            keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").get()
            keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").get()
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("distribution")
    }
    buildTypes.getByName("debug").applicationIdSuffix = ".debug"
}

androidComponents.onVariants { variant ->
    variant.sources.assets?.addStaticSourceDirectory(webRoot.resolve("dist").absolutePath)
}
tasks.named("preBuild") {
    doFirst { require(webRoot.resolve("dist/index.html").isFile) { "Run npm run build before assembling the APK" } }
}

dependencies { implementation("androidx.webkit:webkit:1.9.0") }
