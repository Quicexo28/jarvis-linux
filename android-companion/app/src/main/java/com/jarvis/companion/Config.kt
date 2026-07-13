package com.jarvis.companion

import android.content.Context
import android.content.SharedPreferences

/**
 * App configuration persisted in SharedPreferences: backend base URL, the
 * long-lived MOBILE_INGEST_TOKEN, the device name reported to Jarvis and the
 * reporting interval in minutes.
 */
object Config {
    private const val PREFS = "cfg"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun baseUrl(ctx: Context): String =
        prefs(ctx).getString("baseUrl", "")!!.trim().trimEnd('/')

    fun token(ctx: Context): String = prefs(ctx).getString("token", "")!!.trim()

    fun device(ctx: Context): String {
        val d = prefs(ctx).getString("device", "tablet")!!.trim().lowercase()
        return if (Regex("^[a-z0-9_-]{1,24}$").matches(d)) d else "tablet"
    }

    fun intervalMin(ctx: Context): Int =
        prefs(ctx).getInt("intervalMin", 15).coerceIn(1, 240)

    fun isConfigured(ctx: Context): Boolean =
        baseUrl(ctx).startsWith("http") && token(ctx).isNotEmpty()

    fun save(ctx: Context, baseUrl: String, token: String, device: String, intervalMin: Int) {
        prefs(ctx).edit()
            .putString("baseUrl", baseUrl.trim())
            .putString("token", token.trim())
            .putString("device", device.trim())
            .putInt("intervalMin", intervalMin)
            .apply()
    }
}
