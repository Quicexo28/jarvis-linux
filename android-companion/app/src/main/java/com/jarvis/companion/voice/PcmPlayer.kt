package com.jarvis.companion.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.min

/**
 * Plays the backend's TTS stream.
 *
 * `POST /api/jarvis/tts` answers with raw float32 little-endian mono PCM as XTTS
 * produces it (the WS variant is the one that plays on the laptop; this one hands
 * the audio to the caller). So: convert to PCM16 and push it into an AudioTrack
 * in streaming mode, which starts speaking while the rest is still arriving —
 * XTTS synthesises faster than realtime, so the reply begins almost at once.
 *
 * `onLevel` feeds the hologram, so the core pulses with Jarvis's own voice.
 */
class PcmPlayer {
    private companion object {
        const val TAG = "JarvisPcm"
    }

    @Volatile private var track: AudioTrack? = null
    @Volatile private var stopped = false

    /** Blocking: returns when playback finished, the stream ended, or [stop] was called. */
    fun play(input: InputStream, sampleRate: Int, onLevel: (Float) -> Unit) {
        stopped = false
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(4096)
        val at = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(minBuf * 4)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = at

        try {
            at.play()
            val bytes = ByteArray(8192)
            val shorts = ShortArray(bytes.size / 4)
            // A chunked HTTP body hands over arbitrary byte counts, so a float32
            // sample routinely straddles two reads. The leftover 1-3 bytes are
            // carried to the front of the next one; dropping them instead would
            // shift every sample after it and turn the voice into noise.
            var carry = 0
            while (!stopped) {
                val r = input.read(bytes, carry, bytes.size - carry)
                if (r < 0) break
                val total = carry + r
                val usable = total - total % 4
                if (usable > 0) {
                    val floats = ByteBuffer.wrap(bytes, 0, usable)
                        .order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
                    val n = floats.remaining()
                    var peak = 0f
                    for (i in 0 until n) {
                        val f = floats.get(i)
                        if (abs(f) > peak) peak = abs(f)
                        shorts[i] = (f.coerceIn(-1f, 1f) * 32767f).toInt().toShort()
                    }
                    onLevel(min(1f, peak * 1.6f))
                    at.write(shorts, 0, n)
                }
                carry = total - usable
                if (carry > 0) System.arraycopy(bytes, usable, bytes, 0, carry)
            }
            if (!stopped) at.stop()  // drains what is already queued
        } catch (e: Exception) {
            Log.w(TAG, "playback failed: ${e.message}")
        } finally {
            onLevel(0f)
            try { at.release() } catch (e: Exception) { }
            track = null
        }
    }

    fun stop() {
        stopped = true
        val t = track
        try {
            if (t?.state == AudioTrack.STATE_INITIALIZED) t.pause()
            t?.flush()
        } catch (e: Exception) { }
    }
}
