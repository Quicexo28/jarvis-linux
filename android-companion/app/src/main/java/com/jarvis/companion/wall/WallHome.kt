package com.jarvis.companion.wall

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import com.jarvis.companion.Config

/**
 * La pared como HOME del proyector, con red de seguridad: si el HOME crashea
 * en bucle con ADB apagado el aparato queda inservible, así que todo lo que
 * decide pasa por aquí y cae al launcher de fábrica ante la duda.
 */
object WallHome {
    private const val TAG = "WallHome"
    private const val PREFS = "wall_home"
    /** El de fábrica del HA109 (role HOME original). Se descubre si cambia. */
    private const val FACTORY = "com.zhenhuo.firelauncher"

    // Detector de crashes: 3 muertes en 2 min = bucle. 60 s estable lo resetea.
    private const val CRASH_WINDOW_MS = 120_000L
    private const val CRASH_LIMIT = 3
    const val STABLE_MS = 60_000L

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** La pared está viva EN ESTE proceso (tras un crash el proceso es nuevo y vale false). */
    @Volatile var wallAlive = false

    /**
     * Si la última WallActivity quedó "corriendo" sin pasar por onStop y no
     * vive en este proceso, el proceso murió con ella delante: un crash
     * (Java o nativo: driver GL, MediaCodec…). commit() y no apply(): justo
     * después puede morir otra vez.
     */
    fun noteUncleanExit(ctx: Context) {
        val p = prefs(ctx)
        if (!p.getBoolean("running", false) || wallAlive) return
        val now = System.currentTimeMillis()
        val list = crashes(ctx).filter { now - it < CRASH_WINDOW_MS } + now
        p.edit().putBoolean("running", false).putString("crashes", list.joinToString(",")).commit()
        Log.w(TAG, "la pared murió sin cerrar: ${list.size} en ${CRASH_WINDOW_MS / 1000} s")
    }

    fun onWallStart(ctx: Context) {
        wallAlive = true
        prefs(ctx).edit().putBoolean("running", true).commit()
    }

    /** onStop: en segundo plano, que el sistema la mate por RAM no es un crash. */
    fun onWallStop(ctx: Context) {
        prefs(ctx).edit().putBoolean("running", false).commit()
    }

    fun onWallDestroy() { wallAlive = false }

    fun markStable(ctx: Context) {
        prefs(ctx).edit().remove("crashes").apply()
    }

    fun crashes(ctx: Context): List<Long> =
        prefs(ctx).getString("crashes", "")!!.split(',').mapNotNull { it.toLongOrNull() }

    fun inCrashLoop(ctx: Context): Boolean {
        val now = System.currentTimeMillis()
        return crashes(ctx).count { now - it < CRASH_WINDOW_MS } >= CRASH_LIMIT
    }

    /** Extra de depuración: simula n crashes para probar el fallback sin romper nada. */
    fun simulateCrashes(ctx: Context, n: Int) {
        val now = System.currentTimeMillis()
        val list = List(n.coerceIn(0, 10)) { now - it * 1000L }
        prefs(ctx).edit().putString("crashes", list.joinToString(",")).commit()
    }

    fun resetCrashes(ctx: Context) {
        prefs(ctx).edit().remove("crashes").putBoolean("running", false).commit()
    }

    /** ¿Debe el HOME ir a la pared? */
    fun shouldShowWall(ctx: Context): Boolean =
        Config.wallMode(ctx) && Config.homeMode(ctx) && !inCrashLoop(ctx)

    /**
     * El trampolín solo existe como candidato a HOME con wallMode && homeMode.
     * En la tablet y el móvil (mismo APK) sigue deshabilitado: declararlo
     * habilitado haría que el sistema preguntara qué launcher usar.
     */
    fun syncTrampoline(ctx: Context) {
        val want = Config.wallMode(ctx) && Config.homeMode(ctx)
        val cn = ComponentName(ctx, HomeTrampolineActivity::class.java)
        val state = if (want) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        if (ctx.packageManager.getComponentEnabledSetting(cn) != state) {
            ctx.packageManager.setComponentEnabledSetting(cn, state, PackageManager.DONT_KILL_APP)
            Log.i(TAG, "trampolín HOME ${if (want) "habilitado" else "deshabilitado"}")
        }
    }

    /** Launcher de fábrica: el que no somos nosotros ni el FallbackHome de Settings. */
    fun originalLauncher(ctx: Context): ComponentName? {
        val pm = ctx.packageManager
        val homes = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
            .map { it.activityInfo }
            .filter { it.packageName != ctx.packageName && !it.name.endsWith("FallbackHome") }
        val pick = homes.firstOrNull { it.packageName == FACTORY } ?: homes.firstOrNull()
        return pick?.let { ComponentName(it.packageName, it.name) }
    }

    fun launchOriginal(ctx: Context, why: String): Boolean {
        val cn = originalLauncher(ctx)
        Log.i(TAG, "launcher original ($why): ${cn?.flattenToShortString()}")
        if (cn == null) return false
        return try {
            ctx.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setComponent(cn)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
            true
        } catch (e: Exception) {
            Log.e(TAG, "no se pudo abrir el launcher original: ${e.message}")
            false
        }
    }
}
