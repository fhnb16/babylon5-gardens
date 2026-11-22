package io.github.fhnb16.babylon5gardens

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.view.KeyEvent
import android.webkit.*
import androidx.webkit.WebViewAssetLoader

@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
class StationView(context: Context, val tv: Boolean, val dream: Boolean, val leave: () -> Unit) : WebView(context) {
    private val origin = WebViewAssetLoader.DEFAULT_DOMAIN

    init {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        // TV key events reach the local page through the remote input bridge.
        settings.mediaPlaybackRequiresUserGesture = !tv
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                // Renderer preferences reload this entry point with a new query.
                return !request.isForMainFrame || url.scheme != "https" || url.authority != origin ||
                    url.path != "/assets/index.html"
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                return loader.shouldInterceptRequest(request.url)
                    ?: WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), null)
            }
        }
        addJavascriptInterface(object {
            @JavascriptInterface fun close() { post { leave() } }
            @JavascriptInterface fun checkUpdates() {
                post { (context as? GardensActivity)?.checkUpdates(true) }
            }
            @JavascriptInterface fun screenSaverSettings() {
                post {
                    val intent = Intent(Settings.ACTION_DREAM_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (intent.resolveActivity(context.packageManager) != null) context.startActivity(intent)
                }
            }
        }, "GardensAndroid")
        val mode = if (tv) "tv" else "web"
        loadUrl("https://$origin/assets/index.html?mode=$mode&host=" + if (dream) "dream" else "android")
        isFocusableInTouchMode = true
        requestFocus()
    }

    fun routeKey(event: KeyEvent): Boolean {
        val key = when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> "GoBack"
            KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> "Enter"
            KeyEvent.KEYCODE_MENU -> "ContextMenu"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "MediaPlayPause"
            KeyEvent.KEYCODE_CHANNEL_UP -> "ChannelUp"
            KeyEvent.KEYCODE_CHANNEL_DOWN -> "ChannelDown"
            else -> return false
        }
        if (!tv && key != "GoBack") return false
        if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return false
        val type = if (event.action == KeyEvent.ACTION_DOWN) "keydown" else "keyup"
        // A physical event goes through exactly one input route, including OK repeats.
        val repeat = event.repeatCount > 0
        evaluateJavascript("(()=>{if(!window.__b5)return false;window.dispatchEvent(new KeyboardEvent('$type',{key:'$key',repeat:$repeat,cancelable:true}));return true})()") {
            if (it != "true" && key == "GoBack" && type == "keyup") leave()
        }
        return true
    }

    fun release() {
        removeJavascriptInterface("GardensAndroid")
        stopLoading()
        (parent as? android.view.ViewGroup)?.removeView(this)
        destroy()
    }
}
