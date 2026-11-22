package io.github.fhnb16.babylon5gardens

import android.service.dreams.DreamService
import android.view.KeyEvent

class GardensDream : DreamService() {
    private var station: StationView? = null

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        isInteractive = true
        isFullscreen = true
        isScreenBright = true
        station = StationView(this, true, true) { finish() }
        setContentView(station!!)
        Updates.schedule(this)
    }

    override fun dispatchKeyEvent(event: KeyEvent) =
        station?.routeKey(event) == true || super.dispatchKeyEvent(event)

    override fun onDetachedFromWindow() {
        station?.release()
        station = null
        super.onDetachedFromWindow()
    }
}
