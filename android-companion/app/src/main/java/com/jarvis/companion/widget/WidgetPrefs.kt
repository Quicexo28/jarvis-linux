package com.jarvis.companion.widget

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/** One machine the desktop widget can stream from. `uuid` null = open Moonlight's PC list. */
data class DesktopTarget(val label: String, val host: String, val uuid: String?)

/**
 * Per-widget state, kept apart from [com.jarvis.companion.Config] (which holds
 * the pairing) because it is disposable: the discovered machine list, plus a
 * cached "is the backend up" flag.
 *
 * Both are caches with the same reason to exist: a widget update runs on a
 * broadcast, and blocking it on an HTTP round trip would leave a blank tile for
 * as long as the network takes. The tile paints from cache, then the probe
 * refreshes it — and when the laptop is off, the cache is what keeps the machine
 * names on screen instead of collapsing to a generic button.
 */
object WidgetPrefs {
    private const val TAG = "JarvisWidgetPrefs"
    private const val PREFS = "widgets"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The machine list is global, not per widget: every desktop tile shows the same set. */
    fun saveTargets(ctx: Context, targets: List<DesktopTarget>) {
        val arr = JSONArray()
        targets.forEach { t ->
            arr.put(JSONObject().put("label", t.label).put("host", t.host).put("uuid", t.uuid ?: ""))
        }
        prefs(ctx).edit().putString("targets", arr.toString()).apply()
    }

    fun targets(ctx: Context): List<DesktopTarget> {
        val raw = prefs(ctx).getString("targets", null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                DesktopTarget(
                    label = o.optString("label"),
                    host = o.optString("host"),
                    uuid = o.optString("uuid").ifBlank { null },
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "bad target cache: ${e.message}")
            emptyList()
        }
    }

    fun setBackendOnline(ctx: Context, online: Boolean) {
        prefs(ctx).edit().putBoolean("backendOnline", online).putLong("backendAt", System.currentTimeMillis()).apply()
    }

    fun backendOnline(ctx: Context): Boolean = prefs(ctx).getBoolean("backendOnline", false)
}
