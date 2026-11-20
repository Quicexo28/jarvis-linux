package com.jarvis.companion.wall

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.opengl.GLSurfaceView
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.Surface
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextClock
import android.widget.TextView
import android.widget.Toast
import com.jarvis.companion.Config
import com.jarvis.companion.SetupActivity
import org.json.JSONObject
import java.nio.ByteBuffer

/**
 * La pared: decoder HW + warp en GPU. v3: todo lo que se ve es un stream del
 * portátil (su navegador de la pared, o un cast). Sin stream enseña «PC no
 * disponible» con Reintentar, las apps nativas del proyector (respaldo
 * manual, ya no el inicio) y el launcher de fábrica.
 *
 * Sin WebView a propósito: el HA109 tiene 986 MB.
 */
class WallActivity : Activity(), WallHub.Listener {

    companion object {
        private const val TAG = "WallActivity"
        private const val STATS_MS = 5000L
        /** Viene del trampolín HOME (tecla HOME del mando o arranque). */
        const val EXTRA_FROM_HOME = "fromHome"

        private const val ORIGINAL_LAUNCHER = "@launcher-original"

        /** Sin stream este rato = pantalla «PC no disponible» (no parpadea en un cambio de fuente). */
        private const val STATUS_DELAY_MS = 2000L

        /** Lo miran el servicio y la accesibilidad: ¿la pared está delante? */
        @Volatile var resumed = false
            private set
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var glView: GLSurfaceView
    private lateinit var renderer: WallRenderer
    private lateinit var home: FrameLayout
    private lateinit var apps: FrameLayout
    private lateinit var grid: GridLayout
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var retry: View
    private var surface: Surface? = null
    @Volatile private var decoder: VideoDecoder? = null
    private var stream: WallHub.Stream? = null
    private var calibration = false
    private var favorites: List<String> = emptyList()
    private var tilesKey = ""
    private var lastRendered = 0L
    private var lastStatsAt = 0L

    private val sink = WallHub.VideoSink { au: ByteBuffer, key, _, pts -> decoder?.offer(au, key, pts) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Lo primero, antes de GL o red: si esta instancia muere, la próxima
        // vez el trampolín HOME lo cuenta como crash.
        WallHome.noteUncleanExit(this)
        if (!Config.wallMode(this)) {
            Toast.makeText(this, "Modo pared desactivado (Ajustes de Jarvis)", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }

        renderer = WallRenderer { s -> main.post { onSurfaceReady(s) } }
        glView = GLSurfaceView(this).apply {
            setEGLContextClientVersion(3)
            setEGLConfigChooser(8, 8, 8, 8, 0, 0)
            preserveEGLContextOnPause = true
            setRenderer(renderer)
            renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
        }
        renderer.view = glView

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(glView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        home = buildHome()
        root.addView(home, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        apps = buildApps()
        root.addView(apps, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setContentView(root)

        main.postDelayed(stable, WallHome.STABLE_MS)
    }

    // 60 s viva = no hay bucle de crashes: se resetea el contador.
    private val stable = Runnable { WallHome.markStable(this) }

    // La conexión al PC vive solo mientras la pared está a la vista: al volver
    // al inicio el servicio para y wall-server se apaga solo.
    override fun onStart() {
        super.onStart()
        WallHome.onWallStart(this)
        WallService.start(this)
    }

    override fun onStop() {
        WallHome.onWallStop(this)
        WallService.stop(this)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // HOME del mando con un cast delante: igual que el botón de inicio,
        // corta el cast (el server lo decide y manda streamStop).
        if (intent.getBooleanExtra(EXTRA_FROM_HOME, false)) {
            if (stream != null) WallHub.send(JSONObject().put("t", "key").put("key", "HOME"))
            else { showApps(false); retry.requestFocus() }
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        hideSystemBars()
        glView.onResume()
        WallHub.videoSink = sink
        WallHub.listener = this
        WallService.reportForeground(null)
        refreshTiles(force = false)
        main.postDelayed(statsTick, STATS_MS)
        // onPause soltó el decoder; con el contexto EGL conservado no llega
        // onSurfaceCreated, así que nadie lo recrearía (la pared se quedaba
        // congelada tras un `home` con el stream en marcha).
        ensureDecoder()
    }

    override fun onPause() {
        resumed = false
        main.removeCallbacks(statsTick)
        main.removeCallbacks(showStatus)
        WallHub.videoSink = null
        WallHub.listener = null
        // Sin la pared delante no se decodifica nada: el HW y la RAM son
        // para la app que esté en primer plano.
        releaseDecoder()
        glView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        main.removeCallbacks(stable)
        WallHome.onWallDestroy()
        if (::renderer.isInitialized) renderer.release()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ------------------------------------------------------------ stream

    private fun onSurfaceReady(s: Surface) {
        // Un contexto GL nuevo invalida el SurfaceTexture viejo: el decoder
        // pintaba en una superficie muerta.
        surface?.release()
        surface = s
        releaseDecoder()
        ensureDecoder()
    }

    private fun ensureDecoder() {
        val s = stream ?: return
        val surf = surface ?: return
        if (!resumed) return
        val d = decoder
        if (d != null && d.width == s.width && d.height == s.height) return
        releaseDecoder()
        decoder = VideoDecoder(surf, s.width, s.height)
        lastRendered = 0
        lastStatsAt = SystemClock.elapsedRealtime()
        // Pide al server el `stream` + el GOP en curso: arranca ya, sin
        // esperar al siguiente keyframe.
        WallHub.send(JSONObject().put("t", "resync"))
    }

    private fun releaseDecoder() {
        decoder?.release()
        decoder = null
    }

    override fun onStream(stream: WallHub.Stream?) {
        val changed = this.stream != stream
        this.stream = stream
        if (stream == null) {
            releaseDecoder()
            glView.queueEvent { renderer.setStream(0, 0) }
        } else if (changed) {
            glView.queueEvent { renderer.setStream(stream.width, stream.height) }
            ensureDecoder()
        }
        glView.requestRender()
        updateHomeVisibility()
    }

    override fun onConfig(warp: WallHub.Warp, calibration: Boolean, favorites: List<String>) {
        this.calibration = calibration
        glView.queueEvent {
            renderer.setWarp(warp)
            renderer.setCalibration(calibration)
        }
        glView.requestRender()
        if (favorites != this.favorites) {
            this.favorites = favorites
            refreshTiles(force = true)
        }
        updateHomeVisibility()
    }

    private var connected = false

    override fun onConnection(connected: Boolean) {
        this.connected = connected
        val host = Config.wallUrl(this).substringAfter("//").substringBefore("/")
        title.text = if (connected) "Esperando imagen del PC" else "PC no disponible"
        status.text = if (connected) "Conectada a $host, pero no llega stream. Reintentar vuelve al navegador de la pared."
        else "Buscando wall-server en $host… (se reintenta solo)"
    }

    override fun onHome() {
        showApps(false)
        updateHomeVisibility()
        if (stream == null) retry.requestFocus()
    }

    override fun onCalibrationPattern(pattern: String) {
        glView.queueEvent { renderer.setPattern(pattern) }
        glView.requestRender()
    }

    /**
     * Puntero virtual (v3). Con `avDelayMs` la imagen llega tarde a propósito:
     * el cursor se retrasa lo mismo para no adelantarse a lo que señala.
     */
    override fun onCursor(cursor: WallHub.Cursor) {
        val apply = Runnable {
            glView.queueEvent { renderer.setCursor(cursor) }
            glView.requestRender()
        }
        val d = WallHub.avDelayMs
        if (d > 0) main.postDelayed(apply, d.toLong()) else apply.run()
    }

    /** Sin accesibilidad: el mosaico se maneja con las teclas de la API. */
    override fun onKey(key: String): Boolean {
        if (stream != null) return false
        val code = when (key) {
            "UP" -> KeyEvent.KEYCODE_DPAD_UP
            "DOWN" -> KeyEvent.KEYCODE_DPAD_DOWN
            "LEFT" -> KeyEvent.KEYCODE_DPAD_LEFT
            "RIGHT" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "OK" -> KeyEvent.KEYCODE_DPAD_CENTER
            else -> return false
        }
        val t = SystemClock.uptimeMillis()
        dispatchKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0))
        dispatchKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0))
        return true
    }

    private val showStatus = Runnable {
        if (stream != null || calibration) return@Runnable
        home.visibility = View.VISIBLE
        if (apps.visibility != View.VISIBLE && currentFocus == null) retry.requestFocus()
    }

    private fun updateHomeVisibility() {
        // Con calibración se ve la grilla sobre negro: es para cuadrar la
        // superficie, la pantalla de estado estorbaría.
        val show = stream == null && !calibration
        main.removeCallbacks(showStatus)
        if (show) main.postDelayed(showStatus, STATUS_DELAY_MS)
        else { home.visibility = View.GONE; showApps(false) }
    }

    /** Mosaico de apps nativas: respaldo manual, encima de la pantalla de estado. */
    private fun showApps(on: Boolean) {
        if (!::apps.isInitialized) return
        apps.visibility = if (on) View.VISIBLE else View.GONE
        if (on) { refreshTiles(force = false); grid.getChildAt(0)?.requestFocus() }
    }

    private val statsTick = object : Runnable {
        override fun run() {
            val d = decoder
            if (d != null) {
                val now = SystemClock.elapsedRealtime()
                val frames = d.rendered - lastRendered
                val fps = frames * 1000.0 / (now - lastStatsAt).coerceAtLeast(1)
                lastRendered = d.rendered
                lastStatsAt = now
                val decodeMs = d.takeDecodeMs()
                WallHub.send(JSONObject().put("t", "stats")
                    .put("fps", Math.round(fps * 10) / 10.0)
                    .put("decodeMs", Math.round(decodeMs * 10) / 10.0)
                    .put("dropped", d.dropped))
            }
            main.postDelayed(this, STATS_MS)
        }
    }

    // ----------------------------------------------------------- mando físico

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (stream != null) {
            // Cast en curso: el mando maneja la ventana emitida (flechas,
            // Return, Escape) y el volumen/media del PC. MENU corta el cast.
            val key = when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_UP -> "UP"
                KeyEvent.KEYCODE_DPAD_DOWN -> "DOWN"
                KeyEvent.KEYCODE_DPAD_LEFT -> "LEFT"
                KeyEvent.KEYCODE_DPAD_RIGHT -> "RIGHT"
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "OK"
                KeyEvent.KEYCODE_BACK -> "BACK"
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "PLAY_PAUSE"
                KeyEvent.KEYCODE_MEDIA_NEXT -> "NEXT"
                KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "PREV"
                KeyEvent.KEYCODE_VOLUME_UP -> "VOL_UP"
                KeyEvent.KEYCODE_VOLUME_DOWN -> "VOL_DOWN"
                KeyEvent.KEYCODE_VOLUME_MUTE -> "MUTE"
                KeyEvent.KEYCODE_MENU -> "HOME"
                else -> null
            }
            if (key != null) {
                if (event.action == KeyEvent.ACTION_DOWN) WallHub.send(JSONObject().put("t", "key").put("key", key))
                return true
            }
            return super.dispatchKeyEvent(event)
        }
        when (event.keyCode) {
            // ATRÁS cierra el mosaico; nunca saca de la pared (dejaría el
            // launcher de fábrica en la pared): para eso está su botón.
            KeyEvent.KEYCODE_BACK -> {
                if (event.action == KeyEvent.ACTION_UP && apps.visibility == View.VISIBLE) { showApps(false); retry.requestFocus() }
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                if (event.action == KeyEvent.ACTION_UP) startActivity(Intent(this, SetupActivity::class.java))
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    // ---------------------------------------------------------- pantalla inicio

    private fun px(dp: Float) = (dp * resources.displayMetrics.density).toInt()

    private fun buildHome(): FrameLayout {
        val f = FrameLayout(this)
        f.background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(Color.rgb(10, 14, 22), Color.rgb(4, 6, 10)))
        f.visibility = View.GONE

        val clockBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(40f), px(28f), px(40f), 0)
        }
        clockBox.addView(TextClock(this).apply {
            format24Hour = "HH:mm"
            format12Hour = "HH:mm"
            textSize = 40f
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
        })
        clockBox.addView(TextClock(this).apply {
            format24Hour = "EEEE d 'de' MMMM"
            format12Hour = "EEEE d 'de' MMMM"
            textSize = 15f
            setTextColor(Color.rgb(150, 165, 185))
        })
        f.addView(clockBox, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START))

        val center = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        title = TextView(this).apply {
            text = "PC no disponible"
            textSize = 34f
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
            gravity = Gravity.CENTER
        }
        center.addView(title)
        status = TextView(this).apply {
            textSize = 15f
            setTextColor(Color.rgb(140, 155, 175))
            gravity = Gravity.CENTER
            setPadding(px(40f), px(10f), px(40f), px(30f))
            text = "Buscando wall-server…"
        }
        center.addView(status, LinearLayout.LayoutParams(px(720f), WRAP_CONTENT))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        retry = button("Reintentar") { WallService.retryNow() }
        row.addView(retry)
        row.addView(button("Apps del proyector") { showApps(true) })
        WallHome.originalLauncher(this)?.let {
            row.addView(button("Launcher original") {
                if (!WallHome.launchOriginal(this, "pared sin PC")) Toast.makeText(this, "No se pudo abrir el launcher original", Toast.LENGTH_SHORT).show()
            })
        }
        center.addView(row)
        f.addView(center, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER))
        return f
    }

    /** Botón grande para el mando: foco = borde blanco. */
    private fun button(label: String, onClick: () -> Unit): View {
        val bg = GradientDrawable().apply { cornerRadius = px(12f).toFloat(); setColor(Color.rgb(24, 31, 43)) }
        return TextView(this).apply {
            text = label
            textSize = 17f
            setTextColor(Color.rgb(200, 210, 225))
            gravity = Gravity.CENTER
            background = bg
            isFocusable = true
            isFocusableInTouchMode = true
            setPadding(px(26f), px(16f), px(26f), px(16f))
            layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { setMargins(px(10f), 0, px(10f), 0) }
            setOnFocusChangeListener { v, has ->
                v.animate().scaleX(if (has) 1.06f else 1f).scaleY(if (has) 1.06f else 1f).setDuration(120).start()
                bg.setStroke(if (has) px(3f) else 0, Color.WHITE)
                setTextColor(if (has) Color.WHITE else Color.rgb(200, 210, 225))
            }
            setOnClickListener { onClick() }
        }
    }

    /** Respaldo de emergencia: las apps nativas del proyector. ATRÁS vuelve. */
    private fun buildApps(): FrameLayout {
        val f = FrameLayout(this)
        f.setBackgroundColor(Color.rgb(6, 9, 14))
        f.visibility = View.GONE
        f.addView(TextView(this).apply {
            text = "Apps del proyector (respaldo) · ATRÁS para volver"
            textSize = 16f
            setTextColor(Color.rgb(150, 165, 185))
            setPadding(px(40f), px(28f), px(40f), 0)
        }, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START))
        grid = GridLayout(this).apply {
            columnCount = 4
            clipChildren = false
            clipToPadding = false
            setPadding(px(20f), px(20f), px(20f), px(20f))
        }
        f.addView(grid, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.CENTER).apply { topMargin = px(40f) })
        return f
    }

    /** Favoritas (orden del server) primero, el resto por nombre. */
    private fun refreshTiles(force: Boolean) {
        val apps = AppCatalog.list(this)
        val ordered = apps.sortedWith(compareBy({ favorites.indexOf(it.pkg).let { i -> if (i < 0) Int.MAX_VALUE else i } }, { it.label.lowercase() }))
        val key = ordered.joinToString(",") { it.pkg }
        if (!force && key == tilesKey) return
        tilesKey = key
        val focused = (currentFocus?.tag as? String)
        grid.removeAllViews()
        val tileW = px(150f); val tileH = px(84f)
        for (app in ordered) grid.addView(tile(app, tileW, tileH))
        // Salida manual al launcher de fábrica (la pared es el HOME): sin
        // esto no habría forma de llegar a sus ajustes desde el mando.
        WallHome.originalLauncher(this)?.let { cn ->
            grid.addView(tile(AppCatalog.App(ORIGINAL_LAUNCHER, "Launcher original"), tileW, tileH, cn.packageName))
        }
        if (this.apps.visibility == View.VISIBLE) {
            val again = (0 until grid.childCount).map { grid.getChildAt(it) }.firstOrNull { it.tag == focused }
            (again ?: grid.getChildAt(0))?.requestFocus()
        }
    }

    private fun tile(app: AppCatalog.App, w: Int, h: Int, iconPkg: String = app.pkg): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isFocusable = true
            isFocusableInTouchMode = true
            tag = app.pkg
            setPadding(px(6f), px(6f), px(6f), px(6f))
        }
        val bg = GradientDrawable().apply { cornerRadius = px(10f).toFloat(); setColor(Color.rgb(22, 28, 38)) }
        val img = ImageView(this).apply {
            setImageDrawable(AppCatalog.tileDrawable(this@WallActivity, iconPkg))
            scaleType = ImageView.ScaleType.FIT_CENTER
            background = bg
            setPadding(px(8f), px(8f), px(8f), px(8f))
        }
        box.addView(img, LinearLayout.LayoutParams(w, h))
        val label = TextView(this).apply {
            text = app.label
            textSize = 13f
            setTextColor(Color.rgb(170, 180, 195))
            gravity = Gravity.CENTER
            maxLines = 1
            setPadding(0, px(6f), 0, 0)
        }
        box.addView(label, LinearLayout.LayoutParams(w, WRAP_CONTENT))
        box.setOnFocusChangeListener { v, has ->
            v.animate().scaleX(if (has) 1.1f else 1f).scaleY(if (has) 1.1f else 1f).setDuration(120).start()
            bg.setStroke(if (has) px(3f) else 0, Color.WHITE)
            label.setTextColor(if (has) Color.WHITE else Color.rgb(170, 180, 195))
        }
        box.setOnClickListener {
            Log.i(TAG, "abrir ${app.pkg}")
            val ok = if (app.pkg == ORIGINAL_LAUNCHER) WallHome.launchOriginal(this, "mosaico") else AppCatalog.launch(this, app.pkg)
            if (!ok) Toast.makeText(this, "No se pudo abrir ${app.label}", Toast.LENGTH_SHORT).show()
        }
        val lp = GridLayout.LayoutParams().apply { setMargins(px(12f), px(12f), px(12f), px(12f)) }
        box.layoutParams = lp
        return box
    }
}
