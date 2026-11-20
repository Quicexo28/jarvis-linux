package com.jarvis.companion.wall

import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer

/**
 * Bus en proceso entre [WallService] (dueño del WebSocket, vive aunque Netflix
 * esté delante) y [WallActivity] (decoder + GL, solo existe mientras se ve).
 *
 * Los frames de vídeo van directos del hilo de OkHttp al decoder: pasar por el
 * hilo principal sumaría un salto de cola por frame.
 */
object WallHub {

    /**
     * Malla residual (Mapping v2): cols×rows desplazamientos normalizados al
     * panel, fila a fila desde arriba-izquierda (índice = fila·cols + col),
     * sumados al punto H(col/(cols−1), fila/(rows−1)) del quad resuelto.
     */
    class Mesh(val cols: Int, val rows: Int, val offsets: FloatArray) {
        val isZero get() = offsets.all { kotlin.math.abs(it) < 1e-6f }
    }

    /** Warp del contrato (PROTOCOL.md), ya parseado. */
    data class Warp(
        val shape: Boolean,
        val rx: Float, val ry: Float, val rw: Float, val rh: Float,
        /** TL, TR, BR, BL normalizados al panel (entrada manual de v1). */
        val corners: FloatArray,
        /**
         * v2: quad resuelto por el server (perspectiva + zoom/shift), TL,TR,BR,BL.
         * null con un server v1: entonces vale rect/corners.
         */
        val resolved: FloatArray? = null,
        /** v2: bbox del quad resuelto (x,y,w,h normalizados). */
        val resolvedBBox: FloatArray? = null,
        val mesh: Mesh? = null,
    ) {
        /** Quad que manda: el resuelto si lo hay. */
        fun quad(): FloatArray = resolved ?: if (shape) corners else floatArrayOf(rx, ry, rx + rw, ry, rx + rw, ry + rh, rx, ry + rh)

        /** Rect efectivo en modo pantalla (con zoom/shift ya aplicados). */
        fun screenRect(): FloatArray = resolvedBBox ?: floatArrayOf(rx, ry, rw, rh)

        val isIdentity get() = quad().let { q ->
            val id = floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 1f)
            q.indices.all { kotlin.math.abs(q[it] - id[it]) < 1e-4f }
        }

        companion object {
            val DEFAULT = Warp(false, 0f, 0f, 1f, 1f, floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 1f))

            private fun quadOf(a: JSONArray?): FloatArray? {
                if (a == null || a.length() != 4) return null
                val q = FloatArray(8)
                for (i in 0 until 4) {
                    val p = a.optJSONArray(i) ?: return null
                    q[i * 2] = p.optDouble(0, Double.NaN).toFloat()
                    q[i * 2 + 1] = p.optDouble(1, Double.NaN).toFloat()
                }
                return if (q.any { it.isNaN() }) null else q
            }

            private fun meshOf(o: JSONObject?): Mesh? {
                if (o == null) return null
                val cols = o.optInt("cols"); val rows = o.optInt("rows")
                val off = o.optJSONArray("offsets") ?: return null
                if (cols !in listOf(3, 5) || rows !in listOf(3, 5) || off.length() != cols * rows) return null
                val f = FloatArray(cols * rows * 2)
                for (i in 0 until cols * rows) {
                    val d = off.optJSONArray(i) ?: return null
                    f[i * 2] = d.optDouble(0, 0.0).toFloat(); f[i * 2 + 1] = d.optDouble(1, 0.0).toFloat()
                }
                return Mesh(cols, rows, f)
            }

