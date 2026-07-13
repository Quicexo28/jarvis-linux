package com.jarvis.companion

import android.content.Context
import android.util.Log
import org.json.JSONObject
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
}
