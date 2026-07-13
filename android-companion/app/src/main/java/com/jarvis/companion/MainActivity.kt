package com.jarvis.companion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * Single config screen, built programmatically (no AppCompat/Material deps):
 * backend URL + ingest token + device name + interval, permission buttons and
 * start/stop of the reporter service. Spanish copy, like the rest of Jarvis.
 */
class MainActivity : Activity() {

    private lateinit var urlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var deviceInput: EditText
    private lateinit var intervalInput: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        fun label(text: String) = root.addView(TextView(this).apply { this.text = text })
        fun input(hint: String, value: String, type: Int = InputType.TYPE_CLASS_TEXT): EditText {
            val e = EditText(this).apply {
                this.hint = hint
                inputType = type
                setText(value)
                layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            }
            root.addView(e)
            return e
        }

        root.addView(TextView(this).apply {
            text = "Jarvis Companion"
            textSize = 22f
        })

        label("URL del backend (https://tunnel o http://IP:8788)")
        urlInput = input("https://...", Config.baseUrl(this), InputType.TYPE_TEXT_VARIATION_URI)
        label("Token de ingesta (MOBILE_INGEST_TOKEN)")
        tokenInput = input("token", Config.token(this))
        label("Nombre del dispositivo")
        deviceInput = input("tablet", Config.device(this))
        label("Intervalo de reporte (minutos)")
        intervalInput = input("15", Config.intervalMin(this).toString(), InputType.TYPE_CLASS_NUMBER)

        fun button(text: String, onClick: () -> Unit) = root.addView(Button(this).apply {
            this.text = text
            setOnClickListener { onClick() }
        })

        button("Guardar y arrancar") { saveAndStart() }
        button("Detener servicio") {
            ReporterService.stop(this)
            updateStatus("Servicio detenido.")
        }
        button("Permisos de ubicación") { requestLocationPermissions() }
        button("Ignorar optimización de batería") { requestIgnoreBatteryOptimizations() }

        status = TextView(this).apply { setPadding(0, pad, 0, 0) }
        root.addView(status)
        updateStatus("")

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun saveAndStart() {
        val url = urlInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()
        if (!url.startsWith("http") || token.isEmpty()) {
            Toast.makeText(this, "Falta URL o token", Toast.LENGTH_LONG).show()
            return
        }
        Config.save(
            this, url, token,
            deviceInput.text.toString().ifBlank { "tablet" },
            intervalInput.text.toString().toIntOrNull() ?: 15,
        )
        if (!hasLocationPermission()) requestLocationPermissions()
        ReporterService.start(this)
        updateStatus("Servicio activo. Revisa la notificación persistente.")
    }

    /* ----- permissions ----- */

    private fun hasLocationPermission() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun requestLocationPermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
        requestPermissions(perms.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        // Background location must be requested separately, after foreground
        // location is granted ("Permitir siempre" in system settings).
        if (code == 1 && hasLocationPermission() && Build.VERSION.SDK_INT >= 29 &&
            checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 2)
        }
        updateStatus("")
    }

    private fun requestIgnoreBatteryOptimizations() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, "Ya está excluida", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:$packageName"),
        ))
    }

    private fun updateStatus(extra: String) {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val lines = mutableListOf<String>()
        if (extra.isNotEmpty()) lines.add(extra)
        lines.add("Ubicación: " + if (hasLocationPermission()) "concedida" else "pendiente")
        lines.add("Optimización batería: " +
            if (pm.isIgnoringBatteryOptimizations(packageName)) "excluida ✓" else "activa (excluir recomendado)")
        status.text = lines.joinToString("\n")
    }
}
