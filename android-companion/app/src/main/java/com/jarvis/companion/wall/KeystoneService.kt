package com.jarvis.companion.wall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.jarvis.companion.Config
import com.jarvis.companion.R
import org.json.JSONObject
import java.io.BufferedInputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest

/**
 * Servidor HTTP mínimo (puerto 8451, solo LAN) para ajustar el keystone sin
 * depender de la pared ni del PC. Vive desde el arranque.
 *
 *   GET  /keystone        → estado
 *   POST /keystone        → {zoomH?, zoomV?, corners?:[[x,y]×4]} (parcial) → estado
 *   POST /keystone/reset  → neutro
 *
 * Auth: `Authorization: Bearer <wallToken>`. Sin wallToken configurado rechaza todo.
 */
class KeystoneService : Service() {
    private var server: ServerSocket? = null
    @Volatile private var running = false
    private var nsd: android.net.nsd.NsdManager? = null
    private var listener: android.net.nsd.NsdManager.RegistrationListener? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Keystone", NotificationManager.IMPORTANCE_MIN))
        val n = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Keystone").setContentText("Ajuste de la proyección").setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIF_ID, n)
        if (!running) {
            running = true
            Keystone.ensureHiddenApi(this)
            Thread({ restoreAtBoot() }, "ks-restore").start()
            Thread({ serve() }, "ks-http").start()
            advertise()
        }
        return START_STICKY
    }

    /** El HAL puede tardar en estar listo tras el arranque: reintenta ~1 min. */
    private fun restoreAtBoot() {
        repeat(20) {
            if (!running) return
            if (Keystone.restore(this)) { Log.i(TAG, "keystone restaurado"); return }
            Thread.sleep(3000)
        }
        Log.w(TAG, "no se pudo restaurar el keystone")
    }

    private fun serve() {
        try {
            val ss = ServerSocket(PORT).also { server = it }
            while (running) {
                val s = ss.accept()
                Thread({ handle(s) }, "ks-conn").start()
            }
        } catch (e: Exception) {
            if (running) Log.w(TAG, "servidor: ${e.message}")
        }
    }

    private fun handle(s: Socket) {
        s.use {
            it.soTimeout = 5000
            val inp = BufferedInputStream(it.getInputStream())
            val out = it.getOutputStream()
            fun reply(code: Int, body: JSONObject) {
                val b = body.toString().toByteArray()
                out.write("HTTP/1.1 $code X\r\nContent-Type: application/json\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n".toByteArray())
                out.write(b); out.flush()
            }
            try {
                fun line(): String? {
                    val sb = StringBuilder()
                    while (true) {
                        val c = inp.read()
                        if (c < 0) return null
                        if (c == '\n'.code) return sb.toString().trimEnd('\r')
                        if (sb.length > 4096) return null
                        sb.append(c.toChar())
                    }
                }
                val first = line() ?: return
                val (method, path) = first.split(' ').let { p -> p[0] to p.getOrElse(1) { "" } }
                var auth = ""; var len = 0
                while (true) {
                    val h = line() ?: return
                    if (h.isEmpty()) break
                    val i = h.indexOf(':'); if (i < 0) continue
                    when (h.substring(0, i).trim().lowercase()) {
                        "authorization" -> auth = h.substring(i + 1).trim()
                        "content-length" -> len = h.substring(i + 1).trim().toIntOrNull() ?: 0
                    }
                }
                val token = Config.wallToken(this)
                val ok = token.isNotEmpty() && MessageDigest.isEqual(auth.toByteArray(), "Bearer $token".toByteArray())
                if (!ok) return reply(401, JSONObject().put("ok", false).put("error", "unauthorized"))
                if (len > 2048) return reply(413, JSONObject().put("ok", false).put("error", "too_large"))
                val body = if (len > 0) ByteArray(len).also { b -> var n = 0; while (n < len) { val r = inp.read(b, n, len - n); if (r < 0) break; n += r } } else ByteArray(0)

                when {
                    method == "GET" && path == "/keystone" ->
                        reply(200, Keystone.load(this).toJson().put("ok", true))
                    method == "POST" && path == "/keystone" -> {
                        val st = try { Keystone.parse(Keystone.load(this), JSONObject(String(body))) }
                        catch (e: Exception) { return reply(400, JSONObject().put("ok", false).put("error", "invalid_keystone").put("detail", e.message)) }
                        try { Keystone.set(this, st) }
                        catch (e: Throwable) { return reply(502, JSONObject().put("ok", false).put("error", "hal_failed").put("detail", e.message)) }
                        reply(200, st.toJson().put("ok", true))
                    }
                    method == "POST" && path == "/keystone/reset" -> {
                        try { reply(200, Keystone.reset(this).toJson().put("ok", true)) }
                        catch (e: Throwable) { reply(502, JSONObject().put("ok", false).put("error", "hal_failed").put("detail", e.message)) }
                    }
                    else -> reply(404, JSONObject().put("ok", false).put("error", "not_found"))
                }
            } catch (e: Exception) {
                Log.w(TAG, "petición: ${e.message}")
            }
        }
    }

    /** Anuncia el servicio en la LAN (mDNS) para que la tablet lo encuentre sin saber la IP. */
    private fun advertise() {
        try {
            val info = android.net.nsd.NsdServiceInfo().apply {
                serviceName = "wall-keystone"; serviceType = NSD_TYPE; port = PORT
            }
            nsd = getSystemService(android.net.nsd.NsdManager::class.java)
            listener = object : android.net.nsd.NsdManager.RegistrationListener {
                override fun onServiceRegistered(i: android.net.nsd.NsdServiceInfo) { Log.i(TAG, "anunciado como ${i.serviceName}") }
                override fun onRegistrationFailed(i: android.net.nsd.NsdServiceInfo, e: Int) { Log.w(TAG, "mDNS falló: $e") }
                override fun onServiceUnregistered(i: android.net.nsd.NsdServiceInfo) {}
                override fun onUnregistrationFailed(i: android.net.nsd.NsdServiceInfo, e: Int) {}
            }
            nsd?.registerService(info, android.net.nsd.NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: Exception) { Log.w(TAG, "mDNS: ${e.message}") }
    }

    override fun onDestroy() {
        runCatching { listener?.let { nsd?.unregisterService(it) } }
        running = false
        runCatching { server?.close() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "WallKeystone"
        private const val CHANNEL = "keystone"
        private const val NOTIF_ID = 8
        const val PORT = 8451
        const val NSD_TYPE = "_wallks._tcp."

        fun start(ctx: Context) { ctx.startForegroundService(Intent(ctx, KeystoneService::class.java)) }
    }
}
