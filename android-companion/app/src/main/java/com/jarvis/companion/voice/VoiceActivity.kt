package com.jarvis.companion.voice

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.jarvis.companion.Api
import com.jarvis.companion.Config
import com.jarvis.companion.R
import com.jarvis.companion.SetupActivity
import com.jarvis.companion.ui.HoloState
import com.jarvis.companion.widget.JarvisWidget
import com.jarvis.companion.widget.WidgetPrefs
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Talking to Jarvis without the app: the whole point of the 2x2 widget.
 *
 * A tap lands here, not on the WebView — the tablet's assistant should answer
 * over whatever is on screen, the way Bixby does, so this is a translucent
 * overlay: listen (native SpeechRecognizer, the WebView has none), ask the same
 * brain the chat uses (`/api/jarvis/turn`, session + MCP tools), speak the reply
 * (`/api/jarvis/tts` streamed into [PcmPlayer]). The hologram is the state
 * display: cyan breathing while listening, amber while thinking, pulsing with
 * Jarvis's own voice while it answers.
 *
 * Also registered for ACTION_ASSIST, so it can be set as the system assistant.
 */
class VoiceActivity : Activity() {

    private companion object {
        const val PERM_REQUEST = 11
        /** Give up the screen if the user walks away after a reply. */
        const val IDLE_CLOSE_MS = 9_000L
    }

    private lateinit var holo: HoloView
    private lateinit var caption: TextView
    private lateinit var transcript: TextView

    private val main = Handler(Looper.getMainLooper())
    private val exec = Executors.newSingleThreadExecutor()
    private val player = PcmPlayer()
    private var recognizer: SpeechRecognizer? = null
    @Volatile private var busy = false
    private var awaitingPermission = false
    private val closeSoon = Runnable { finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())

        if (!Config.isConfigured(this)) {
            caption.text = getString(R.string.voice_not_paired)
            holo.state = HoloState.OFFLINE
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        startTurn()
    }

    override fun onDestroy() {
        main.removeCallbacks(closeSoon)
        player.stop()
        recognizer?.destroy()
        recognizer = null
        exec.shutdownNow()
        super.onDestroy()
    }

    /**
     * Leaving the overlay (home, another app) must not leave a mic open or a
     * reply talking to an empty room. The permission dialog also stops us, and
     * that one has to survive — otherwise granting the mic would kill the turn
     * that asked for it.
     */
    override fun onStop() {
        super.onStop()
        if (!awaitingPermission && !isFinishing) finish()
    }

    /* ----- UI ----- */

    private fun buildUi(): View {
        val d = resources.displayMetrics.density
        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.jarvis_scrim))
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
            // Tap outside the hologram = dismiss, like any assistant sheet.
            setOnClickListener { finish() }
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
            }
            setPadding((28 * d).toInt(), 0, (28 * d).toInt(), 0)
        }
        holo = HoloView(this).apply {
            layoutParams = LinearLayout.LayoutParams((240 * d).toInt(), (240 * d).toInt())
            // Tap the hologram to speak again instead of hunting for a button.
            setOnClickListener { if (!busy) startTurn() else interrupt() }
        }
        caption = TextView(this).apply {
            textSize = 13f
            letterSpacing = 0.06f
            gravity = Gravity.CENTER
            setTextColor(getColor(R.color.jarvis_dim))
            setPadding(0, (10 * d).toInt(), 0, 0)
        }
        transcript = TextView(this).apply {
            textSize = 17f
            gravity = Gravity.CENTER
            maxLines = 6
            setTextColor(getColor(R.color.jarvis_text))
            setPadding(0, (14 * d).toInt(), 0, 0)
        }
        column.addView(holo)
        column.addView(caption)
        column.addView(transcript)
        root.addView(column)
        return root
    }

    private fun show(state: HoloState, captionText: String, body: String? = null) {
        main.post {
            holo.state = state
            caption.text = captionText
            if (body != null) transcript.text = body
        }
    }

    /* ----- turn ----- */

    private fun startTurn() {
        main.removeCallbacks(closeSoon)
        transcript.text = ""
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            awaitingPermission = true
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), PERM_REQUEST)
            show(HoloState.OFFLINE, getString(R.string.voice_no_mic))
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            fail(getString(R.string.voice_no_recognizer))
            return
        }
        busy = true
        show(HoloState.LISTENING, getString(R.string.voice_listening))
        listen()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        if (code != PERM_REQUEST) return
        awaitingPermission = false
        if (res.firstOrNull() == PackageManager.PERMISSION_GRANTED) startTurn()
        else fail(getString(R.string.voice_no_mic))
    }

    private fun listen() {
        recognizer?.destroy()
        val rec = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = rec
        rec.setRecognitionListener(object : RecognitionListener {
            override fun onRmsChanged(rmsdB: Float) {
                // SpeechRecognizer reports roughly -2..10 dB; map that onto the
                // hologram's 0..1 so the core actually tracks the voice.
                holo.setLevel(((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (!text.isNullOrBlank()) main.post { transcript.text = text }
            }

            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (text.isNullOrBlank()) fail(getString(R.string.voice_no_speech)) else ask(text)
            }

            override fun onError(error: Int) = fail(
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                        getString(R.string.voice_no_speech)
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                        getString(R.string.voice_no_network)
                    else -> getString(R.string.voice_no_speech)
                },
            )

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {
                holo.setLevel(0f)
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        rec.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-CO")
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                if (Build.VERSION.SDK_INT >= 33) {
                    putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_LATENCY)
                }
            },
        )
    }

    private fun ask(text: String) {
        show(HoloState.THINKING, getString(R.string.voice_thinking), text)
        val app = applicationContext
        exec.execute {
            val res = Api.postForJson(app, "/api/jarvis/turn", JSONObject().put("message", text), 60_000)
            val reply = res?.optString("reply")?.takeIf { it.isNotBlank() }
            // The overlay just learned whether the laptop answers; the widget's
            // colour should agree with what the user was told.
            WidgetPrefs.setBackendOnline(app, res != null)
            JarvisWidget.refreshAll(app)
            if (reply == null) {
                fail(getString(R.string.voice_no_backend))
            } else {
                speak(reply)
            }
        }
    }

    /** Runs on the executor thread: [PcmPlayer.play] blocks until the reply ends. */
    private fun speak(reply: String) {
        show(HoloState.SPEAKING, getString(R.string.voice_speaking), reply)
        val app = applicationContext
        val conn = Api.openStream(app, "/api/jarvis/tts", JSONObject().put("text", reply).put("lang", "es"), 60_000)
        if (conn == null) {
            // The reply is already on screen; only the voice is missing.
            idle()
            return
        }
        val rate = conn.getHeaderField("X-Sample-Rate")?.toIntOrNull() ?: 24_000
        try {
            conn.inputStream.use { player.play(it, rate) { level -> holo.setLevel(level) } }
        } finally {
            try { conn.disconnect() } catch (e: Exception) { }
        }
        idle()
    }

    private fun interrupt() {
        player.stop()
        startTurn()
    }

    private fun idle() {
        busy = false
        show(HoloState.ONLINE, getString(R.string.voice_tap_again))
        main.postDelayed(closeSoon, IDLE_CLOSE_MS)
    }

    private fun fail(reason: String) {
        busy = false
        show(HoloState.OFFLINE, reason)
        main.removeCallbacks(closeSoon)
        main.postDelayed(closeSoon, 3_500L)
    }
}
