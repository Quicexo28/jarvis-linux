package com.jarvis.companion.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews
import com.jarvis.companion.Api
import com.jarvis.companion.R
import com.jarvis.companion.ui.Holo
import com.jarvis.companion.ui.HoloState
import com.jarvis.companion.voice.VoiceActivity
import java.util.concurrent.Executors
import kotlin.random.Random

/**
 * 2x2 hologram. Tapping it does NOT open the app: it starts listening, because
 * this is meant to be the tablet's voice assistant, not a launcher icon.
 *
 * The tile is one Canvas bitmap ([Holo]) so it is the same drawing the overlay
 * animates. Cyan means the backend answered the last health probe, amber-grey
 * means it did not — the only status worth carrying on the home screen, since
 * nothing else here works when the laptop is off.
 */
class JarvisWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        ids.forEach { render(ctx, mgr, it) }
    }

    override fun onAppWidgetOptionsChanged(
        ctx: Context, mgr: AppWidgetManager, id: Int, newOptions: Bundle?,
    ) {
        render(ctx, mgr, id)
    }

    /**
     * Health lives on a broadcast that must return fast, so the tile paints from
     * cache first and `goAsync` keeps the process alive for the probe that
     * corrects it. Without goAsync the process can be frozen mid-request and the
     * tile keeps a stale colour until the next 30 min tick.
     */
    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action != AppWidgetManager.ACTION_APPWIDGET_UPDATE) return
        val pending = goAsync()
        EXEC.execute {
            try {
                val online = Api.health(ctx)
                WidgetPrefs.setBackendOnline(ctx, online)
                refreshAll(ctx)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private val EXEC = Executors.newSingleThreadExecutor()

        /** Called after anything that changes reachability (app resume, reporter tick). */
        fun refreshAll(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            widgetIds(ctx, JarvisWidget::class.java).forEach { render(ctx, mgr, it) }
        }

        private fun render(ctx: Context, mgr: AppWidgetManager, id: Int) {
            val (w, h) = widgetSizePx(ctx, mgr.getAppWidgetOptions(id))
            val online = WidgetPrefs.backendOnline(ctx)
            val bmp = Holo.bitmap(
                wPx = w, hPx = h,
                density = ctx.resources.displayMetrics.density,
                state = if (online) HoloState.ONLINE else HoloState.OFFLINE,
                // A fixed phase would make every redraw identical; a random one
                // means the arcs sit somewhere new each time, which reads as a
                // live projection rather than a printed icon.
                phase = Random.nextFloat(),
                level = 0f,
                label = "JARVIS",
                caption = ctx.getString(
                    if (online) R.string.widget_jarvis_ready else R.string.widget_jarvis_offline,
                ),
            )
            val views = RemoteViews(ctx.packageName, R.layout.widget_jarvis)
            views.setImageViewBitmap(R.id.holo, bmp)
            views.setOnClickPendingIntent(
                R.id.holo_root,
                activityPendingIntent(
                    ctx, id,
                    Intent(ctx, VoiceActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                ),
            )
            mgr.updateAppWidget(id, views)
        }
    }
}
