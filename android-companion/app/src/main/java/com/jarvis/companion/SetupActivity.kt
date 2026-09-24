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
 * Pairing + permissions screen, built programmatically (no AppCompat/Material
 * deps). Shown on first run and from the app's "Ajustes" button.
 *
 * Pairing is one paste: the QR URL from the desktop panel already carries the
 * backend URL and the token, so the user never copies two secrets.
 */
class SetupActivity : Activity() {

    private lateinit var pairInput: EditText
    private lateinit var deviceInput: EditText
    private lateinit var intervalInput: EditText
    private lateinit var projectorInput: EditText
    private lateinit var appIdInput: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        fun label(text: String) = root.addView(TextView(this).apply {
            this.text = text
            setPadding(0, pad / 2, 0, 0)
        })

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
            text = "Jarvis"
            textSize = 24f
        })
        root.addView(TextView(this).apply {
            text = "Pega el enlace del QR que muestra el escritorio (incluye la URL y el token)."
            textSize = 13f
        })

        val saved = Config.baseUrl(this)
        val prefill = if (saved.isEmpty()) "" else "$saved/?token=${Config.token(this)}"
        label("Enlace de emparejamiento")
        pairInput = input("https://…/?token=…", prefill, InputType.TYPE_TEXT_VARIATION_URI)
        label("Nombre del dispositivo")
        deviceInput = input("tablet", Config.device(this))
        label("Intervalo de reporte (minutos)")
        intervalInput = input("15", Config.intervalMin(this).toString(), InputType.TYPE_CLASS_NUMBER)

        // Modo proyector: el aparato es solo una PANTALLA. Con el UUID puesto no
        // necesita emparejamiento ni red al arrancar — abre Moonlight y ya.
        root.addView(TextView(this).apply {
            text = "\nModo proyector"
            textSize = 18f
        })
        root.addView(TextView(this).apply {
            text = "Al encender, abre Moonlight contra esa máquina. No reporta batería ni ubicación."
            textSize = 13f
        })
        label("UUID de Sunshine (vacío = desactivado)")
        projectorInput = input("587B1714-…", Config.projectorUuid(this), InputType.TYPE_CLASS_TEXT)
        label("AppId (vacío = abre la lista de apps)")
        appIdInput = input("881448767", Config.projectorAppId(this), InputType.TYPE_CLASS_NUMBER)

        fun button(text: String, onClick: () -> Unit) = root.addView(Button(this).apply {
            this.text = text
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            setOnClickListener { onClick() }
        })

        button("Guardar y abrir Jarvis") { saveAndOpen() }
        button("Guardar modo proyector") { saveProjector() }
        button("Permisos de ubicación y micrófono") { requestRuntimePermissions() }
        button("Ignorar optimización de batería") { requestIgnoreBatteryOptimizations() }
        button("Detener reporte en segundo plano") {
            ReporterService.stop(this)
            updateStatus("Reporte detenido.")
        }

        status = TextView(this).apply { setPadding(0, pad, 0, 0) }
        root.addView(status)
        updateStatus("")

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun saveAndOpen() {
        val (base, tokenFromUrl) = Config.parsePairing(pairInput.text.toString())
        val token = tokenFromUrl ?: Config.token(this)
        if (!base.startsWith("http") || token.isEmpty()) {
            Toast.makeText(this, "El enlace debe incluir http(s) y ?token=", Toast.LENGTH_LONG).show()
            return
        }
        Config.save(
            this, base, token,
            deviceInput.text.toString().ifBlank { "tablet" },
            intervalInput.text.toString().toIntOrNull() ?: 15,
        )
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) requestRuntimePermissions()
        ReporterService.start(this)
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /**
     * Guarda (o apaga) el modo proyector y prueba el lanzamiento en el acto.
     *
     * Se prueba aqui a proposito: el fallo tipico es que Moonlight no tenga esa
     * maquina emparejada todavia ("PC not found"), y descubrirlo ahora es mucho
     * mejor que descubrirlo en el siguiente arranque con la pared en blanco.
     */
    private fun saveProjector() {
        val uuid = projectorInput.text.toString().trim()
        if (uuid.isEmpty()) {
            Config.setProjectorMode(this, false)
            updateStatus("Modo proyector desactivado.")
            return
        }
        Config.setProjectorMode(this, true, uuid, appIdInput.text.toString().trim())
        ReporterService.stop(this)
        val mode = Moonlight.launch(this, uuid, appIdInput.text.toString().trim().ifBlank { null })
        updateStatus(when (mode) {
            "host" -> "Modo proyector activo. Moonlight entró a la máquina ✓"
            "app" -> "Guardado, pero Moonlight abrió su lista: empareja esa máquina primero."
            "store" -> "Moonlight no está instalado."
            else -> "Guardado, pero no se pudo abrir Moonlight."
        })
    }

    /* ----- permissions ----- */

    private fun hasPermission(perm: String) =
        checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

    private fun requestRuntimePermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.RECORD_AUDIO,
        )
        if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
        requestPermissions(perms.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        // Background location must be requested separately, after foreground
        // location is granted ("Permitir siempre" in system settings).
        if (code == 1 && hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) && Build.VERSION.SDK_INT >= 29 &&
            !hasPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
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
        lines.add("Ubicación: " + if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) "concedida" else "pendiente")
        lines.add("Micrófono: " + if (hasPermission(Manifest.permission.RECORD_AUDIO)) "concedido" else "pendiente")
        lines.add("Optimización batería: " +
            if (pm.isIgnoringBatteryOptimizations(packageName)) "excluida ✓" else "activa (excluir recomendado)")
        lines.add("Reporte: " + if (ReporterService.isRunning) "activo" else "detenido")
        if (Config.projectorMode(this)) lines.add("Modo proyector: ACTIVO")
        status.text = lines.joinToString("\n")
    }
}
