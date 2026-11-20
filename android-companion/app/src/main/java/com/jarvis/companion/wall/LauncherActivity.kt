package com.jarvis.companion.wall

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextClock
import android.widget.TextView
import android.widget.Toast

/**
 * Inicio del proyector: reloj, apps favoritas y el acceso «Monitor».
 *
 * Solo vistas normales de Android: sin GL, sin vídeo y sin red, para que abra
 * al instante. La pared (WallActivity) solo arranca al tocar «Monitor».
 * Medidas en «px de panel» (1280x720 = 1.0); `u` las escala a otras pantallas.
 */
class LauncherActivity : Activity() {

    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var u = 1f
    private lateinit var row: LinearLayout
    private var rowKey = ""

    private val stable = Runnable { WallHome.markStable(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WallHome.noteUncleanExit(this)
        try {
            val m = resources.displayMetrics
            u = minOf(m.widthPixels, m.heightPixels) / 720f
            setContentView(buildUi())
        } catch (e: Throwable) {
            Log.e(TAG, "no se pudo construir el inicio: ${e.message}")
            WallHome.launchOriginal(this, "excepción en el inicio")
            finish()
            return
        }
        // Por si el boot no avisó a la app (p. ej. quedó «detenida»): el inicio asegura el keystone.
        runCatching { KeystoneService.start(this) }
        main.postDelayed(stable, WallHome.STABLE_MS)
    }

    override fun onStart() {
        super.onStart()
        WallHome.onWallStart(this)
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        refreshRow()
    }

    override fun onStop() {
        WallHome.onWallStop(this)
        super.onStop()
    }

    override fun onDestroy() {
        main.removeCallbacks(stable)
        WallHome.onWallDestroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    private fun px(v: Float) = (v * u).toInt()

    private fun buildUi(): View {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(6, 9, 14)) }

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(64f), px(48f), px(64f), 0)
        }
        top.addView(TextClock(this).apply {
            format12Hour = "h:mm"
            format24Hour = "HH:mm"
            setTextSize(TypedValue.COMPLEX_UNIT_PX, 120f * u)
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
        })
        top.addView(TextClock(this).apply {
            format12Hour = "EEEE d 'de' MMMM"
            format24Hour = "EEEE d 'de' MMMM"
            setTextSize(TypedValue.COMPLEX_UNIT_PX, 32f * u)
            setTextColor(Color.rgb(150, 165, 185))
        })
        root.addView(top, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START))

        row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            clipChildren = false
            clipToPadding = false
            setPadding(px(52f), px(24f), px(52f), px(24f))
        }
        val scroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            clipChildren = false
            clipToPadding = false
            addView(row, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
        root.addView(scroll, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply { bottomMargin = px(72f) })
        return root
    }

    /** YouTube y Netflix primero, luego el resto por nombre, «Monitor» al final. */
    private fun refreshRow() {
        val apps = AppCatalog.list(this).sortedWith(
            compareBy({ rank(it.pkg) }, { it.label.lowercase() })
        )
        val key = apps.joinToString(",") { it.pkg }
        if (key == rowKey) return
        rowKey = key
        val focused = currentFocus?.tag as? String
        row.removeAllViews()
        for (app in apps) row.addView(card(app.pkg, app.label, AppCatalog.tileDrawable(this, app.pkg)) {
            if (!AppCatalog.launch(this, app.pkg)) Toast.makeText(this, "No se pudo abrir ${app.label}", Toast.LENGTH_SHORT).show()
        })
        row.addView(card(MONITOR, "Monitor", null) {
            startActivity(Intent(this, WallActivity::class.java))
        })
        val again = (0 until row.childCount).map { row.getChildAt(it) }.firstOrNull { it.tag == focused }
        (again ?: row.getChildAt(0))?.requestFocus()
    }

    private fun rank(pkg: String) = when {
        pkg.contains("youtube", true) -> 0
        pkg.contains("netflix", true) -> 1
        else -> 2
    }

    private fun card(tag: String, label: String, art: android.graphics.drawable.Drawable?, onClick: () -> Unit): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isFocusable = true
            isFocusableInTouchMode = true
            this.tag = tag
            setPadding(px(10f), px(10f), px(10f), px(10f))
            layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { setMargins(px(12f), 0, px(12f), 0) }
        }
        val bg = GradientDrawable().apply {
            cornerRadius = px(18f).toFloat()
            setColor(if (art == null) Color.rgb(32, 74, 140) else Color.rgb(22, 28, 38))
        }
        val w = px(272f); val h = px(153f)
        val face: View = if (art != null) ImageView(this).apply {
            setImageDrawable(art)
            scaleType = ImageView.ScaleType.FIT_CENTER
            setPadding(px(12f), px(12f), px(12f), px(12f))
            background = bg
        } else TextView(this).apply {
            text = "▭"
            setTextSize(TypedValue.COMPLEX_UNIT_PX, 72f * u)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = bg
        }
        box.addView(face, LinearLayout.LayoutParams(w, h))
        val name = TextView(this).apply {
            text = label
            setTextSize(TypedValue.COMPLEX_UNIT_PX, 28f * u)
            setTextColor(Color.rgb(170, 180, 195))
            gravity = Gravity.CENTER
            maxLines = 1
            setPadding(0, px(12f), 0, 0)
        }
        box.addView(name, LinearLayout.LayoutParams(w, WRAP_CONTENT))
        box.setOnFocusChangeListener { v, has ->
            v.animate().scaleX(if (has) 1.1f else 1f).scaleY(if (has) 1.1f else 1f).setDuration(120).start()
            bg.setStroke(if (has) px(4f) else 0, Color.WHITE)
            name.setTextColor(if (has) Color.WHITE else Color.rgb(170, 180, 195))
        }
        box.setOnClickListener { onClick() }
        return box
    }

    /** Ya estamos en el inicio: ATRÁS no hace nada. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) return true
        return super.onKeyDown(keyCode, event)
    }

    companion object {
        private const val TAG = "WallLauncher"
        private const val MONITOR = "monitor"
    }
}
