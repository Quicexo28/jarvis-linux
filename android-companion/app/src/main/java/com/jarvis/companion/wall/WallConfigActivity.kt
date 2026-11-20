package com.jarvis.companion.wall

import android.app.Activity
import android.os.Bundle
import android.util.Log
import com.jarvis.companion.Config
import com.jarvis.companion.ReporterService

/**
 * Configuración por ADB, una sola vez:
 *
 *   adb shell am start -n com.jarvis.companion/.wall.WallConfigActivity \
 *     --ez wallMode true --ez projectorMode true \
 *     --es wallUrl ws://192.168.1.29:8450/wall --es wallToken <token>
 *
 * Otros extras: --ez homeMode false (la pared deja de ser el HOME),
 * --ez keepAdbWifi false, --ei simulateCrashes 3 / --ez resetCrashes true
 * (probar el fallback del HOME), --ez open false (no abrir la pared).
 *
 * Exportada pero protegida con WRITE_SECURE_SETTINGS (manifest): la tiene el
 * shell de adb y ninguna app normal, así que otra app del dispositivo no puede
 * redirigir la pared a otro server. Sin UI: aplica, abre la pared y se va.
 */
class WallConfigActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val x = intent.extras
        if (x != null) {
            val enabled = if (x.containsKey("wallMode")) x.getBoolean("wallMode") else Config.wallMode(this)
            Config.setWall(this, enabled, x.getString("wallUrl"), x.getString("wallToken"))
            if (x.containsKey("projectorMode")) Config.setProjectorFlag(this, x.getBoolean("projectorMode"))
            if (x.containsKey("homeMode")) Config.setHomeMode(this, x.getBoolean("homeMode"))
            if (x.containsKey("keepAdbWifi")) Config.setKeepAdbWifi(this, x.getBoolean("keepAdbWifi"))
            // Depuración del detector de crashes del HOME: --ei simulateCrashes 3
            // obliga al trampolín a mandar al launcher de fábrica.
            if (x.containsKey("simulateCrashes")) WallHome.simulateCrashes(this, x.getInt("simulateCrashes"))
            if (x.getBoolean("resetCrashes", false)) WallHome.resetCrashes(this)
            // Una pantalla no reporta batería ni ubicación (igual que el modo proyector).
            if (enabled) ReporterService.stop(this)
            Log.i("WallConfig", "wallMode=$enabled projectorMode=${Config.projectorMode(this)} homeMode=${Config.homeMode(this)} " +
                "keepAdbWifi=${Config.keepAdbWifi(this)} crashes=${WallHome.crashes(this).size} url=${Config.wallUrl(this)} " +
                "token=${if (Config.wallToken(this).isEmpty()) "vacío" else "puesto"}")
        }
        WallHome.syncTrampoline(this)
        // `--ez open false`: solo configurar (p. ej. para probar el trampolín después).
        val open = x?.getBoolean("open", true) ?: true
        if (Config.wallMode(this)) {
            if (open) WallService.startWithActivity(this, "config") else WallService.start(this)
        } else {
            WallService.stop(this)
        }
        finish()
    }
}
