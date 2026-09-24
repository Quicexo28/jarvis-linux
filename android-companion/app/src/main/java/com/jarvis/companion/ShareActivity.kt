package com.jarvis.companion

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import android.widget.Toast
import org.json.JSONObject
import java.util.Locale

/**
 * "Compartir → Jarvis": el puente entre la hoja de compartir de Android y la
 * boveda de Obsidian.
 *
 * Sube lo compartido a `POST /api/vault/ingest`, que lo deja en `Clippings/`.
 * A partir de ahi trabaja `lib/pdfWatcher.js` del backend: pdf/docx/jpg/png se
 * convierten a markdown (OCR spa+eng en las imagenes) y **el original se borra**
 * — la boveda guarda el texto, no el binario. Es la conducta elegida.
 *
 * Invisible: no hay UI, solo un Toast. La activity termina en el acto y la
 * subida sigue en un hilo aparte con el contexto de aplicacion, porque una
 * activity ya finalizada no puede sostener la peticion.
 */
class ShareActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Config.isConfigured(this)) {
            toast(getString(R.string.share_not_paired))
            finish()
            return
        }

        val uris = streamUris(intent)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        Log.i(TAG, "share: action=${intent.action} type=${intent.type} uris=${uris.size} text=${text.length}")

        when {
            uris.isNotEmpty() -> sendFiles(uris, intent.type.orEmpty())
            text.isNotEmpty() -> sendText(subject, text)
            else -> {
                Log.w(TAG, "nada que enviar: extras=${intent.extras?.keySet()?.joinToString()}")
                toast(getString(R.string.share_empty))
            }
        }
        finish()
    }

    /**
     * `EXTRA_STREAM` llega como Uri suelto (SEND) o lista (SEND_MULTIPLE), y en
     * API 33+ la version sin tipo esta obsoleta — de ahi las dos ramas.
     */
    @Suppress("DEPRECATION")
    private fun streamUris(intent: Intent): List<Uri> {
        val single: Uri? =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra(Intent.EXTRA_STREAM)
        if (single != null) return listOf(single)

        val many: List<Uri>? =
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
        return many.orEmpty()
    }

    /**
     * @param declared el `intent.type` del share. Hace falta porque
     * `ContentResolver.getType` devuelve null cuando el proveedor no publica el
     * tipo o cuando no tenemos permiso sobre ese Uri concreto — y sin mime no
     * habia ni extension ni nombre, asi que el envio moria en silencio. El
     * emisor SIEMPRE declara un tipo en el intent; es la fuente de respaldo.
     */
    private fun sendFiles(uris: List<Uri>, declared: String) {
        val app = applicationContext
        val resolver = contentResolver
        // El nombre se resuelve AQUI, no en el hilo: el permiso de lectura sobre
        // el Uri compartido va atado a esta activity y se pierde al terminarla.
        val jobs = uris.mapNotNull { uri ->
            val mime = resolver.getType(uri)?.takeIf { it.isNotBlank() } ?: declared
            val name = fileName(uri, mime)
            if (name == null) {
                Log.w(TAG, "sin nombre utilizable para $uri (mime='$mime')")
                return@mapNotNull null
            }
            val stream = try {
                resolver.openInputStream(uri)
            } catch (e: Exception) {
                Log.w(TAG, "no se pudo abrir $uri: ${e.javaClass.simpleName}: ${e.message}")
                null
            }
            if (stream == null) {
                // openInputStream devuelve null SIN lanzar cuando el proveedor
                // no sirve el Uri; sin este log la rama era invisible.
                Log.w(TAG, "stream nulo para $uri")
                return@mapNotNull null
            }
            Log.i(TAG, "subiendo '$name' (mime='$mime')")
            Triple(name, mime, stream)
        }

        if (jobs.isEmpty()) {
            toast(getString(R.string.share_unreadable))
            return
        }

        toast(resources.getQuantityString(R.plurals.share_sending, jobs.size, jobs.size))
        Thread {
            var ok = 0
            var lastError: String? = null
            for ((name, mime, stream) in jobs) {
                val res = Api.postFile(app, INGEST_PATH, name, mime, stream)
                if (res?.optBoolean("ok") == true) ok++ else lastError = errorOf(res)
            }
            val message = when {
                ok == jobs.size && ok == 1 -> app.getString(R.string.share_ok_one)
                ok == jobs.size -> app.getString(R.string.share_ok_many, ok)
                ok > 0 -> app.getString(R.string.share_partial, ok, jobs.size)
                else -> app.getString(R.string.share_failed, lastError ?: "sin conexion")
            }
            toastOn(app, message)
        }.start()
    }

    private fun sendText(subject: String, text: String) {
        val app = applicationContext
        val body = JSONObject().apply {
            put("device", Config.device(app))
            put("text", text)
            if (subject.isNotEmpty()) put("title", subject)
            firstUrl(text)?.let { put("url", it) }
        }
        toast(getString(R.string.share_sending_note))
        Thread {
            val res = Api.postForJson(app, INGEST_PATH, body)
            val message =
                if (res?.optBoolean("ok") == true) app.getString(R.string.share_ok_one)
                else app.getString(R.string.share_failed, errorOf(res) ?: "sin conexion")
            toastOn(app, message)
        }.start()
    }

    /**
     * Nombre para el fichero. `DISPLAY_NAME` es lo que ensena el sistema y lo
     * que el usuario reconocera en la boveda; cuando el proveedor no lo publica
     * (algunos content providers no lo hacen) se fabrica uno con la extension
     * derivada del mime, porque el backend rutea por extension y sin ella
     * rechazaria el envio.
     */
    private fun fileName(uri: Uri, mime: String): String? {
        val display = try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (c.moveToFirst() && idx >= 0) c.getString(idx) else null
            }
        } catch (e: Exception) {
            null
        }?.trim().orEmpty()

        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime).orEmpty()
        if (display.isNotEmpty()) {
            if (display.contains('.') || ext.isEmpty()) return display
            return "$display.$ext"
        }

        // Sin DISPLAY_NAME: el ultimo segmento del Uri suele traer el nombre en
        // los proveedores de ficheros (SAF, FileProvider). Solo sirve si ya trae
        // extension — un id numerico de MediaStore no es un nombre.
        val tail = uri.lastPathSegment?.substringAfterLast('/')?.trim().orEmpty()
        if (tail.contains('.') && !tail.substringAfterLast('.').all { it.isDigit() }) return tail

        if (ext.isEmpty()) return null
        return "Jarvis ${System.currentTimeMillis()}.$ext"
    }

    private fun firstUrl(text: String): String? =
        Regex("""https?://\S+""").find(text)?.value?.trimEnd('.', ',', ')')

    private fun errorOf(res: JSONObject?): String? = when (val e = res?.optString("error").orEmpty()) {
        "" -> null
        "ext_not_allowed" -> getStringSafe(R.string.share_err_ext)
        "too_large" -> getStringSafe(R.string.share_err_size)
        "vault_not_configured" -> getStringSafe(R.string.share_err_vault)
        else -> e.lowercase(Locale.ROOT)
    }

    private fun getStringSafe(id: Int): String = applicationContext.getString(id)

    private fun toast(message: String) = toastOn(applicationContext, message)

    private fun toastOn(ctx: android.content.Context, message: String) {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(ctx, message, Toast.LENGTH_SHORT).show()
        }
    }

    private companion object {
        const val TAG = "JarvisShare"
        const val INGEST_PATH = "/api/vault/ingest"
    }
}
