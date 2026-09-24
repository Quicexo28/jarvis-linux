package com.jarvis.companion.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.jarvis.companion.Api
import com.jarvis.companion.R
import com.jarvis.companion.Tailscale
import java.util.concurrent.Executors

/**
 * 4x2 Tailscale tile: what the tray toggle does, but visible from the home
 * screen — state, tailnet address, and one button to flip it.
 *
 * State is read from the OS (a 100.64/10 address exists only while the tunnel is
 * up), so it is correct the instant the tile draws, with no dependency on
 * Tailscale answering anything. The second line answers the question that
 * actually follows ("…and does Jarvis respond over it?") from the cached probe.
 *
 * Body tap opens Tailscale; only the round button toggles, so brushing the
 * widget cannot drop the tunnel.
 */
class TailscaleWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        ids.forEach { render(ctx, mgr, it) }
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action != AppWidgetManager.ACTION_APPWIDGET_UPDATE) return
        val pending = goAsync()
        EXEC.execute {
            try {
                WidgetPrefs.setBackendOnline(ctx, Api.health(ctx))
                refreshAll(ctx)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private val EXEC = Executors.newSingleThreadExecutor()

        fun refreshAll(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            widgetIds(ctx, TailscaleWidget::class.java).forEach { render(ctx, mgr, it) }
        }

        private fun render(ctx: Context, mgr: AppWidgetManager, id: Int) {
            val installed = Tailscale.installed(ctx)
            val ip = Tailscale.tailnetIp()
            val on = ip != null
            val views = RemoteViews(ctx.packageName, R.layout.widget_tailscale)

            views.setTextViewText(
                R.id.ts_state,
                ctx.getString(
                    when {
                        !installed -> R.string.widget_ts_missing
                        on -> R.string.widget_ts_on
                        else -> R.string.widget_ts_off
                    },
                ),
            )
            views.setTextColor(
                R.id.ts_dot,
                ctx.getColor(if (on) R.color.jarvis_ok else if (installed) R.color.jarvis_faint else R.color.jarvis_bad),
            )
            views.setTextViewText(R.id.ts_ip, ip ?: ctx.getString(R.string.widget_ts_no_ip))
            views.setTextColor(R.id.ts_ip, ctx.getColor(if (on) R.color.jarvis_text else R.color.jarvis_faint))
            views.setTextViewText(
                R.id.ts_sub,
                ctx.getString(
                    when {
                        !on -> R.string.widget_ts_sub_unknown
                        WidgetPrefs.backendOnline(ctx) -> R.string.widget_ts_sub_online
                        else -> R.string.widget_ts_sub_offline
                    },
                ),
            )

            views.setInt(R.id.ts_power, "setBackgroundResource",
                if (on) R.drawable.widget_tile_accent else R.drawable.widget_tile_muted)
            views.setImageViewResource(R.id.ts_power_icon,
                if (on) R.drawable.ic_power else R.drawable.ic_power_dim)

            // Distinct request codes: same-code PendingIntents to the same
            // component would collapse into one and both taps would toggle.
            views.setOnClickPendingIntent(
                R.id.ts_power,
                activityPendingIntent(ctx, id * 10, WidgetActionActivity.toggleTailscale(ctx, !on)),
            )
            views.setOnClickPendingIntent(
                R.id.ts_root,
                activityPendingIntent(ctx, id * 10 + 1, WidgetActionActivity.openTailscale(ctx)),
            )
            mgr.updateAppWidget(id, views)
        }
    }
}
