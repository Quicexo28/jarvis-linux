package com.jarvis.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.jarvis.companion.widget.DesktopTarget
import com.jarvis.companion.widget.WidgetPrefs

/**
 * Restart the reporter after a reboot. Android 15 restricts starting a
 * location-type foreground service from BOOT_COMPLETED; if the system rejects
 * it the user just opens the app once and it resumes.
 *
 * En **modo proyector** hace lo contrario: no arranca el reporter (una pantalla
 * no reporta bateria ni ubicacion) y lo unico que hace es abrir el stream.
 * Es la pieza que sostiene todo el encendido automatico: la depuracion
 * inalambrica de Android 14 sale DESACTIVADA en cada arranque, asi que el
 * backend NO puede alcanzar el proyector por ADB recien encendido — el unico
 * que puede iniciar el stream es el propio dispositivo.
 */
class BootReceiver : BroadcastReceiver() {
    private companion object {
        const val TAG = "JarvisBoot"
        /** Techo de espera a que la wifi levante. `goAsync` da ~10 s antes de ANR. */
        const val NET_WAIT_MS = 8000L
        const val NET_POLL_MS = 1000L
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        // El modo proyector se comprueba ANTES de `isConfigured`: con un UUID
        // fijado no hace falta emparejamiento, y ese es justo el caso normal.
        if (Config.projectorMode(ctx)) {
            projectAtBoot(ctx)
            return
        }
        if (!Config.isConfigured(ctx)) return
        try {
            ReporterService.start(ctx)
        } catch (e: Exception) {
            Log.w(TAG, "cannot start on boot: ${e.message}")
        }
    }

    /**
     * Abre Moonlight contra la maquina elegida, en cuanto haya red.
     *
     * Se prefiere el UUID **cacheado** (`WidgetPrefs`) antes que descubrirlo: en
     * BOOT_COMPLETED la wifi suele no estar lista, y el cache convierte el caso
     * normal en cero peticiones de red. El descubrimiento queda solo para el
     * primer arranque tras configurar.
     *
     * Ojo: lanzar una activity desde segundo plano esta prohibido desde Android
     * 10 salvo exencion. La que usamos es SYSTEM_ALERT_WINDOW ("mostrar sobre
     * otras apps"), que se concede una vez con:
     *   adb shell appops set com.jarvis.companion SYSTEM_ALERT_WINDOW allow
     * Sin ella el sistema descarta el arranque EN SILENCIO y la pared se queda
     * en el launcher.
     */
    private fun projectAtBoot(ctx: Context) {
        val fixed = Config.projectorUuid(ctx)
        if (fixed.isNotEmpty()) {
            // Camino normal: cero red, cero backend, cero espera.
            val mode = Moonlight.launch(ctx, fixed, Config.projectorAppId(ctx).ifBlank { null })
            Log.i(TAG, "proyector: uuid fijo -> $mode")
            return
        }
        val pending = goAsync()
        Thread {
            try {
                val cached = pick(WidgetPrefs.targets(ctx), Config.projectorTarget(ctx))
                val target = cached ?: discoverWhenOnline(ctx)
                val mode = Moonlight.launch(ctx, target?.uuid)
                Log.i(TAG, "proyector: ${target?.label ?: "sin destino"} -> $mode")
            } catch (e: Exception) {
                Log.w(TAG, "proyector: fallo al arrancar el stream: ${e.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }

    /** La maquina pedida por etiqueta; si no se pidio ninguna, la primera. */
    private fun pick(targets: List<DesktopTarget>, label: String): DesktopTarget? =
        if (label.isBlank()) targets.firstOrNull()
        else targets.firstOrNull { it.label.equals(label, ignoreCase = true) }

    /** Sondea hasta que el backend conteste, con techo; null si no llega a tiempo. */
    private fun discoverWhenOnline(ctx: Context): DesktopTarget? {
        val deadline = System.currentTimeMillis() + NET_WAIT_MS
        while (System.currentTimeMillis() < deadline) {
            com.jarvis.companion.widget.DesktopWidget.discover(ctx)
            val target = pick(WidgetPrefs.targets(ctx), Config.projectorTarget(ctx))
            if (target != null) return target
            Thread.sleep(NET_POLL_MS)
        }
        // Sin destino, Moonlight abre su lista de PCs: peor que el stream, mejor
        // que quedarse en el launcher sin nada.
        return null
    }
}
