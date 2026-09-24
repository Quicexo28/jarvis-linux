package com.jarvis.companion

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri

/**
 * App configuration persisted in SharedPreferences: backend base URL, the
 * pairing token, the device name reported to Jarvis and the reporting interval
 * in minutes.
 *
 * One token does both jobs: it authenticates the WebView against the remote UI
 * and the background reporter against the mobile ingest endpoints (the backend
 * accepts JARVIS_WEB_TOKEN on both), so pairing is a single paste of the QR URL.
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

    /**
     * Modo proyector: al arrancar, lanzar Moonlight y nada mas.
     *
     * El proyector es una PANTALLA — no reporta bateria ni ubicacion ni escucha,
     * asi que en este modo el [ReporterService] NO arranca. Existe porque la
     * depuracion inalambrica de Android 14 sale DESACTIVADA en cada arranque:
     * el backend no puede alcanzarlo por ADB recien encendido, de modo que el
     * unico que puede iniciar el stream es el propio dispositivo.
     */
    fun projectorMode(ctx: Context): Boolean = prefs(ctx).getBoolean("projectorMode", false)

    /** Etiqueta de la maquina a proyectar; vacio = la primera descubierta. */
    fun projectorTarget(ctx: Context): String = prefs(ctx).getString("projectorTarget", "")!!.trim()

    /**
     * UUID de Sunshine al que entrar directamente.
     *
     * Con esto puesto el proyector NO necesita ni token ni backend: el arranque
     * es `Moonlight.launch(uuid)` y punto. Es lo correcto para una pantalla —
     * darle el token web de Jarvis seria regalar acceso completo a la API a un
     * aparato que solo tiene que mostrar pixeles, y ademas ataria el arranque a
     * que el portatil ya estuviese despierto.
     */
    fun projectorUuid(ctx: Context): String = prefs(ctx).getString("projectorUuid", "")!!.trim()

    /**
     * Id de la app de Sunshine (normalmente "Desktop").
     *
     * Sin el, el trampolin de Moonlight se queda en la LISTA de apps de esa
     * maquina y hace falta pulsar OK con el mando — que es exactamente el paso
     * manual que este modo existe para eliminar. Con el, entra al stream.
     */
    fun projectorAppId(ctx: Context): String = prefs(ctx).getString("projectorAppId", "")!!.trim()

    fun setProjectorMode(ctx: Context, enabled: Boolean, uuid: String = "", appId: String = "", target: String = "") {
        prefs(ctx).edit()
            .putBoolean("projectorMode", enabled)
            .putString("projectorUuid", uuid.trim())
            .putString("projectorAppId", appId.trim())
            .putString("projectorTarget", target.trim())
            .apply()
    }

    fun isConfigured(ctx: Context): Boolean =
        baseUrl(ctx).startsWith("http") && token(ctx).isNotEmpty()

    /** URL the WebView loads: the remote app, already authenticated. */
    fun webUrl(ctx: Context): String =
        baseUrl(ctx) + "/?token=" + Uri.encode(token(ctx)) + "&ui=mobile"

    fun save(ctx: Context, baseUrl: String, token: String, device: String, intervalMin: Int) {
        prefs(ctx).edit()
            .putString("baseUrl", baseUrl.trim().trimEnd('/'))
            .putString("token", token.trim())
            .putString("device", device.trim())
            .putInt("intervalMin", intervalMin)
            .apply()
    }

    /**
     * Split a pasted pairing URL into (baseUrl, token). Accepts the QR URL
     * ("https://host:8443/?token=abc&ui=full"), a bare backend URL, or either
     * with trailing slashes. Token is null when the URL carries none.
     */
    fun parsePairing(input: String): Pair<String, String?> {
        val raw = input.trim()
        if (!raw.startsWith("http")) return Pair(raw.trimEnd('/'), null)
        return try {
            val uri = Uri.parse(raw)
            val port = if (uri.port > 0) ":${uri.port}" else ""
            val base = "${uri.scheme}://${uri.host}$port"
            Pair(base, uri.getQueryParameter("token"))
        } catch (e: Exception) {
            Pair(raw.trimEnd('/'), null)
        }
    }
}
