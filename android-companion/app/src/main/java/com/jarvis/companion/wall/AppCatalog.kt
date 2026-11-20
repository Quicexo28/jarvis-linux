package com.jarvis.companion.wall

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream

/**
 * Apps nativas del proyector: las de LEANBACK_LAUNCHER (las que enseña el
 * launcher de TV). Visibles gracias al `<queries>` del manifest; sin él,
 * Android 11+ devolvería una lista vacía sin error.
 */
object AppCatalog {
    private const val TAG = "WallApps"

    data class App(val pkg: String, val label: String)

    fun list(ctx: Context): List<App> {
        val pm = ctx.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
        return pm.queryIntentActivities(intent, 0)
            .asSequence()
            .map { it.activityInfo }
            .filter { it.packageName != ctx.packageName }
            .distinctBy { it.packageName }
            .map { App(it.packageName, it.loadLabel(pm).toString()) }
            .sortedBy { it.label.lowercase() }
            .toList()
    }

    /** Leanback primero (lo que abre el launcher de TV); el launch normal de respaldo. */
    fun launch(ctx: Context, pkg: String): Boolean {
        val pm = ctx.packageManager
        val intent = pm.getLeanbackLaunchIntentForPackage(pkg) ?: pm.getLaunchIntentForPackage(pkg)
        if (intent == null) {
            Log.w(TAG, "sin launch intent para $pkg")
            return false
        }
        return try {
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
            true
        } catch (e: Exception) {
            Log.w(TAG, "no se pudo abrir $pkg: ${e.message}")
            false
        }
    }

    /** Banner de TV (320x180) si la app lo trae; si no, el icono. Para el mosaico. */
    fun tileDrawable(ctx: Context, pkg: String): Drawable? {
        val pm = ctx.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER).setPackage(pkg)
        val info = pm.queryIntentActivities(intent, 0).firstOrNull()?.activityInfo
        return try {
            info?.loadBanner(pm) ?: pm.getApplicationBanner(pkg) ?: info?.loadIcon(pm) ?: pm.getApplicationIcon(pkg)
        } catch (e: Exception) { null }
    }

    /** Icono cuadrado en PNG base64 (≤ 256 px, contrato `icon`). */
    fun iconPngBase64(ctx: Context, pkg: String, size: Int = 192): String? {
        val pm = ctx.packageManager
        val d = try { pm.getApplicationIcon(pkg) } catch (e: Exception) { return null }
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        d.setBounds(0, 0, size, size)
        d.draw(c)
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
