package com.jarvis.companion

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Control and read Tailscale from outside its own app.
 *
 * Tailscale ships a Quick Settings tile but nothing for the home screen, which
 * is the gap the widget fills. It exposes an exported broadcast receiver for
 * automation (Tasker et al.): `IPNReceiver` with CONNECT_VPN / DISCONNECT_VPN.
 * There is no query API for "are you up", so state is read from the OS instead:
 * a tailnet address is a 100.64.0.0/10 (CGNAT) v4 address on a live interface,
 * and it only exists while the tunnel is up. That needs no permission and no
 * round trip, so the widget can paint the truth instantly.
 */
object Tailscale {
    private const val TAG = "JarvisTailscale"

    const val PKG = "com.tailscale.ipn"
    private const val RECEIVER = "com.tailscale.ipn.IPNReceiver"
    private const val ACTION_CONNECT = "com.tailscale.ipn.CONNECT_VPN"
    private const val ACTION_DISCONNECT = "com.tailscale.ipn.DISCONNECT_VPN"

    fun installed(ctx: Context): Boolean = try {
        ctx.packageManager.getPackageInfo(PKG, 0); true
    } catch (e: PackageManager.NameNotFoundException) { false }

    /** The tablet's tailnet IPv4, or null when the tunnel is down. */
    fun tailnetIp(): String? = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList().asSequence() }
            .filterIsInstance<Inet4Address>()
            .map { it.hostAddress ?: "" }
            .firstOrNull { isCgnat(it) }
    } catch (e: Exception) {
        Log.w(TAG, "tailnetIp failed: ${e.message}")
        null
    }

    fun active(): Boolean = tailnetIp() != null

    /** 100.64.0.0/10 — the range Tailscale assigns, and nothing else on a LAN. */
    private fun isCgnat(ip: String): Boolean {
        val parts = ip.split('.')
        if (parts.size != 4) return false
        val a = parts[0].toIntOrNull() ?: return false
        val b = parts[1].toIntOrNull() ?: return false
        return a == 100 && b in 64..127
    }

    /**
     * Flip the tunnel. Explicit broadcast (package + class), because an implicit
     * one would not be delivered to a manifest receiver on Android 8+.
     *
     * Must be called with a foreground activity alive: Tailscale answers by
     * starting its VPN service, and a background app cannot start one for it.
     * That is what [com.jarvis.companion.widget.WidgetActionActivity] is for.
     */
    fun setEnabled(ctx: Context, on: Boolean): Boolean {
        if (!installed(ctx)) return false
        return try {
            ctx.sendBroadcast(
                Intent(if (on) ACTION_CONNECT else ACTION_DISCONNECT)
                    .setClassName(PKG, RECEIVER),
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "setEnabled($on) failed: ${e.message}")
            false
        }
    }

    fun openApp(ctx: Context): Boolean {
        val intent = ctx.packageManager.getLaunchIntentForPackage(PKG) ?: return false
        return try {
            ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: Exception) {
            false
        }
    }
}
