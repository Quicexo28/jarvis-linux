package com.jarvis.companion.voice

import android.content.Context
import android.graphics.Canvas
import android.view.View
import com.jarvis.companion.ui.Holo
import com.jarvis.companion.ui.HoloState

/**
 * The hologram, animated. Same [Holo] routine the 2x2 widget bakes into a
 * bitmap — here it is redrawn every frame with an advancing phase and the live
 * audio level, so the tile the user taps grows into the thing that listens.
 *
 * Rotation speed carries the state: barely moving when idle, quick while the
 * brain works. The level is smoothed on the way in, because raw mic RMS jitters
 * hard enough to look like a fault.
 */
class HoloView(ctx: Context) : View(ctx) {

    var state: HoloState = HoloState.LISTENING
        set(value) {
            field = value
            invalidate()
        }

    /**
     * 0..1. Set from mic RMS while listening, from PCM amplitude while speaking —
     * the latter arrives on the audio thread, hence the volatile.
     */
    fun setLevel(v: Float) {
        levelTarget = v.coerceIn(0f, 1f)
    }

    @Volatile private var levelTarget = 0f
    private var level = 0f
    private var phase = 0f
    private var lastFrame = 0L

    private fun revsPerSecond(): Float = when (state) {
        HoloState.THINKING -> 0.5f
        HoloState.SPEAKING -> 0.34f
        HoloState.LISTENING -> 0.22f
        else -> 0.07f
    }

    override fun onDraw(canvas: Canvas) {
        val now = System.nanoTime()
        val dt = if (lastFrame == 0L) 0f else ((now - lastFrame) / 1_000_000_000.0).toFloat()
        lastFrame = now

        phase = (phase + revsPerSecond() * dt) % 1f
        // Rise fast, fall slow: a voice peak should show immediately, but the
        // core should not flicker off between syllables.
        val k = if (levelTarget > level) 0.35f else 0.12f
        level += (levelTarget - level) * k

        Holo.draw(
            canvas, width.toFloat(), height.toFloat(),
            resources.displayMetrics.density, state, phase, level,
            label = null, caption = null, card = false,
        )
        if (isAttachedToWindow) postInvalidateOnAnimation()
    }

    override fun onDetachedFromWindow() {
        lastFrame = 0L
        super.onDetachedFromWindow()
    }
}
