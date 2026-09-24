package com.jarvis.companion.widget

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import com.jarvis.companion.Moonlight
import com.jarvis.companion.R
import com.jarvis.companion.Tailscale

/**
 * Invisible one-shot activity behind every widget tap.
 *
 * Widgets can only fire a PendingIntent, and a broadcast receiver is the wrong
 * target for the Tailscale toggle: Tailscale answers CONNECT_VPN by starting its
 * VPN service, and Android will not let a backgrounded app start a service for it
 * — a broadcast from a frozen process is silently dropped. Bouncing through a
 * (transparent, immediately finished) activity means there is a foreground
 * component at that moment, which is what makes the toggle reliable.
 */
class WidgetActionActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // No animation to suppress here: every intent that starts this carries
        // FLAG_ACTIVITY_NO_ANIMATION, and the activity is noHistory.
        when (intent.getStringExtra(EXTRA_ACTION)) {
            A_TS_TOGGLE -> toggleTailscale()
            A_TS_OPEN -> openTailscale()
            A_DESKTOP -> launchDesktop(intent.getIntExtra(EXTRA_SLOT, 0))
        }
        finish()
    }

    /**
     * State is re-read here instead of trusting the extra the tile was drawn
     * with: a tile can sit for half an hour, and toggling from a stale reading
     * would connect what is already connected.
     */
    private fun toggleTailscale() {
        if (!Tailscale.installed(this)) {
            toast(getString(R.string.widget_ts_not_installed_toast))
            return
        }
        Tailscale.setEnabled(this, !Tailscale.active())
        // The tunnel takes a moment to come up (or down), and nothing tells us
        // when: re-render a few times so the tile settles on the truth.
        val app = applicationContext
        val h = Handler(Looper.getMainLooper())
        listOf(900L, 2500L, 5000L).forEach { delay ->
            h.postDelayed({ TailscaleWidget.refreshAll(app) }, delay)
        }
    }

    private fun openTailscale() {
        if (!Tailscale.openApp(this)) toast(getString(R.string.widget_ts_not_installed_toast))
    }

    /** `slot` indexes the machine list the tile was drawn from. */
    private fun launchDesktop(slot: Int) {
        val target = WidgetPrefs.targets(this).getOrNull(slot)
        // No UUID (or no machine cached yet) still opens Moonlight, just on its
        // own PC list instead of straight into the stream.
        Moonlight.launch(this, target?.uuid)
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    companion object {
        private const val EXTRA_ACTION = "com.jarvis.companion.widget.ACTION"
        private const val EXTRA_SLOT = "com.jarvis.companion.widget.SLOT"
        private const val A_TS_TOGGLE = "ts_toggle"
        private const val A_TS_OPEN = "ts_open"
        private const val A_DESKTOP = "desktop"

        private fun base(ctx: Context, action: String) =
            Intent(ctx, WidgetActionActivity::class.java)
                .putExtra(EXTRA_ACTION, action)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)

        /** `on` is informational only; the activity re-reads the real state. */
        fun toggleTailscale(ctx: Context, on: Boolean): Intent =
            base(ctx, A_TS_TOGGLE).putExtra("on", on)

        fun openTailscale(ctx: Context): Intent = base(ctx, A_TS_OPEN)

        fun launchDesktop(ctx: Context, slot: Int): Intent =
            base(ctx, A_DESKTOP).putExtra(EXTRA_SLOT, slot)
    }
}
