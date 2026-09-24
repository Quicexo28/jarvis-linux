package com.jarvis.companion

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log

/**
 * Hand off to Moonlight.
 *
 * Moonlight has no URI scheme for "connect to host X" (moonlight-android#668),
 * but its `ShortcutTrampoline` activity — the one behind the launcher shortcuts
 * it creates — is exported and takes a `UUID` extra (plus an optional `AppId`).
 * The UUID is the `uniqueid` Sunshine reports on `http://host:47989/serverinfo`,
 * which the backend discovers and hands to the widget, so a widget tap lands on
 * the right PC instead of just opening the app.
 *
 * Everything degrades: no UUID, a renamed trampoline or a refused start all fall
 * back to launching Moonlight normally, and a missing Moonlight opens the store.
 */
object Moonlight {
    private const val TAG = "JarvisMoonlight"
    private const val TRAMPOLINE = "com.limelight.ShortcutTrampoline"

    /** Moonlight ships under two package names; the fork is common on tablets. */
    val PACKAGES = listOf("com.limelight", "com.limelight.noir")

    fun installedPackage(ctx: Context): String? = PACKAGES.firstOrNull { pkg ->
        try {
            ctx.packageManager.getPackageInfo(pkg, 0); true
        } catch (e: PackageManager.NameNotFoundException) { false }
    }

    /** "host" = went straight to that PC, "app" = Moonlight's PC list, "store", "error". */
    fun launch(ctx: Context, uuid: String? = null, appId: String? = null): String {
        val pkg = installedPackage(ctx)
        if (pkg == null) {
            openStore(ctx, PACKAGES[0])
            return "store"
        }
        if (!uuid.isNullOrBlank()) {
            val direct = Intent()
                .setClassName(pkg, TRAMPOLINE)
                .putExtra("UUID", uuid)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (!appId.isNullOrBlank()) direct.putExtra("AppId", appId)
            try {
                ctx.startActivity(direct)
                return "host"
            } catch (e: Exception) {
                Log.w(TAG, "trampoline refused ($uuid): ${e.message}")
            }
        }
        val intent = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: return "error"
        return try {
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            "app"
        } catch (e: Exception) {
            "error"
        }
    }

    private fun openStore(ctx: Context, pkg: String) {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            ctx.startActivity(market)
        } catch (e: Exception) {
            try {
                ctx.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            } catch (e2: Exception) {
                Log.w(TAG, "no store for $pkg")
            }
        }
    }
}
