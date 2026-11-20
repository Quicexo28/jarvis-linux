package com.jarvis.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.provider.Settings
import android.util.Log

/**
 * Modo proyector: vuelve a encender la depuración inalámbrica, que Android 14
 * apaga en cada arranque. Es comodidad para desplegar y diagnosticar: nada del
 * camino crítico (boot → pared/Moonlight) depende de ADB.
 *
 * Se escribe al conectar a wifi y no antes: activada sin wifi, AdbDebuggingManager
 * la vuelve a apagar al instante. Solo se escribe 1, nunca 0 (apagarla cortaría
 * la sesión de quien esté depurando).
 *
 * Necesita `adb shell pm grant com.jarvis.companion android.permission.WRITE_SECURE_SETTINGS`
 * una vez. En una red wifi que el proyector no tenga como "de confianza" sale
 * un diálogo de confirmación en pantalla la primera vez.
 */
object AdbWifi {
    private const val TAG = "JarvisAdbWifi"
    private const val KEY = "adb_wifi_enabled" // Settings.Global.ADB_WIFI_ENABLED es @hide

    @Volatile private var callback: ConnectivityManager.NetworkCallback? = null

    fun allowed(ctx: Context): Boolean =
        ctx.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    /** Enciende si está apagada. Devuelve true si quedó encendida. */
    fun ensure(ctx: Context): Boolean {
        if (!Config.keepAdbWifi(ctx)) return false
        if (!allowed(ctx)) {
            Log.w(TAG, "sin WRITE_SECURE_SETTINGS: no se puede reactivar la depuración inalámbrica")
            return false
        }
        return try {
            val cr = ctx.contentResolver
            if (Settings.Global.getInt(cr, KEY, 0) != 1) {
                Settings.Global.putInt(cr, KEY, 1)
                Log.i(TAG, "depuración inalámbrica reactivada")
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "no se pudo activar: ${e.message}")
            false
        }
    }

    /**
     * Callback de red wifi para todo lo que viva el proceso. En modo pared el
     * WallService mantiene el proceso; en modo Moonlight basta con el primer
     * wifi tras el arranque.
     */
    fun watch(ctx: Context) {
        val app = ctx.applicationContext
        if (!Config.keepAdbWifi(app) || callback != null) return
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                ensure(app)
            }
        }
        try {
            cm.registerNetworkCallback(
                NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(),
                cb,
            )
            callback = cb
        } catch (e: Exception) {
            Log.w(TAG, "no se pudo vigilar el wifi: ${e.message}")
        }
    }
}
