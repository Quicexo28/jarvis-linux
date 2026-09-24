package com.jarvis.companion.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import kotlin.math.min

/** Bits every widget provider needs: sizing in px and a click PendingIntent. */
internal object Widgets

/**
 * The widget's current size in px.
 *
 * A widget has two sizes (portrait and landscape) and the launcher reports both;
 * MIN_WIDTH/MAX_HEIGHT is the portrait box, MAX_WIDTH/MIN_HEIGHT the landscape
 * one. Taking the smaller of each keeps a Canvas bitmap from being upscaled
 * after a rotation, which is what makes hand-drawn widgets look soft.
 */
internal fun widgetSizePx(ctx: Context, options: Bundle?): Pair<Int, Int> {
    val d = ctx.resources.displayMetrics.density
    val minW = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
    val maxW = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0) ?: 0
    val minH = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
    val maxH = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0) ?: 0
    val wDp = listOf(minW, maxW).filter { it > 0 }.minOrNull() ?: 110
    val hDp = listOf(minH, maxH).filter { it > 0 }.minOrNull() ?: 110
    // Cap: a RemoteViews bitmap crosses a Binder transaction whose ceiling is
    // about 1 MB, and 512x512 in ARGB_8888 is exactly that — enough to make the
    // update fail rather than draw. 320 px keeps a 2x2 tile sharp at ~330 KB.
    return Pair(min((wDp * d).toInt(), 320), min((hDp * d).toInt(), 320))
}

internal fun activityPendingIntent(ctx: Context, requestCode: Int, intent: Intent): PendingIntent =
    PendingIntent.getActivity(
        ctx, requestCode, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

internal fun widgetIds(ctx: Context, provider: Class<*>): IntArray =
    AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, provider))