            fun parse(o: JSONObject?): Warp {
                if (o == null) return DEFAULT
                val r = o.optJSONObject("rect")
                val c = o.optJSONArray("corners")
                val corners = FloatArray(8)
                for (i in 0 until 4) {
                    val p = c?.optJSONArray(i)
                    corners[i * 2] = (p?.optDouble(0, DEFAULT.corners[i * 2].toDouble()) ?: DEFAULT.corners[i * 2].toDouble()).toFloat()
                    corners[i * 2 + 1] = (p?.optDouble(1, DEFAULT.corners[i * 2 + 1].toDouble()) ?: DEFAULT.corners[i * 2 + 1].toDouble()).toFloat()
                }
                val res = o.optJSONObject("resolved")
                val bb = res?.optJSONObject("bbox")
                return Warp(
                    shape = o.optString("mode") == "shape",
                    rx = r?.optDouble("x", 0.0)?.toFloat() ?: 0f,
                    ry = r?.optDouble("y", 0.0)?.toFloat() ?: 0f,
                    rw = r?.optDouble("w", 1.0)?.toFloat() ?: 1f,
                    rh = r?.optDouble("h", 1.0)?.toFloat() ?: 1f,
                    corners = corners,
                    resolved = quadOf(res?.optJSONArray("corners")),
                    resolvedBBox = bb?.let { floatArrayOf(it.optDouble("x").toFloat(), it.optDouble("y").toFloat(), it.optDouble("w").toFloat(), it.optDouble("h").toFloat()) }
                        ?.takeIf { a -> a.none { it.isNaN() } },
                    mesh = if (o.isNull("mesh")) null else meshOf(o.optJSONObject("mesh")),
                )
            }
        }
    }

    data class Stream(val codec: String, val width: Int, val height: Int)

    /** v3: puntero virtual del navegador de la pared, normalizado al stream. */
    data class Cursor(val x: Float, val y: Float, val visible: Boolean)

    interface Listener {
        fun onConnection(connected: Boolean) {}
        fun onConfig(warp: Warp, calibration: Boolean, favorites: List<String>) {}
        /** Patrón de calibración (v2): grid|cross|text|edges. */
        fun onCalibrationPattern(pattern: String) {}
        fun onStream(stream: Stream?) {}
        /** v3: el puntero virtual (la pared lo pinta encima del stream). */
        fun onCursor(cursor: Cursor) {}
        fun onHome() {}
        /** Tecla de la API cuando no hay accesibilidad: la maneja la propia pantalla. */
        fun onKey(key: String): Boolean = false
    }

    fun interface VideoSink {
        /** Llamado en el hilo del WebSocket. [au] solo es válido durante la llamada. */
        fun onFrame(au: ByteBuffer, key: Boolean, params: Boolean, ptsUs: Long)
    }

    private val main = Handler(Looper.getMainLooper())

    @Volatile var connected = false
        private set
    @Volatile var warp: Warp = Warp.DEFAULT
        private set
    @Volatile var calibration = false
        private set
    @Volatile var favorites: List<String> = emptyList()
        private set
    @Volatile var stream: Stream? = null
        private set
    @Volatile var calibrationPattern: String = "grid"
        private set
    @Volatile var cursor = Cursor(0.5f, 0.5f, false)
        private set
    /** v3: retraso de presentación para casar con el audio del PC (0..500 ms). Lo lee el decoder. */
    @Volatile var avDelayMs = 0
        private set

    @Volatile var listener: Listener? = null
        set(value) {
            field = value
            // Quien se engancha tarde (la activity se crea después del `stream`)
            // recibe el estado actual en el acto.
            if (value != null) main.post {
                value.onConnection(connected)
                value.onCalibrationPattern(calibrationPattern)
                value.onConfig(warp, calibration, favorites)
                value.onStream(stream)
                value.onCursor(cursor)
            }
        }
    @Volatile var videoSink: VideoSink? = null

    /** Lo pone [WallService]; devuelve false si no hay conexión. */
    @Volatile var sender: ((JSONObject) -> Boolean)? = null

    fun send(o: JSONObject): Boolean = sender?.invoke(o) ?: false

    internal fun setConnected(c: Boolean) {
        connected = c
        if (!c) { stream = null; cursor = cursor.copy(visible = false) }
        val cur = cursor
        main.post {
            listener?.onConnection(c)
            if (!c) { listener?.onStream(null); listener?.onCursor(cur) }
        }
    }

    internal fun setConfig(o: JSONObject) {
        warp = Warp.parse(o.optJSONObject("warp"))
        // v1: booleano; v2: {on, pattern}.
        val cal = o.optJSONObject("calibration")
        calibration = cal?.optBoolean("on", false) ?: o.optBoolean("calibration", false)
        calibrationPattern = cal?.optString("pattern", "grid")?.takeIf { it in listOf("grid", "cross", "text", "edges") } ?: "grid"
        val pat = calibrationPattern
        main.post { listener?.onCalibrationPattern(pat) }
        val fav = o.optJSONArray("favorites") ?: JSONArray()
        favorites = (0 until fav.length()).map { fav.optString(it) }.filter { it.isNotEmpty() }
        val w = warp; val c = calibration; val f = favorites
        main.post { listener?.onConfig(w, c, f) }
    }

    internal fun setStream(s: Stream?) {
        stream = s
        main.post { listener?.onStream(s) }
    }

    internal fun home() = main.post { listener?.onHome() }

    internal fun setCursor(c: Cursor) {
        cursor = c
        main.post { listener?.onCursor(c) }
    }

    internal fun setAvDelay(ms: Int) {
        avDelayMs = ms.coerceIn(0, 500)
    }

    /** Config local (p. ej. el warp identidad tras "Restablecer imagen" sin server). */
    internal fun setWarpLocal(w: Warp) {
        warp = w
        val c = calibration; val f = favorites
        main.post { listener?.onConfig(w, c, f) }
    }

    internal fun keyToScreen(key: String, done: (Boolean) -> Unit) = main.post {
        done(listener?.onKey(key) ?: false)
    }
}
