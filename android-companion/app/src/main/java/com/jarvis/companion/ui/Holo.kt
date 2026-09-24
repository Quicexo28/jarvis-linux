package com.jarvis.companion.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * The Jarvis hologram, drawn with plain Canvas calls.
 *
 * It is the same shape as the desktop's `voice-halo` (white-to-cyan core, blue
 * bloom, breathing rings), redrawn here because a home-screen widget cannot run
 * CSS: `RemoteViews` only accepts a bitmap. The very same routine also paints
 * the animated view inside the voice overlay, so the icon the user taps and the
 * thing that answers them are literally the same drawing at different phases.
 *
 * Deliberately free of `BlurMaskFilter`: that one is ignored on a
 * hardware-accelerated canvas, which would make the overlay look flat while the
 * widget looked right. Every glow here is a `RadialGradient`, which behaves the
 * same in both.
 */
enum class HoloState { ONLINE, OFFLINE, LISTENING, THINKING, SPEAKING }

private class Palette(val core: Int, val ring: Int, val glow: Int, val text: Int)

object Holo {

    private fun palette(state: HoloState): Palette = when (state) {
        // Idle/listening/speaking share the cyan identity; only the motion and
        // the caption differ, exactly like the desktop halo.
        HoloState.ONLINE, HoloState.LISTENING, HoloState.SPEAKING ->
            Palette(0xFF66FCFF.toInt(), 0xFF00E5FF.toInt(), 0xFF0059FF.toInt(), 0xFFE6EDF7.toInt())
        // Amber while the brain is thinking — same signal as voice-halo--processing.
        HoloState.THINKING ->
            Palette(0xFFFFF8E1.toInt(), 0xFFFFD700.toInt(), 0xFFFF9800.toInt(), 0xFFFFF8E1.toInt())
        HoloState.OFFLINE ->
            Palette(0xFF8EA0B8.toInt(), 0xFF3C4A5C.toInt(), 0xFF16202D.toInt(), 0xFF5C6B80.toInt())
    }

    private fun alpha(color: Int, a: Float): Int =
        Color.argb((a.coerceIn(0f, 1f) * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))

    /** Bitmap for a widget's ImageView. `label`/`caption` may be null to omit them. */
    fun bitmap(
        wPx: Int, hPx: Int, density: Float, state: HoloState,
        phase: Float = 0f, level: Float = 0f,
        label: String? = "JARVIS", caption: String? = null,
    ): Bitmap {
        val w = wPx.coerceAtLeast(1)
        val h = hPx.coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        draw(Canvas(bmp), w.toFloat(), h.toFloat(), density, state, phase, level, label, caption, card = true)
        return bmp
    }

