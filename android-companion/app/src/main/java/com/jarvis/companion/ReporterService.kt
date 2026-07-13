package com.jarvis.companion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Foreground service that feeds Jarvis ambient signals from the tablet:
 *  - battery level + charging (periodic, plus instant on plug/unplug),
 *  - location (periodic, LocationManager — no Play Services dependency),
 *  - presence (screen on/off = tablet in use or idle).
 *
 * Runs a HandlerThread loop every `intervalMin` minutes. START_STICKY so the
 * system restarts it if killed. Samsung One UI: exclude the app from battery
 * optimization or the service dies overnight.
 */
class ReporterService : Service() {

    companion object {
        private const val TAG = "JarvisReporter"
        private const val CHANNEL_ID = "jarvis_reporter"
        private const val NOTIF_ID = 1

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, ReporterService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, ReporterService::class.java))
        }
    }

    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private val executor = Executors.newSingleThreadExecutor()

    private val tick = object : Runnable {
        override fun run() {
            reportBattery()
            reportLocation()
            reportPresence(isScreenOn())
            handler.postDelayed(this, Config.intervalMin(this@ReporterService) * 60_000L)
        }
    }

    // Instant events: charger plug/unplug and screen on/off.
    private val eventReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_POWER_CONNECTED, Intent.ACTION_POWER_DISCONNECTED ->
                    handler.post { reportBattery() }
                Intent.ACTION_SCREEN_ON -> handler.post { reportPresence(true) }
                Intent.ACTION_SCREEN_OFF -> handler.post { reportPresence(false) }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        thread = HandlerThread("jarvis-reporter").apply { start() }
        handler = Handler(thread.looper)
        registerReceiver(eventReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification())
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        runCatching { unregisterReceiver(eventReceiver) }
        thread.quitSafely()
        executor.shutdown()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /* ----- reporters (run on handler thread) ----- */

    private fun reportBattery() {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        Api.post(this, "/api/mobile/ctx/battery", JSONObject()
            .put("level", level)
            .put("charging", charging))
    }

    private fun reportPresence(foreground: Boolean) {
        Api.post(this, "/api/mobile/ctx/presence", JSONObject().put("foreground", foreground))
    }

    private fun reportLocation() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) return
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = when {
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            else -> return
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(provider, null, executor) { loc -> postLocation(loc) }
            } else {
                postLocation(lm.getLastKnownLocation(provider))
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "location denied: ${e.message}")
        }
    }

    private fun postLocation(loc: Location?) {
        if (loc == null) return
        Api.post(this, "/api/mobile/ctx/location", JSONObject()
            .put("lat", loc.latitude)
            .put("lon", loc.longitude)
            .put("accuracy", loc.accuracy.toDouble())
            .put("source", "apk"))
    }

    private fun isScreenOn(): Boolean {
        val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        return pm.isInteractive
    }

    /* ----- notification (required for foreground service) ----- */

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Jarvis Reporter", NotificationManager.IMPORTANCE_LOW)
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Jarvis conectado")
            .setContentText("Reportando rutina cada ${Config.intervalMin(this)} min")
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }
}
