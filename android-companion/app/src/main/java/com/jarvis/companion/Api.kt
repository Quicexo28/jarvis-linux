package com.jarvis.companion

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Tiny HTTP client for the Jarvis ingest endpoints (/api/mobile/ctx/...).
 * Blocking — always call from a background thread. Failures are logged and
 * swallowed: the tablet may be off-network and the service must keep running.
 */
object Api {
    private const val TAG = "JarvisApi"

    /** POST a JSON body to `path` (e.g. "/api/mobile/ctx/battery"). */
    fun post(ctx: Context, path: String, body: JSONObject): Boolean {
        val base = Config.baseUrl(ctx)
        if (base.isEmpty()) return false
        body.put("device", Config.device(ctx))
        return try {
            val conn = URL(base + path).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer " + Config.token(ctx))
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            conn.disconnect()
            if (code !in 200..299) Log.w(TAG, "POST $path -> $code")
            code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "POST $path failed: ${e.message}")
            false
        }
    }

    /**
     * POST JSON and return the response body, for the endpoints whose *answer*
     * matters (`/api/jarvis/turn`). Unlike [post] it does not inject `device`:
     * these are not ingest calls. Null on any failure.
     */
    fun postForJson(ctx: Context, path: String, body: JSONObject, timeoutMs: Int = 15_000): JSONObject? {
        val text = request(ctx, path, "POST", body.toString(), timeoutMs) ?: return null
        return try {
            JSONObject(text)
        } catch (e: Exception) {
            Log.w(TAG, "POST $path: bad json (${text.take(120)})")
            null
        }
    }

    /** GET JSON (e.g. /api/skills/desktop/remote). Null on any failure. */
    fun getJson(ctx: Context, path: String, timeoutMs: Int = 8_000): JSONObject? {
        val text = request(ctx, path, "GET", null, timeoutMs) ?: return null
        return try {
            JSONObject(text)
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Is the backend reachable? `/health` is public (no token), so a failure here
     * means the network or the laptop, never the pairing.
     */
    fun health(ctx: Context, timeoutMs: Int = 4_000): Boolean =
        request(ctx, "/health", "GET", null, timeoutMs) != null

    /**
     * Open a raw connection for a streaming response (TTS PCM). The caller owns
     * the stream and must close it; null when the request failed.
     */
    fun openStream(ctx: Context, path: String, body: JSONObject, timeoutMs: Int = 20_000): HttpURLConnection? {
        val base = Config.baseUrl(ctx)
        if (base.isEmpty()) return null
        return try {
            val conn = URL(base + path).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer " + Config.token(ctx))
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            if (conn.responseCode !in 200..299) {
                Log.w(TAG, "POST $path -> ${conn.responseCode}")
                conn.disconnect()
                null
            } else {
                conn
            }
        } catch (e: Exception) {
            Log.w(TAG, "stream $path failed: ${e.message}")
            null
        }
    }

    /**
     * Sube un fichero crudo: el cuerpo son los bytes y el nombre viaja en
     * `X-Jarvis-Filename`. No es multipart a proposito — el unico cliente es
     * esta app, y el backend no trae parser multipart (handlers/stt.js CONSTRUYE
     * uno hacia Python, no lo lee), asi que anadirlo seria superficie gratis.
     *
     * Va en streaming (`setChunkedStreamingMode`): un adjunto compartido puede
     * pesar decenas de MB y cargarlo entero en memoria antes de enviar es lo que
     * tumba la app. El backend impone su propio tope mientras lee, de modo que
     * un fichero demasiado grande se corta alli y responde 413.
     *
     * El InputStream se cierra aqui. Null en cualquier fallo.
     */
    fun postFile(
        ctx: Context,
        path: String,
        filename: String,
        mime: String,
        input: InputStream,
        timeoutMs: Int = 60_000,
    ): JSONObject? {
        val base = Config.baseUrl(ctx)
        if (base.isEmpty()) return null
        return try {
            val conn = URL(base + path).openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = timeoutMs
            conn.doOutput = true
            conn.setChunkedStreamingMode(64 * 1024)
            conn.setRequestProperty("Content-Type", if (mime.isEmpty()) "application/octet-stream" else mime)
            conn.setRequestProperty("X-Jarvis-Filename", filename)
            conn.setRequestProperty("Authorization", "Bearer " + Config.token(ctx))
            input.use { src -> conn.outputStream.use { out -> src.copyTo(out, 64 * 1024) } }
            val code = conn.responseCode
            val text = if (code in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else null
            if (text == null) Log.w(TAG, "POST $path ($filename) -> $code")
            conn.disconnect()
            text?.let { JSONObject(it) }
        } catch (e: Exception) {
            Log.w(TAG, "upload $filename failed: ${e.message}")
            try { input.close() } catch (_: Exception) {}
            null
        }
    }

    private fun request(ctx: Context, path: String, method: String, body: String?, timeoutMs: Int): String? {
        val base = Config.baseUrl(ctx)
        if (base.isEmpty()) return null
        return try {
            val conn = URL(base + path).openConnection() as HttpURLConnection
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Authorization", "Bearer " + Config.token(ctx))
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toByteArray()) }
            }
            val code = conn.responseCode
            val text = if (code in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else null
            if (text == null) Log.w(TAG, "$method $path -> $code")
            conn.disconnect()
            text
        } catch (e: Exception) {
            Log.w(TAG, "$method $path failed: ${e.message}")
            null
        }
    }
}
