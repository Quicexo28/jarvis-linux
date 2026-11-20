package com.jarvis.companion.wall

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Keystone de hardware del proyector (afecta a TODO lo que se ve).
 *
 * Hace la misma llamada que el menú del fabricante (com.zh.tcorrection):
 * `vendor.display.config@1.0::IDisplayConfig.keystoneSetCoordinates` (HIDL,
 * transacción 36). Va por reflexión sobre HwBinder/HwParcel/HwBlob porque son
 * API ocultas. Necesita una exención de API ocultas (ver [ensureHiddenApi]).
 *
 * Los valores se guardan en las prefs de la app y se reaplican al arrancar:
 * NO se escriben las `persist.display.keystone_*` del fabricante.
 *
 * Esquinas: cuántos píxeles de panel se mete cada una hacia dentro (x, y ≥ 0).
 * Orden TL, TR, BL, BR. Zoom: 100 = neutro.
 */
object Keystone {
    private const val TAG = "WallKeystone"
    private const val PREFS = "wall_keystone"
    private const val IFACE = "vendor.display.config@1.0::IDisplayConfig"
    private const val TX_SET = 36
    const val PANEL_W = 1280
    const val PANEL_H = 720
    /** Tope por esquina: una imagen deformada de más no se puede leer ni arreglar a ciegas. */
    private const val MAX_X = PANEL_W * 40 / 100
    private const val MAX_Y = PANEL_H * 40 / 100

    data class State(val zoomH: Float, val zoomV: Float, val ins: IntArray) {
        fun toJson(): JSONObject = JSONObject()
            .put("zoomH", zoomH.toDouble()).put("zoomV", zoomV.toDouble())
            .put("corners", JSONArray().apply { for (i in 0 until 4) put(JSONArray().put(ins[i * 2]).put(ins[i * 2 + 1])) })
            .put("panel", JSONObject().put("w", PANEL_W).put("h", PANEL_H))
    }

    private val NEUTRAL = State(100f, 100f, IntArray(8))

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(ctx: Context): State {
        val p = prefs(ctx)
        val ins = IntArray(8) { p.getInt("i$it", 0) }
        return State(p.getFloat("zh", 100f), p.getFloat("zv", 100f), ins)
    }

    private fun save(ctx: Context, s: State) {
        prefs(ctx).edit().apply {
            putFloat("zh", s.zoomH); putFloat("zv", s.zoomV)
            for (i in 0 until 8) putInt("i$i", s.ins[i])
        }.commit()
    }

    /** Mezcla un JSON parcial (`zoomH`, `zoomV`, `corners`) sobre el estado y lo valida. */
    fun parse(cur: State, body: JSONObject): State {
        val ins = cur.ins.copyOf()
        body.optJSONArray("corners")?.let { c ->
            require(c.length() == 4) { "corners necesita 4 esquinas" }
            for (i in 0 until 4) {
                val pt = c.getJSONArray(i)
                ins[i * 2] = pt.getInt(0).also { require(it in 0..MAX_X) { "x fuera de rango 0..$MAX_X" } }
                ins[i * 2 + 1] = pt.getInt(1).also { require(it in 0..MAX_Y) { "y fuera de rango 0..$MAX_Y" } }
            }
        }
        val zh = if (body.has("zoomH")) body.getDouble("zoomH").toFloat() else cur.zoomH
        val zv = if (body.has("zoomV")) body.getDouble("zoomV").toFloat() else cur.zoomV
        require(zh in 50f..100f && zv in 50f..100f) { "zoom fuera de rango 50..100" }
        return State(zh, zv, ins)
    }

    /** Aplica al hardware y guarda. Lanza excepción si el HAL no responde. */
    fun set(ctx: Context, s: State) {
        halSet(s)
        save(ctx, s)
    }

    fun reset(ctx: Context): State { set(ctx, NEUTRAL); return NEUTRAL }

    /** Reaplica lo guardado (arranque). Devuelve true si el HAL aceptó. */
    fun restore(ctx: Context): Boolean = try { halSet(load(ctx)); true } catch (e: Throwable) {
        Log.w(TAG, "restore: ${e.javaClass.simpleName}: ${e.message}"); false
    }

    /**
     * HwBinder y compañía son API ocultas: sin una excepción la reflexión falla.
     * Se declara solo para esas 4 clases con WRITE_SECURE_SETTINGS
     * (`hidden_api_blacklist_exemptions`); el sistema la lee al crear el proceso,
     * así que surte efecto tras reiniciar la app. Es un ajuste del dispositivo.
     */
    private const val EXEMPT = "Landroid/os/HwBinder;,Landroid/os/HwParcel;,Landroid/os/HwBlob;,Landroid/os/IHwBinder;"

    fun ensureHiddenApi(ctx: Context) {
        try {
            val cr = ctx.contentResolver
            if (android.provider.Settings.Global.getString(cr, "hidden_api_blacklist_exemptions") != EXEMPT) {
                android.provider.Settings.Global.putString(cr, "hidden_api_blacklist_exemptions", EXEMPT)
                Log.i(TAG, "exención de API ocultas para HwBinder (efecto al reiniciar la app)")
            }
        } catch (e: Exception) { Log.w(TAG, "exención de API ocultas: ${e.message}") }
    }

    private fun halSet(s: State) {
        val hwBinder = Class.forName("android.os.HwBinder")
        val hwParcel = Class.forName("android.os.HwParcel")
        val hwBlob = Class.forName("android.os.HwBlob")
        val ihw = Class.forName("android.os.IHwBinder")
        val binder = hwBinder.getMethod("getService", String::class.java, String::class.java).invoke(null, IFACE, "default")
            ?: error("IDisplayConfig no registrado")

        fun point(x: Int, y: Int): Any {
            val b = hwBlob.getConstructor(Int::class.javaPrimitiveType).newInstance(8)
            hwBlob.getMethod("putInt32", Long::class.javaPrimitiveType, Int::class.javaPrimitiveType).invoke(b, 0L, x)
            hwBlob.getMethod("putInt32", Long::class.javaPrimitiveType, Int::class.javaPrimitiveType).invoke(b, 4L, y)
            return b
        }
        // Mismo mapeo que AwTvDisplayManager.setKeystoreValue (orientación por defecto).
        val w = PANEL_W - 1; val h = PANEL_H - 1
        val i = s.ins
        val pts = listOf(
            point(i[0], i[1]),                 // TL
            point(w - i[2], i[3]),             // TR
            point(i[4], h - i[5]),             // BL
            point(w - i[6], h - i[7]),         // BR
        )

        val req = hwParcel.getConstructor().newInstance()
        val rep = hwParcel.getConstructor().newInstance()
        try {
            hwParcel.getMethod("writeInterfaceToken", String::class.java).invoke(req, IFACE)
            hwParcel.getMethod("writeFloat", Float::class.javaPrimitiveType).invoke(req, s.zoomH)
            hwParcel.getMethod("writeFloat", Float::class.javaPrimitiveType).invoke(req, s.zoomV)
            for (p in pts) hwParcel.getMethod("writeBuffer", hwBlob).invoke(req, p)
            ihw.getMethod("transact", Int::class.javaPrimitiveType, hwParcel, hwParcel, Int::class.javaPrimitiveType)
                .invoke(binder, TX_SET, req, rep, 0)
            hwParcel.getMethod("verifySuccess").invoke(rep)
            val rc = hwParcel.getMethod("readInt32").invoke(rep) as Int
            check(rc == 0) { "el HAL devolvió $rc" }
        } finally {
            runCatching { hwParcel.getMethod("release").invoke(rep) }
        }
    }
}