    /**
     * @param phase 0..1, wraps: rotates the arcs. Advance it over time to animate.
     * @param level 0..1 audio level: swells the core and the bloom.
     * @param card  paint the rounded dark card behind it (widget yes, overlay no).
     */
    fun draw(
        c: Canvas, w: Float, h: Float, density: Float, state: HoloState,
        phase: Float, level: Float, label: String?, caption: String?, card: Boolean,
    ) {
        val p = palette(state)
        val dp = { v: Float -> v * density }
        val lvl = level.coerceIn(0f, 1f)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        if (card) {
            val r = dp(22f)
            paint.shader = LinearGradient(
                0f, 0f, 0f, h,
                intArrayOf(0xFF0E1620.toInt(), 0xFF05070D.toInt()), null, Shader.TileMode.CLAMP,
            )
            c.drawRoundRect(RectF(0f, 0f, w, h), r, r, paint)
            paint.shader = null
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = dp(1f)
            paint.color = 0xFF1B2635.toInt()
            val inset = dp(0.5f)
            c.drawRoundRect(RectF(inset, inset, w - inset, h - inset), r, r, paint)
            paint.style = Paint.Style.FILL
        }

        // Label and caption live at the bottom, so the disc is centred in what
        // is left; otherwise the hologram sits visibly low in a square widget.
        val labelSize = dp(10f)
        val captionSize = dp(9f)
        val textBlock = (if (label != null) labelSize + dp(6f) else 0f) +
            (if (caption != null) captionSize + dp(3f) else 0f)
        val cx = w / 2f
        val cy = (h - textBlock) / 2f + dp(if (card) 2f else 0f)
        val base = min(w, h - textBlock) * 0.5f
        val rCore = base * 0.20f * (1f + lvl * 0.45f)
        val rMid = base * 0.60f
        val rOuter = base * 0.86f
        val turn = phase * 360f

        // Outer bloom: the "hologram is projected into the air" cue.
        paint.shader = RadialGradient(
            cx, cy, rOuter * 1.35f,
            intArrayOf(alpha(p.glow, 0.34f + lvl * 0.22f), alpha(p.glow, 0.10f), Color.TRANSPARENT),
            floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP,
        )
        c.drawCircle(cx, cy, rOuter * 1.35f, paint)
        paint.shader = null

        // Faint dotted horizon ring.
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = dp(1f)
        paint.color = alpha(p.ring, 0.22f)
        paint.pathEffect = DashPathEffect(floatArrayOf(dp(2f), dp(4f)), turn * 0.4f)
        c.drawCircle(cx, cy, rOuter, paint)
        paint.pathEffect = null

        // Radial ticks: 36 marks, every sixth longer. Cheap, and it is what makes
        // the thing read as an instrument instead of a glowing dot.
        paint.strokeWidth = dp(1.2f)
        for (i in 0 until 36) {
            val ang = Math.toRadians((i * 10f + turn * 0.25f).toDouble())
            val long = i % 6 == 0
            val r1 = rMid * 1.18f
            val r2 = r1 + (if (long) dp(5f) else dp(2.5f))
            paint.color = alpha(p.ring, if (long) 0.45f else 0.20f)
            c.drawLine(
                cx + (r1 * cos(ang)).toFloat(), cy + (r1 * sin(ang)).toFloat(),
                cx + (r2 * cos(ang)).toFloat(), cy + (r2 * sin(ang)).toFloat(), paint,
            )
        }

        // Mid ring + the two counter-rotating arcs that carry the motion.
        paint.strokeWidth = dp(1.4f)
        paint.color = alpha(p.ring, 0.30f)
        c.drawCircle(cx, cy, rMid, paint)

        val midBox = RectF(cx - rMid, cy - rMid, cx + rMid, cy + rMid)
        paint.strokeWidth = dp(2.4f)
        paint.strokeCap = Paint.Cap.ROUND
        paint.color = alpha(p.ring, 0.95f)
        c.drawArc(midBox, turn, 84f, false, paint)
        paint.color = alpha(p.ring, 0.45f)
        c.drawArc(midBox, turn + 180f, 40f, false, paint)

        val outBox = RectF(cx - rOuter, cy - rOuter, cx + rOuter, cy + rOuter)
        paint.strokeWidth = dp(1.8f)
        paint.color = alpha(p.core, 0.55f)
        c.drawArc(outBox, -turn * 1.6f, 26f, false, paint)
        paint.color = alpha(p.ring, 0.30f)
        c.drawArc(outBox, -turn * 1.6f + 150f, 60f, false, paint)
        paint.style = Paint.Style.FILL

        // Core: white centre bleeding into the accent, plus its own tight bloom.
        paint.shader = RadialGradient(
            cx, cy, rCore * 2.6f,
            intArrayOf(alpha(p.core, 0.55f), Color.TRANSPARENT), null, Shader.TileMode.CLAMP,
        )
        c.drawCircle(cx, cy, rCore * 2.6f, paint)
        paint.shader = RadialGradient(
            cx - rCore * 0.3f, cy - rCore * 0.3f, rCore * 1.15f,
            intArrayOf(Color.WHITE, p.core, p.ring), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP,
        )
        c.drawCircle(cx, cy, rCore, paint)
        paint.shader = null

        // Scanlines inside the disc — the cheapest "this is a projection" cue.
        paint.color = alpha(p.ring, 0.07f)
        paint.strokeWidth = dp(0.8f)
        paint.style = Paint.Style.STROKE
        c.save()
        c.clipRect(cx - rOuter, cy - rOuter, cx + rOuter, cy + rOuter)
        var y = cy - rOuter
        while (y < cy + rOuter) {
            c.drawLine(cx - rOuter, y, cx + rOuter, y, paint)
            y += dp(4f)
        }
        c.restore()
        paint.style = Paint.Style.FILL

        // Text block.
        var ty = h - dp(if (card) 10f else 2f)
        if (caption != null) {
            paint.color = alpha(p.text, 0.75f)
            paint.textSize = captionSize
            paint.textAlign = Paint.Align.CENTER
            paint.typeface = Typeface.DEFAULT
            paint.letterSpacing = 0.04f
            c.drawText(caption, cx, ty, paint)
            ty -= captionSize + dp(3f)
        }
        if (label != null) {
            paint.color = alpha(p.text, if (state == HoloState.OFFLINE) 0.55f else 0.9f)
            paint.textSize = labelSize
            paint.textAlign = Paint.Align.CENTER
            paint.typeface = Typeface.DEFAULT_BOLD
            paint.letterSpacing = 0.3f
            c.drawText(label, cx, ty, paint)
        }
    }
}
