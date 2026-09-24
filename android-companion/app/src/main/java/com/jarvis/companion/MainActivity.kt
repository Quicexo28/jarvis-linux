package com.jarvis.companion

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.jarvis.companion.widget.DesktopWidget
import com.jarvis.companion.widget.JarvisWidget
import com.jarvis.companion.widget.TailscaleWidget
import org.json.JSONObject

/**
 * The app: a WebView on the Jarvis remote UI plus the native pieces a WebView
 * cannot provide.
 *
 * Everything visible (chat, house, remote PC, status) is the web app served by
 * the backend, so a change there ships to the phone without rebuilding the APK.
 * The native side contributes the background reporter (ReporterService), device
 * signals and on-device dictation, exposed to the page as `window.JarvisNative`.
 */
class MainActivity : Activity() {

    private companion object {
        const val MENU_SETTINGS = 1
        const val MENU_RELOAD = 2
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var errorView: View
    private var loadedUrl: String? = null
    private var pageFailed = false
    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Config.isConfigured(this)) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        root = FrameLayout(this)
        web = WebView(this).apply { layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT) }
        configureWebView()
        errorView = buildErrorView()
        root.addView(web)
        root.addView(errorView)
        setContentView(root)

        // The reporter is the whole point of being an app and not a bookmark:
        // keep it alive whenever the app is opened.
        ReporterService.start(this)
        load()
    }

    override fun onResume() {
        super.onResume()
        // Settings may have changed the URL or token while we were away.
        if (::web.isInitialized && loadedUrl != Config.webUrl(this)) load()
        // The app just proved (or disproved) that the backend answers; let the
        // home screen tiles agree with what the user is looking at.
        JarvisWidget.refreshAll(this)
        TailscaleWidget.refreshAll(this)
        DesktopWidget.refreshAll(this)
    }

    override fun onDestroy() {
        recognizer?.destroy()
        recognizer = null
        super.onDestroy()
    }

    /**
     * Permanent escape hatch to the pairing screen. Without it, a config the
     * backend rejects (e.g. the v1 ingest token, which does not authenticate
     * the GUI) leaves the app stuck on an error page with no way back.
     */
    override fun onCreateOptionsMenu(menu: android.view.Menu): Boolean {
        menu.add(0, MENU_SETTINGS, 0, "Ajustes")
        menu.add(0, MENU_RELOAD, 1, "Recargar")
        return true
    }

    override fun onOptionsItemSelected(item: android.view.MenuItem): Boolean = when (item.itemId) {
        MENU_SETTINGS -> { startActivity(Intent(this, SetupActivity::class.java)); true }
        MENU_RELOAD -> { load(); true }
        else -> super.onOptionsItemSelected(item)
    }

    @Deprecated("Legacy back handling; still delivered on API 33+ without enableOnBackInvokedCallback")
    override fun onBackPressed() {
        if (::web.isInitialized && web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    private fun load() {
        val url = Config.webUrl(this)
        loadedUrl = url
        pageFailed = false
        errorView.visibility = View.GONE
        web.loadUrl(url)
    }

    /* ----- WebView ----- */

    private fun configureWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            // The page is a phone-first layout already; no desktop viewport hacks.
            useWideViewPort = false
            loadWithOverviewMode = false
            textZoom = 100
        }
        web.setBackgroundColor(0xFF05070D.toInt())
        web.addJavascriptInterface(Bridge(), "JarvisNative")

        web.webViewClient = object : WebViewClient() {
            /**
             * Anything that is not http(s) belongs to another app (market:,
             * intent:, moonlight:). Without this the WebView answers with
             * ERR_UNKNOWN_URL_SCHEME and the whole page shows the error view.
             */
            override fun shouldOverrideUrlLoading(
                view: WebView?, request: android.webkit.WebResourceRequest?,
            ): Boolean {
                val uri = request?.url ?: return false
                if (uri.scheme == "http" || uri.scheme == "https") return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    true
                } catch (e: Exception) {
                    true  // Swallow it: no app for the scheme is not a page failure.
                }
            }

            override fun onReceivedError(
                view: WebView?, request: android.webkit.WebResourceRequest?,
                error: android.webkit.WebResourceError?,
            ) {
                // Only a failure of the main document is worth a full error screen.
                if (request?.isForMainFrame == true) showError()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                if (!pageFailed) errorView.visibility = View.GONE
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                // The page only asks for our own backend's origin; mirror the
                // OS-level grant instead of prompting twice.
                callback?.invoke(origin, hasPermission(Manifest.permission.ACCESS_FINE_LOCATION), false)
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                val audio = request?.resources?.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) == true
                if (audio && hasPermission(Manifest.permission.RECORD_AUDIO)) request?.grant(request.resources)
                else request?.deny()
            }
        }
    }

    private fun buildErrorView(): View {
        val pad = (20 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(0xFF05070D.toInt())
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
        }
        box.addView(TextView(this).apply {
            text = "Sin conexión con Jarvis"
            textSize = 18f
            setTextColor(0xFFE6EDF7.toInt())
        })
        box.addView(TextView(this).apply {
            text = "Revisa que el portátil esté encendido y que estés en la red o en Tailscale."
            textSize = 14f
            setTextColor(0xFF8EA0B8.toInt())
            setPadding(0, pad / 2, 0, pad)
        })
        box.addView(Button(this).apply {
            text = "Reintentar"
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            setOnClickListener { load() }
        })
        box.addView(Button(this).apply {
            text = "Ajustes"
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            setOnClickListener { startActivity(Intent(this@MainActivity, SetupActivity::class.java)) }
        })
        return box
    }

    private fun showError() {
        pageFailed = true
        errorView.visibility = View.VISIBLE
    }

    private fun hasPermission(perm: String) =
        checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

    /* ----- JS bridge (window.JarvisNative) ----- */

    inner class Bridge {

        @JavascriptInterface
        fun version(): String = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        } catch (e: Exception) { "" }

        @JavascriptInterface
        fun reporterRunning(): Boolean = ReporterService.isRunning

        @JavascriptInterface
        fun openSettings() {
            main.post { startActivity(Intent(this@MainActivity, SetupActivity::class.java)) }
        }

        @JavascriptInterface
        fun battery(): String = try {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            JSONObject()
                .put("level", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
                .put("charging", bm.isCharging)
                .toString()
        } catch (e: Exception) { "" }

        /** Android WebView has no SpeechRecognition API; dictate natively instead. */
        @JavascriptInterface
        fun startVoice() {
            main.post { startDictation() }
        }

        /**
         * Hand off to the Moonlight app.
         *
         * Moonlight has no documented URI scheme for "connect to host X"
         * (moonlight-stream/moonlight-android#668), so this only brings the app
         * to the front; the page copies the host address first so adding it is
         * a paste. Returns "launched", "store" (not installed, Play opened) or
         * "error", which is what the button reports back to the user.
         */
        @JavascriptInterface
        fun openMoonlight(): String {
            // No UUID from here: the page has no way to know which host the user
            // means. The desktop widget is the one that goes straight to a PC.
            // The launch itself is posted to the main thread — this method runs on
            // the WebView's JS bridge thread.
            val installed = Moonlight.installedPackage(this@MainActivity) != null
            main.post { Moonlight.launch(this@MainActivity) }
            return if (installed) "launched" else "store"
        }
    }

    /* ----- native dictation ----- */

    private fun startDictation() {
        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 3)
            voiceError("Concede el permiso de micrófono y vuelve a intentarlo.")
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            voiceError("Este dispositivo no tiene reconocimiento de voz.")
            return
        }
        recognizer?.destroy()
        val rec = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = rec
        rec.setRecognitionListener(object : android.speech.RecognitionListener {
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (text.isNullOrBlank()) voiceError("No se escuchó nada.") else voiceResult(text)
            }
            override fun onError(error: Int) = voiceError(
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No se escuchó nada."
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Sin red para reconocer la voz."
                    else -> "No se pudo dictar."
                }
            )
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-CO")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            if (Build.VERSION.SDK_INT >= 33) putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_LATENCY)
        }
        rec.startListening(intent)
    }

    private fun voiceResult(text: String) = evalJs("window.__jarvisVoiceResult && window.__jarvisVoiceResult(${JSONObject.quote(text)})")

    private fun voiceError(reason: String) = evalJs("window.__jarvisVoiceError && window.__jarvisVoiceError(${JSONObject.quote(reason)})")

    private fun evalJs(script: String) {
        main.post { if (::web.isInitialized) web.evaluateJavascript(script, null) }
    }
}
