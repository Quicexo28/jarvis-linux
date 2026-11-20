package com.jarvis.companion.wall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.hardware.display.DisplayManager
import android.media.AudioManager
import android.media.MediaCodecList
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Display
import android.view.KeyEvent
import com.jarvis.companion.AdbWifi
import com.jarvis.companion.Config
import com.jarvis.companion.R
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Cliente de `wall-server` (PROTOCOL.md). Servicio en primer plano porque la
 * conexión tiene que sobrevivir con Netflix delante: es por donde llegan
 * `home`, las teclas y el siguiente cast.
 *
 * El proyector conecta hacia el portátil (nunca al revés: su IP cambia y el
 * ADB se apaga en cada arranque) y reconecta solo con backoff 1→10 s.
 */
class WallService : Service() {

    companion object {
        private const val TAG = "WallService"
        private const val CHANNEL_ID = "jarvis_wall"
        private const val NOTIF_ID = 7

        @Volatile private var self: WallService? = null
        @Volatile internal var reportedForeground = false

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, WallService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, WallService::class.java))
        }

        /** Arranque desde boot / ajustes: servicio + pantalla de la pared. */
        fun startWithActivity(ctx: Context, why: String) {
            try { start(ctx) } catch (e: Exception) { Log.w(TAG, "servicio ($why): ${e.message}") }
            showWall(ctx, why)
        }

        /**
         * Trae la pared al frente. Desde segundo plano solo funciona porque la
         * app tiene SYSTEM_ALERT_WINDOW (appops); sin eso Android lo descarta
         * en silencio.
         */
        fun showWall(ctx: Context, why: String) {
            try {
                ctx.startActivity(Intent(ctx, WallActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
            } catch (e: Exception) {
                Log.w(TAG, "no se pudo mostrar la pared ($why): ${e.message}")
            }
        }

        /**
         * Botón «Reintentar» de la pared: conecta ya, sin esperar al backoff.
         * Conectado pero sin imagen, pide al server que vuelva a la pared
         * (HOME = navegador en el lanzador + stream).
         */
        fun retryNow() {
            val s = self ?: return
            s.handler.post {
                if (s.ws == null) {
                    s.handler.removeCallbacksAndMessages(RECONNECT)
                    s.backoffMs = 1000L
                    s.connect()
                } else {
                    WallHub.send(JSONObject().put("t", "key").put("key", "HOME"))
                }
            }
        }

        private val RECONNECT = Any()

        /** Desde la accesibilidad (o la propia activity). */
        fun reportForeground(pkg: String?) {
            val s = self ?: return
            val ok = WallHub.send(JSONObject().put("t", "foreground").put("pkg", pkg ?: JSONObject.NULL))
            reportedForeground = ok
            s.lastForeground = pkg
        }
    }

    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private val client = OkHttpClient.Builder()
        // Latido propio además del ping del server: detecta un portátil que
        // se durmió sin cerrar el TCP.
        .pingInterval(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .build()
    @Volatile private var ws: WebSocket? = null
    private var backoffMs = 1000L
    private var stopped = false
    @Volatile internal var lastForeground: String? = null

    private val packageReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            handler.postDelayed({ sendApps() }, 500)
        }
    }

    override fun onCreate() {
        super.onCreate()
        self = this
        thread = HandlerThread("wall-ws").apply { start() }
        handler = Handler(thread.looper)
        WallHub.sender = { o -> ws?.send(o.toString()) ?: false }
        registerReceiver(packageReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
        })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        WallHome.syncTrampoline(this)
        if (!Config.wallMode(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        stopped = false
        AdbWifi.ensure(this)
        AdbWifi.watch(this)
        startA11yKeeper()
        if (ws == null) handler.post { connect() }
        handler.removeCallbacks(usagePoll)
        handler.post(usagePoll)
        return START_STICKY
    }

    // ------------------------------------------------- accesibilidad de fábrica

    /**
     * El WindowManager del HA109 (DisplayContent.enableNfxAccessibility) pone
     * enabled_accessibility_services a "" y accessibility_enabled a 0 en CADA
     * cambio de ventana con foco, salvo con com.netflix.mediaclient delante.
     * Sin esto la accesibilidad de la pared moriría al abrir cualquier app.
     * Con WRITE_SECURE_SETTINGS (pm grant) se reescribe en cuanto la borran;
     * el servicio tarda unos cientos de ms en volver a enlazarse.
     */
    private var a11yObserver: ContentObserver? = null
    private val reassertA11y = Runnable { ensureA11yEnabled() }

    private fun startA11yKeeper() {
        if (a11yObserver != null || !AdbWifi.allowed(this)) return
        val obs = object : ContentObserver(handler) {
            override fun onChange(selfChange: Boolean) {
                handler.removeCallbacks(reassertA11y)
                handler.postDelayed(reassertA11y, 100)
            }
        }
        contentResolver.registerContentObserver(Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES), false, obs)
        contentResolver.registerContentObserver(Settings.Secure.getUriFor(Settings.Secure.ACCESSIBILITY_ENABLED), false, obs)
        a11yObserver = obs
        ensureA11yEnabled()
    }

    private fun ensureA11yEnabled() {
        if (!Config.wallMode(this)) return
        try {
            val cr = contentResolver
            val me = ComponentName(this, WallAccessibilityService::class.java).flattenToString()
            val cur = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            val list = cur.split(':').filter { it.isNotBlank() }
            if (me !in list) Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, (list + me).joinToString(":"))
            if (Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) != 1) {
                Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            }
        } catch (e: Exception) {
            Log.w(TAG, "no se pudo reactivar la accesibilidad: ${e.message}")
        }
    }

    // ------------------------------------------------------ app en primer plano

    /**
     * Respaldo de la accesibilidad para `foreground`: UsageStats sigue
     * funcionando mientras el servicio de accesibilidad está caído por el
     * borrado de fábrica. Requiere `appops set … GET_USAGE_STATS allow`.
     */
    private var usageFrom = 0L
    private val usagePoll = object : Runnable {
        override fun run() {
            if (stopped) return
            pollForeground()
            handler.postDelayed(this, 1000)
        }
    }

    private fun pollForeground() {
        val usm = getSystemService(UsageStatsManager::class.java) ?: return
        val now = System.currentTimeMillis()
        val events = try { usm.queryEvents(if (usageFrom == 0L) now - 10_000 else usageFrom, now) } catch (e: Exception) { return } ?: return
        usageFrom = now
        var last: String? = null
        val ev = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(ev)
            if (ev.eventType == UsageEvents.Event.ACTIVITY_RESUMED) last = ev.packageName
        }
        if (last == null) return
        val mapped = if (last == packageName) null else last
        if (mapped != lastForeground || !reportedForeground) reportForeground(mapped)
    }

    override fun onDestroy() {
        stopped = true
        self = null
        a11yObserver?.let { contentResolver.unregisterContentObserver(it) }
        a11yObserver = null
        WallHub.sender = null
        runCatching { unregisterReceiver(packageReceiver) }
        ws?.close(1001, "servicio parado")
        ws = null
        WallHub.setConnected(false)
        thread.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ------------------------------------------------------------ conexión

    private fun connect() {
        if (stopped || ws != null) return
        val token = Config.wallToken(this)
        if (token.isEmpty()) {
            Log.w(TAG, "sin token de wall-server; no se conecta")
            return
        }
        // El token va en la query (contrato): no se loguea la URL completa.
        val url = Config.wallUrl(this)
        val sep = if (url.contains('?')) '&' else '?'
        val req = Request.Builder().url("$url${sep}token=${android.net.Uri.encode(token)}").build()
        Log.i(TAG, "conectando a $url")
        ws = client.newWebSocket(req, listener)
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val delay = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(10_000L)
        handler.postAtTime({ connect() }, RECONNECT, SystemClock.uptimeMillis() + delay)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket !== ws) return
            backoffMs = 1000L
            Log.i(TAG, "conectado")
            WallHub.setConnected(true)
            sendHello(webSocket)
            // El primer `foreground` tras conectar siempre sale, aunque no cambie.
            val fg = WallAccessibilityService.foreground.takeIf { WallAccessibilityService.instance != null }
                ?: if (WallActivity.resumed) null else lastForeground
            reportForeground(fg)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket !== ws) return
            val msg = try { JSONObject(text) } catch (e: Exception) { return }
            handleControl(webSocket, msg)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (webSocket !== ws) return
            // [flags][pts uint64 BE][Annex-B AU]. asByteBuffer: sin copia; el
            // decoder copia al buffer de entrada de MediaCodec.
            if (bytes.size < 10) return
            val buf = bytes.asByteBuffer()
            val flags = buf.get(0).toInt()
            val pts = buf.getLong(1)
            buf.position(9)
            WallHub.videoSink?.onFrame(buf.slice(), (flags and 1) != 0, (flags and 2) != 0, pts)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket, "cerrado $code")

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            dropped(webSocket, "fallo ${response?.code ?: ""} ${t.javaClass.simpleName}: ${t.message}")
    }

    private fun dropped(webSocket: WebSocket, why: String) {
        handler.post {
            if (webSocket !== ws) return@post
            Log.i(TAG, "desconectado: $why")
            ws = null
            WallHub.setConnected(false)
            scheduleReconnect()
        }
    }

    // ------------------------------------------------------------- mensajes

    private fun sendHello(webSocket: WebSocket) {
        val dm = getSystemService(DisplayManager::class.java)
        val mode = dm.getDisplay(Display.DEFAULT_DISPLAY).mode
        val hello = JSONObject()
            .put("t", "hello")
            .put("v", 1)
            .put("device", Build.MODEL)
            .put("panel", JSONObject().put("w", mode.physicalWidth).put("h", mode.physicalHeight))
            .put("decoders", JSONArray(hardwareDecoders()))
            .put("apps", appsJson())
        webSocket.send(hello.toString())
    }

    private fun sendApps() {
        WallHub.send(JSONObject().put("t", "apps").put("apps", appsJson()))
    }

    private fun appsJson() = JSONArray().apply {
        for (a in AppCatalog.list(this@WallService)) put(JSONObject().put("pkg", a.pkg).put("label", a.label))
    }

    private fun hardwareDecoders(): List<String> {
        val out = linkedSetOf<String>()
        for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
            if (info.isEncoder) continue
            if (Build.VERSION.SDK_INT >= 29 && !info.isHardwareAccelerated) continue
            for (t in info.supportedTypes) if (t == "video/avc" || t == "video/hevc") out.add(t)
        }
        return out.toList()
    }

    private fun handleControl(webSocket: WebSocket, msg: JSONObject) {
        when (msg.optString("t")) {
            // Eco inmediato desde el hilo de OkHttp: mide red, no colas de la app.
            "ping" -> webSocket.send(JSONObject().put("t", "pong").put("ts", msg.opt("ts")).toString())
            "config" -> WallHub.setConfig(msg)
            "stream" -> {
                WallHub.setStream(WallHub.Stream(msg.optString("codec", "avc"), msg.optInt("width"), msg.optInt("height")))
                // Un cast mientras Netflix está delante: la pared vuelve sola.
                if (!WallActivity.resumed) showWall(this, "stream")
            }
            "streamStop" -> WallHub.setStream(null)
            // v3: puntero virtual del navegador de la pared y retraso de imagen.
            "cursor" -> WallHub.setCursor(WallHub.Cursor(
                msg.optDouble("x", 0.5).toFloat().coerceIn(0f, 1f),
                msg.optDouble("y", 0.5).toFloat().coerceIn(0f, 1f),
                msg.optBoolean("visible", false)))
            "av" -> WallHub.setAvDelay(msg.optInt("delayMs", 0))
            "launch" -> {
                val pkg = msg.optString("pkg")
                handler.post {
                    WallHub.setStream(null)
                    if (!AppCatalog.launch(this, pkg)) Log.w(TAG, "launch $pkg falló")
                }
            }
            // v3: el stream lo decide el server (sigue con el navegador): aquí
            // solo se trae la pared al frente.
            "home" -> {
                showWall(this, "home")
                WallHub.home()
            }
            "key" -> handleKey(msg.optString("key"))
            "text" -> setText(msg.optString("text"), SystemClock.elapsedRealtime() + 1500)
            "getIcon" -> {
                val pkg = msg.optString("pkg")
                handler.post {
                    val png = AppCatalog.iconPngBase64(this, pkg) ?: return@post
                    WallHub.send(JSONObject().put("t", "icon").put("pkg", pkg).put("png", png))
                }
            }
        }
    }

    /** Teclas de la API con fuente native/none (el server ya decidió el ruteo). */
    private fun handleKey(key: String) {
        val am = getSystemService(AudioManager::class.java)
        when (key) {
            "PLAY_PAUSE" -> mediaKey(am, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
            "NEXT" -> mediaKey(am, KeyEvent.KEYCODE_MEDIA_NEXT)
            "PREV" -> mediaKey(am, KeyEvent.KEYCODE_MEDIA_PREVIOUS)
            "VOL_UP" -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
            "VOL_DOWN" -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
            "MUTE" -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI)
            "HOME" -> { showWall(this, "key"); WallHub.home() }
            else -> {
                // D-pad/OK/BACK: inyectados por accesibilidad, así llegan igual
                // a Netflix que al mosaico propio. Sin accesibilidad, al menos
                // el mosaico se maneja solo.
                navKey(key, SystemClock.elapsedRealtime() + 1500)
            }
        }
    }

    /**
     * Si la accesibilidad está caída (la acaba de borrar el WindowManager de
     * fábrica tras un cambio de foco) se reintenta hasta 1,5 s: lo que tarda en
     * reactivarse y volver a enlazarse. Después, al menos el mosaico propio.
     */
    private fun navKey(key: String, deadline: Long) {
        val a11y = WallAccessibilityService.instance
        if (a11y != null && a11y.key(key)) return
        if (SystemClock.elapsedRealtime() < deadline && AdbWifi.allowed(this)) {
            handler.postDelayed({ navKey(key, deadline) }, 100)
            return
        }
        WallHub.keyToScreen(key) { handled ->
            if (!handled) Log.w(TAG, "tecla $key sin destino: accesibilidad de la pared caída")
        }
    }

    /** Igual que [navKey]: espera a que la accesibilidad vuelva tras el borrado de fábrica. */
    private fun setText(text: String, deadline: Long) {
        val a11y = WallAccessibilityService.instance
        if (a11y != null) {
            if (!a11y.setText(text)) Log.i(TAG, "text: no hay campo editable con foco")
            return
        }
        if (SystemClock.elapsedRealtime() < deadline && AdbWifi.allowed(this)) {
            handler.postDelayed({ setText(text, deadline) }, 100)
            return
        }
        Log.i(TAG, "text: accesibilidad de la pared caída")
    }

    private fun mediaKey(am: AudioManager, code: Int) {
        val t = SystemClock.uptimeMillis()
        am.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0))
        am.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0))
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Jarvis pared", NotificationManager.IMPORTANCE_MIN))
        val pi = PendingIntent.getActivity(this, 0, Intent(this, WallActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Pared")
            .setContentText("Conectada a wall-server")
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }
}
