package com.jarvis.companion.wall

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log

/**
 * HOME del proyector. Mínimo a propósito (sin GL, sin red, sin layout): es lo
 * que el sistema relanza cada vez que se pulsa HOME o no queda nada delante, y
 * si fallara en bucle con ADB apagado el proyector quedaría inservible.
 *
 * Decide y se va: el inicio del proyector (LauncherActivity) si wallMode && homeMode y no hay bucle de crashes;
 * si no (o ante cualquier excepción), el launcher de fábrica.
 * Deshabilitada en el manifest; WallHome.syncTrampoline la habilita solo en
 * el proyector.
 */
class HomeTrampolineActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            WallHome.noteUncleanExit(this)
            if (WallHome.shouldShowWall(this)) {
                startActivity(Intent(this, LauncherActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
            } else {
                WallHome.launchOriginal(this, if (WallHome.inCrashLoop(this)) "bucle de crashes" else "modo HOME apagado")
            }
        } catch (e: Throwable) {
            Log.e("WallHome", "trampolín: ${e.message}")
            runCatching { WallHome.launchOriginal(this, "excepción") }
        }
        finish()
    }
}
