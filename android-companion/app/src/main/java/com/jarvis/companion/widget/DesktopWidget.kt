package com.jarvis.companion.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.jarvis.companion.Api
import com.jarvis.companion.Config
import com.jarvis.companion.R
import java.util.concurrent.Executors

/**
 * 1x2 launcher pill holding EVERY machine that can stream, one tappable zone
 * each: left half streams from one PC, right half from the other. Moonlight's own
 * shortcuts need one icon per machine and look like nothing else on the screen;
 * this is both of them in one tile, in the Jarvis palette.
 *
 * The list is discovered, never configured: the backend already probes the tailnet
 * for Sunshine hosts and reports each one's UUID, so the widget asks and lays out
 * whatever came back. That is also why there is no config screen — there is
 * nothing left for the user to pick.
 */
class DesktopWidget : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        ids.forEach { render(ctx, mgr, it) }
    }

    /**
     * Discovery needs the network, and a broadcast must return fast: paint from
     * the cached list first, then `goAsync` keeps the process alive long enough
     * to refresh it. Without goAsync the process can be frozen mid-request and a
     * newly added machine would not show up until the next tick.
     */
    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        if (intent.action != AppWidgetManager.ACTION_APPWIDGET_UPDATE) return
        val pending = goAsync()
        EXEC.execute {
            try {
                discover(ctx)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private val EXEC = Executors.newSingleThreadExecutor()

        /** Zones the pill can hold before the names stop fitting. */
        private const val MAX_SLOTS = 3

        private val SLOTS = listOf(R.id.dk_slot0, R.id.dk_slot1, R.id.dk_slot2)
        private val TEXTS = listOf(R.id.dk_text0, R.id.dk_text1, R.id.dk_text2)
        private val DIVIDERS = listOf(R.id.dk_div1, R.id.dk_div2)

        fun refreshAll(ctx: Context) {
            val mgr = AppWidgetManager.getInstance(ctx)
            widgetIds(ctx, DesktopWidget::class.java).forEach { render(ctx, mgr, it) }
        }

        /** Blocking: ask the backend which machines exist, cache them, repaint. */
        fun discover(ctx: Context) {
            if (!Config.isConfigured(ctx)) return
            val hosts = Api.getJson(ctx, "/api/skills/desktop/remote")?.optJSONArray("sunshine")
            if (hosts == null) {
                // Keep the cached names: the laptop being unreachable says nothing
                // about which machines exist, and Wake-on-LAN may bring them back.
                refreshAll(ctx)
                return
            }
            val targets = (0 until hosts.length()).mapNotNull { i ->
                val h = hosts.optJSONObject(i) ?: return@mapNotNull null
                val host = h.optString("host")
                if (host.isBlank()) return@mapNotNull null
                DesktopTarget(
                    label = h.optString("name").ifBlank { host },
                    host = host,
                    uuid = h.optString("uuid").ifBlank { null },
                )
            }
            WidgetPrefs.saveTargets(ctx, targets.take(MAX_SLOTS))
            refreshAll(ctx)
        }

        private fun render(ctx: Context, mgr: AppWidgetManager, id: Int) {
            val targets = WidgetPrefs.targets(ctx)
            val views = RemoteViews(ctx.packageName, R.layout.widget_desktop)

            // Nothing discovered yet (fresh install, laptop off): one zone that
            // opens Moonlight's own PC list, which still beats a dead tile.
            val shown = targets.ifEmpty {
                listOf(DesktopTarget(ctx.getString(R.string.widget_desktop_title), "", null))
            }

            SLOTS.forEachIndexed { i, slot ->
                val target = shown.getOrNull(i)
                views.setViewVisibility(slot, if (target == null) View.GONE else View.VISIBLE)
                if (target == null) return@forEachIndexed
                views.setTextViewText(TEXTS[i], shortLabel(target.label))
                views.setOnClickPendingIntent(
                    slot,
                    // Request code per widget AND per zone: two PendingIntents to
                    // the same component with the same code collapse into one, and
                    // every zone would launch the same machine.
                    activityPendingIntent(ctx, id * 10 + i, WidgetActionActivity.launchDesktop(ctx, i)),
                )
            }
            DIVIDERS.forEachIndexed { i, div ->
                views.setViewVisibility(div, if (shown.size > i + 1) View.VISIBLE else View.GONE)
            }
            mgr.updateAppWidget(id, views)
        }

        /**
         * A zone is about one launcher cell wide, so "Jarvis Main" would render as
         * "Jarvis M…". First word only once the full name cannot fit.
         */
        private fun shortLabel(label: String): String =
            if (label.length <= 9) label else label.substringBefore(' ')
    }
}
