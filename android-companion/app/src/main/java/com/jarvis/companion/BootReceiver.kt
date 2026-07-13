package com.jarvis.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Restart the reporter after a reboot. Android 15 restricts starting a
 * location-type foreground service from BOOT_COMPLETED; if the system rejects
 * it the user just opens the app once and it resumes.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!Config.isConfigured(ctx)) return
        try {
            ReporterService.start(ctx)
        } catch (e: Exception) {
            Log.w("JarvisBoot", "cannot start on boot: ${e.message}")
        }
    }
}
