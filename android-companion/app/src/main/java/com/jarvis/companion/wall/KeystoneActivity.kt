package com.jarvis.companion.wall

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * Control del keystone del proyector, DIRECTO tablet → proyector (HTTP 8451,
 * sin PC). Cuatro esquinas arrastrables sobre una vista del panel + zoom.
 *
 * El proyector se encuentra por mDNS (`_wallks._tcp`). Primera vez: el token de
 * la pared (el mismo de wall-server) llega por adb:
 *   adb shell am start -n com.jarvis.companion/.wall.KeystoneActivity \
 *       --es ksToken <token> [--es ksHost <ip>]
 */
class KeystoneActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val pending = AtomicReference<JSONObject?>(null)
    private var host: String? = null
    private var token = ""
    private lateinit var status: TextView
    private lateinit var preview: Preview
    private lateinit var zoomBar: SeekBar
    private lateinit var zoomLabel: TextView
    private var zoomBase = IntArray(8)
    private lateinit var ratioBar: SeekBar
    private lateinit var ratioLabel: TextView
    private var ratioBase = IntArray(8)
    private var nsd: NsdManager? = null
    private var discovery: NsdManager.DiscoveryListener? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val p = getSharedPreferences("ks_client", Context.MODE_PRIVATE)
        intent.getStringExtra("ksToken")?.let { p.edit().putString("token", it.trim()).apply() }
        intent.getStringExtra("ksHost")?.let { p.edit().putString("host", it.trim()).apply() }
        token = p.getString("token", "")!!
        host = p.getString("host", null)?.takeIf { it.isNotEmpty() }

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(10, 13, 19)) }
        status = TextView(this).apply { setTextColor(Color.rgb(170, 180, 195)); textSize = 16f; setPadding(dp(16), dp(40), dp(16), dp(2)) }
        root.addView(status)
        root.addView(TextView(this).apply { text = "Arrastra una esquina, o el interior para mover toda la imagen"; setTextColor(Color.rgb(110, 125, 145)); textSize = 13f; setPadding(dp(16), 0, dp(16), dp(4)) })
        preview = Preview(this) { showReadouts(); sendNow(false) }
        root.addView(preview, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

        zoomLabel = TextView(this).apply { setTextColor(Color.rgb(140, 155, 175)); setPadding(dp(16), dp(4), dp(16), 0) }
        root.addView(zoomLabel)
        zoomBar = SeekBar(this).apply {
            max = 80 // zoom = 20 + progreso → 20 … 100 %
            progress = 80
            setPadding(dp(24), dp(4), dp(24), dp(4))
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar?, v: Int, fromUser: Boolean) {
                    if (!fromUser) return
                    val out = withZoom(zoomBase, (20 + v) / 100f)
                    System.arraycopy(out, 0, preview.ins, 0, 8)
                    preview.invalidate(); showReadouts(); sendNow(false)
                }
                override fun onStartTrackingTouch(s: SeekBar?) { zoomBase = preview.ins.copyOf() }
                override fun onStopTrackingTouch(s: SeekBar?) { sendNow(true) }
            })
        }
        root.addView(zoomBar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        ratioLabel = TextView(this).apply { setTextColor(Color.rgb(140, 155, 175)); setPadding(dp(16), dp(8), dp(16), 0) }
        root.addView(ratioLabel)
        val chips = LinearLayout(this).apply { setPadding(dp(12), 0, dp(12), 0) }
        for ((name, r) in listOf("16:9" to 16f / 9f, "4:3" to 4f / 3f, "21:9" to 21f / 9f, "1:1" to 1f)) {
            chips.addView(Button(this).apply { text = name; setOnClickListener { setRatio(r, true) } })
        }
        root.addView(chips)
        ratioBar = SeekBar(this).apply {
            max = 200 // proporción = 0.5 + progreso/100  → 0.5 … 2.5
            setPadding(dp(24), dp(4), dp(24), dp(4))
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar?, v: Int, fromUser: Boolean) { if (fromUser) setRatio(0.5f + v / 100f, false, ratioBase) }
                override fun onStartTrackingTouch(s: SeekBar?) { ratioBase = preview.ins.copyOf() }
                override fun onStopTrackingTouch(s: SeekBar?) { sendNow(true) }
            })
        }
        root.addView(ratioBar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        val row = LinearLayout(this).apply { gravity = Gravity.CENTER; setPadding(dp(16), dp(8), dp(16), dp(16)) }
        row.addView(Button(this).apply { text = "Restablecer"; setOnClickListener { reset() } })
        root.addView(row)
        setContentView(root)
        setStatus(if (token.isEmpty()) "Falta el token (ver instrucciones en KeystoneActivity)" else "Buscando el proyector…")
    }

    override fun onStart() {
        super.onStart()
        if (token.isEmpty()) return
        if (host != null) connect() else discover()
    }

    override fun onStop() {
        stopDiscovery()
        super.onStop()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun setStatus(t: String) = ui.post { status.text = t }

    // ---------------------------------------------------------------- red

    private fun discover() {
        stopDiscovery()
        val mgr = getSystemService(NsdManager::class.java).also { nsd = it }
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onStartDiscoveryFailed(t: String, e: Int) { setStatus("mDNS falló ($e). Pasa ksHost por adb.") }
            override fun onStopDiscoveryFailed(t: String, e: Int) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onServiceLost(i: NsdServiceInfo) {}
            @Suppress("DEPRECATION")
            override fun onServiceFound(i: NsdServiceInfo) {
                mgr.resolveService(i, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(s: NsdServiceInfo, e: Int) {}
                    override fun onServiceResolved(s: NsdServiceInfo) {
                        host = s.host.hostAddress
                        stopDiscovery()
                        connect()
                    }
                })
            }
        }
        discovery = l
        mgr.discoverServices(KeystoneService.NSD_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
    }

    private fun stopDiscovery() {
        runCatching { discovery?.let { nsd?.stopServiceDiscovery(it) } }
        discovery = null
    }

    private fun call(method: String, path: String, body: JSONObject?): JSONObject? {
        val h = host ?: return null
        return try {
            val c = URL("http://$h:${KeystoneService.PORT}$path").openConnection() as HttpURLConnection
            c.requestMethod = method
            c.connectTimeout = 2000; c.readTimeout = 3000
            c.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) { c.doOutput = true; c.outputStream.use { it.write(body.toString().toByteArray()) } }
            val txt = (if (c.responseCode < 400) c.inputStream else c.errorStream).bufferedReader().readText()
            JSONObject(txt)
        } catch (e: Exception) { Log.w(TAG, "$method $path: ${e.message}"); null }
    }

    private fun connect() {
        setStatus("Conectando a $host…")
        io.execute {
            val r = call("GET", "/keystone", null)
            if (r?.optBoolean("ok") == true) { ui.post { apply(r); setStatus("Conectado a $host") } }
            else setStatus(if (r?.optString("error") == "unauthorized") "Token incorrecto" else "Sin respuesta de $host")
        }
    }

    private fun apply(r: JSONObject) {
        val c = r.getJSONArray("corners")
        for (i in 0 until 4) { preview.ins[i * 2] = c.getJSONArray(i).getInt(0); preview.ins[i * 2 + 1] = c.getJSONArray(i).getInt(1) }
        preview.invalidate()
        showReadouts()
    }

    // ------------------------------------------------- proporción de la imagen

    private val pw = Keystone.PANEL_W.toFloat()
    private val ph = Keystone.PANEL_H.toFloat()

    /** Esquinas TL, TR, BL, BR en px de panel (x0,y0,x1,y1,…) a partir de las inserciones. */
    private fun corners(i: IntArray) = floatArrayOf(
        i[0].toFloat(), i[1].toFloat(), pw - i[2], i[3].toFloat(),
        i[4].toFloat(), ph - i[5], pw - i[6], ph - i[7])

    /** Ancho/alto medios de la imagen proyectada. */
    private fun ratioOf(i: IntArray): Float {
        val c = corners(i)
        val w = ((c[2] - c[0]) + (c[6] - c[4])) / 2f
        val h = ((c[5] - c[1]) + (c[7] - c[3])) / 2f
        return if (h > 1f) w / h else 1f
    }

    /**
     * Cambia la proporción de [base] a [r] (ancho/alto) sin mover su centro y
     * conservando el área; si no cabe en el panel, la encoge. Las esquinas
     * mantienen su forma relativa (el keystone no se pierde).
     */
    private fun withRatio(base: IntArray, r: Float): IntArray {
        val c = corners(base)
        val cx = c.filterIndexed { k, _ -> k % 2 == 0 }.average().toFloat()
        val cy = c.filterIndexed { k, _ -> k % 2 == 1 }.average().toFloat()
        val kx = Math.sqrt((r / ratioOf(base)).toDouble()).toFloat()
        val ky = 1f / kx
        val maxX = pw * 0.4f; val maxY = ph * 0.4f
        var s = 1f
        repeat(300) {
            val out = IntArray(8)
            var ok = true
            for (k in 0 until 4) {
                val x = cx + (c[k * 2] - cx) * kx * s
                val y = cy + (c[k * 2 + 1] - cy) * ky * s
                val ix = Math.round(if (k % 2 == 0) x else pw - x)
                val iy = Math.round(if (k < 2) y else ph - y)
                if (ix < 0 || ix > maxX || iy < 0 || iy > maxY) ok = false
                out[k * 2] = ix; out[k * 2 + 1] = iy
            }
            if (ok) return out
            s *= 0.99f
        }
        return base
    }

    private fun bbox(c: FloatArray): FloatArray {
        val xs = c.filterIndexed { k, _ -> k % 2 == 0 }; val ys = c.filterIndexed { k, _ -> k % 2 == 1 }
        return floatArrayOf(xs.min(), ys.min(), xs.max(), ys.max())
    }

    /** Tamaño de la imagen respecto al panel: la mayor de las dos dimensiones del cuadro que la contiene. */
    private fun zoomOf(i: IntArray): Float {
        val b = bbox(corners(i))
        return maxOf((b[2] - b[0]) / pw, (b[3] - b[1]) / ph)
    }

    /**
     * Zoom general: escala las 4 esquinas a la vez alrededor del centro de la
     * imagen (la forma del keystone se conserva) y la recoloca dentro del panel.
     */
    private fun withZoom(base: IntArray, z: Float): IntArray {
        val c = corners(base)
        val b = bbox(c)
        val cur = zoomOf(base)
        if (cur < 0.01f) return base
        val s = z / cur
        val cx = (b[0] + b[2]) / 2; val cy = (b[1] + b[3]) / 2
        val n = FloatArray(8) { k -> if (k % 2 == 0) cx + (c[k] - cx) * s else cy + (c[k] - cy) * s }
        val nb = bbox(n)
        val dx = if (nb[0] < 0f) -nb[0] else if (nb[2] > pw) pw - nb[2] else 0f
        val dy = if (nb[1] < 0f) -nb[1] else if (nb[3] > ph) ph - nb[3] else 0f
        val maxX = (pw * 0.4f).toInt(); val maxY = (ph * 0.4f).toInt()
        val out = IntArray(8)
        for (k in 0 until 4) {
            val x = n[k * 2] + dx; val y = n[k * 2 + 1] + dy
            out[k * 2] = Math.round(if (k % 2 == 0) x else pw - x).coerceIn(0, maxX)
            out[k * 2 + 1] = Math.round(if (k < 2) y else ph - y).coerceIn(0, maxY)
        }
        return out
    }

    private fun setRatio(r: Float, fromChip: Boolean, base: IntArray = preview.ins.copyOf()) {
        val out = withRatio(base, r)
        System.arraycopy(out, 0, preview.ins, 0, 8)
        preview.invalidate()
        showReadouts()
        if (fromChip) sendNow(true) else sendNow(false)
    }

    private fun showReadouts() {
        val z = zoomOf(preview.ins)
        zoomLabel.text = "Zoom  ${Math.round(z * 100)} %"
        zoomBar.progress = (Math.round(z * 100) - 20).coerceIn(0, 80)
        val r = ratioOf(preview.ins)
        ratioLabel.text = "Proporción de la imagen  %.2f : 1".format(r)
        ratioBar.progress = ((r - 0.5f) * 100).toInt().coerceIn(0, 200)
    }

    private fun state(): JSONObject = JSONObject()
        // El zoom propio del hardware queda neutro: el zoom general escala las esquinas.
        .put("zoomH", 100.0).put("zoomV", 100.0)
        .put("corners", JSONArray().apply { for (i in 0 until 4) put(JSONArray().put(preview.ins[i * 2]).put(preview.ins[i * 2 + 1])) })

    /** Último gana: durante el arrastre solo se envía el estado más reciente. */
    private fun sendNow(final: Boolean) {
        pending.set(state())
        io.execute {
            val s = pending.getAndSet(null) ?: return@execute
            val r = call("POST", "/keystone", s)
            if (r?.optBoolean("ok") != true) setStatus("Error: ${r?.optString("error") ?: "sin respuesta"} ${r?.optString("detail") ?: ""}")
            else if (final) setStatus("Guardado")
        }
    }

    private fun reset() {
        io.execute {
            val r = call("POST", "/keystone/reset", JSONObject())
            if (r?.optBoolean("ok") == true) ui.post { apply(r); setStatus("Restablecido") } else setStatus("No se pudo restablecer")
        }
    }

    // ------------------------------------------------------------ vista

    /** Panel 1280x720 con las 4 esquinas movibles. `ins` = x,y de TL,TR,BL,BR (px de panel). */
    private class Preview(ctx: Context, val onChange: () -> Unit) : View(ctx) {
        val ins = IntArray(8)
        private val pw = Keystone.PANEL_W.toFloat(); private val ph = Keystone.PANEL_H.toFloat()
        private val maxX = (pw * 0.4f).toInt(); private val maxY = (ph * 0.4f).toInt()
        private var drag = -1
        private var body = false
        private var lastX = 0f; private var lastY = 0f
        private var scale = 1f; private var ox = 0f; private var oy = 0f
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(70, 60, 130, 255); style = Paint.Style.FILL }
        private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(90, 160, 255); style = Paint.Style.STROKE; strokeWidth = 3f }
        private val frame = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(60, 70, 85); style = Paint.Style.STROKE; strokeWidth = 2f }
        private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }

        private fun layoutMetrics() {
            val m = 48f
            scale = minOf((width - 2 * m) / pw, (height - 2 * m) / ph)
            ox = (width - pw * scale) / 2; oy = (height - ph * scale) / 2
        }

        /** Posición de la esquina i en pantalla. */
        private fun pos(i: Int): Pair<Float, Float> {
            val x = ins[i * 2]; val y = ins[i * 2 + 1]
            val px = if (i % 2 == 0) x.toFloat() else pw - x
            val py = if (i < 2) y.toFloat() else ph - y
            return (ox + px * scale) to (oy + py * scale)
        }

        override fun onDraw(c: Canvas) {
            layoutMetrics()
            c.drawRect(ox, oy, ox + pw * scale, oy + ph * scale, frame)
            val order = intArrayOf(0, 1, 3, 2)
            val path = Path()
            order.forEachIndexed { k, i -> val (x, y) = pos(i); if (k == 0) path.moveTo(x, y) else path.lineTo(x, y) }
            path.close()
            c.drawPath(path, fill); c.drawPath(path, line)
            for (i in 0 until 4) { val (x, y) = pos(i); c.drawCircle(x, y, 26f, dot); c.drawCircle(x, y, 26f, line) }
        }

        /**
         * Desplaza toda la imagen: las esquinas izquierdas se meten +dx y las
         * derechas −dx (igual en y). Se recorta para que ninguna salga de 0..max;
         * solo hay margen de movimiento si la imagen es más pequeña que el panel.
         */
        private fun moveAll(dx0: Int, dy0: Int) {
            val xl = intArrayOf(ins[0], ins[4]); val xr = intArrayOf(ins[2], ins[6])
            val yt = intArrayOf(ins[1], ins[3]); val yb = intArrayOf(ins[5], ins[7])
            val dx = dx0.coerceIn(maxOf(-xl.min(), xr.max() - maxX), minOf(maxX - xl.max(), xr.min()))
            val dy = dy0.coerceIn(maxOf(-yt.min(), yb.max() - maxY), minOf(maxY - yt.max(), yb.min()))
            if (dx == 0 && dy == 0) return
            ins[0] += dx; ins[4] += dx; ins[2] -= dx; ins[6] -= dx
            ins[1] += dy; ins[3] += dy; ins[5] -= dy; ins[7] -= dy
            lastX += dx * scale; lastY += dy * scale
            invalidate(); onChange()
        }

        override fun onTouchEvent(e: MotionEvent): Boolean {
            layoutMetrics()
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    drag = (0 until 4).minByOrNull { val (x, y) = pos(it); (x - e.x) * (x - e.x) + (y - e.y) * (y - e.y) } ?: -1
                    val (x, y) = pos(drag)
                    if ((x - e.x) * (x - e.x) + (y - e.y) * (y - e.y) > 90f * 90f) drag = -1
                    body = drag < 0
                    lastX = e.x; lastY = e.y
                }
                MotionEvent.ACTION_MOVE -> if (body) {
                    moveAll(((e.x - lastX) / scale).toInt(), ((e.y - lastY) / scale).toInt())
                } else if (drag >= 0) {
                    val px = ((e.x - ox) / scale).coerceIn(0f, pw); val py = ((e.y - oy) / scale).coerceIn(0f, ph)
                    ins[drag * 2] = (if (drag % 2 == 0) px else pw - px).toInt().coerceIn(0, maxX)
                    ins[drag * 2 + 1] = (if (drag < 2) py else ph - py).toInt().coerceIn(0, maxY)
                    invalidate(); onChange()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { if (drag >= 0 || body) onChange(); drag = -1; body = false }
            }
            return true
        }
    }

    companion object { private const val TAG = "WallKeystoneUi" }
}
