package com.jarvis.companion.wall

import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.ArrayDeque

/**
 * H.264 por hardware (c2.allwinner.avc.decoder) → Surface del SurfaceTexture.
 *
 * Modo asíncrono en un hilo propio. Los frames llegan del hilo del WebSocket,
 * se copian (el ByteBuffer de OkHttp no sobrevive a la llamada) y se meten en
 * el codec en cuanto hay buffer de entrada. Cada salida se pinta al momento:
 * para una pared en directo, latencia antes que suavidad.
 *
 * v3, `avDelayMs`: el audio sale por el PC (Echo Dot) y llega tarde respecto
 * a la imagen. El retraso se aplica ANTES del decoder, con el vídeo aún
 * comprimido (500 ms a 12 Mbps ≈ 750 KB): retener frames ya decodificados
 * agotaría los pocos buffers de salida del codec y lo pararía.
 */
class VideoDecoder(private val surface: Surface, val width: Int, val height: Int) {

    companion object {
        private const val TAG = "WallDecoder"
        // Medio segundo a 60 fps: si se acumula más, el decoder no da abasto y
        // es mejor saltar al siguiente keyframe que mostrar el pasado.
        private const val MAX_PENDING = 30
        // Búfer de retraso: 500 ms a 60 fps son 30 frames; holgura para ráfagas.
        private const val MAX_DELAYED = 120
    }

    private class Frame(val data: ByteArray, val key: Boolean, val ptsUs: Long, var arrivedMs: Long, val dueAt: Long = 0)

    private val thread = HandlerThread("wall-codec").apply { start() }
    private val handler = Handler(thread.looper)
    private var codec: MediaCodec? = null
    private val freeInputs = ArrayDeque<Int>()
    private val pending = ArrayDeque<Frame>()
    private var waitKey = true
    private var released = false
    private val arrivals = HashMap<Long, Long>()
    private val delayed = ArrayDeque<Frame>()
    private val pump = Runnable { pumpDelayed() }

    // Estadísticas para `{t:"stats"}`.
    @Volatile var rendered = 0L; private set
    @Volatile var dropped = 0L; private set
    private var decodeMsSum = 0.0
    private var decodeMsCount = 0

    /** Hilo del WebSocket. */
    fun offer(au: ByteBuffer, key: Boolean, ptsUs: Long) {
        val copy = ByteArray(au.remaining())
        au.get(copy)
        val delay = WallHub.avDelayMs
        val now = SystemClock.uptimeMillis()
        val f = Frame(copy, key, ptsUs, SystemClock.elapsedRealtime(), now + delay)
        handler.post { if (delay <= 0 && delayed.isEmpty()) enqueue(f) else hold(f) }
    }

    /**
     * En orden siempre: si el retraso baja, los frames nuevos esperan detrás
     * de los ya retenidos (un salto hacia delante de una vez, sin desordenar).
     */
    private fun hold(f: Frame) {
        if (released) return
        if (delayed.size >= MAX_DELAYED) {
            dropped += delayed.size
            delayed.clear()
            waitKey = true
        }
        val due = maxOf(f.dueAt, delayed.peekLast()?.dueAt ?: 0L)
        val g = Frame(f.data, f.key, f.ptsUs, f.arrivedMs, due)
        delayed.add(g)
        if (delayed.size == 1) handler.postAtTime(pump, due)
    }

    private fun pumpDelayed() {
        val now = SystemClock.uptimeMillis()
        while (true) {
            val f = delayed.peekFirst() ?: return
            if (f.dueAt > now) { handler.postAtTime(pump, f.dueAt); return }
            delayed.pollFirst()
            // decodeMs mide el decoder, no el retraso a propósito.
            f.arrivedMs = SystemClock.elapsedRealtime()
            enqueue(f)
        }
    }

    private fun enqueue(f: Frame) {
        if (released) return
        if (waitKey) {
            if (!f.key) { dropped++; return }
            waitKey = false
        }
        if (codec == null && !configure(f)) { waitKey = true; return }
        if (f.key && pending.isNotEmpty()) {
            // Un keyframe deja obsoleto todo lo que estaba en cola.
            dropped += pending.size
            pending.clear()
        }
        pending.add(f)
        if (pending.size > MAX_PENDING) {
            dropped += pending.size
            pending.clear()
            waitKey = true
            return
        }
        drain()
    }

    private fun drain() {
        val c = codec ?: return
        while (pending.isNotEmpty() && freeInputs.isNotEmpty()) {
            val f = pending.poll()!!
            val idx = freeInputs.poll()!!
            try {
                val buf = c.getInputBuffer(idx) ?: continue
                buf.clear()
                if (f.data.size > buf.capacity()) {
                    Log.w(TAG, "AU de ${f.data.size} B no cabe en ${buf.capacity()} B")
                    c.queueInputBuffer(idx, 0, 0, f.ptsUs, 0)
                    dropped++
                    waitKey = true
                    continue
                }
                buf.put(f.data)
                arrivals[f.ptsUs] = f.arrivedMs
                c.queueInputBuffer(idx, 0, f.data.size, f.ptsUs, if (f.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            } catch (e: Exception) {
                Log.w(TAG, "queueInputBuffer: ${e.message}")
                restart()
                return
            }
        }
    }

    /**
     * Se configura con el primer keyframe: así csd-0/csd-1 salen del propio
     * stream y no hace falta adivinar perfil ni nivel.
     */
    private fun configure(first: Frame): Boolean {
        val (sps, pps) = paramSets(first.data)
        val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
        if (sps != null && pps != null) {
            fmt.setByteBuffer("csd-0", ByteBuffer.wrap(sps))
            fmt.setByteBuffer("csd-1", ByteBuffer.wrap(pps))
        }
        // Un keyframe de texto a 12 Mbps pasa de los 300 KB; el tamaño por
        // defecto del decoder se queda corto en streams pequeños.
        fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, maxOf(2 * 1024 * 1024, width * height * 2))
        if (Build.VERSION.SDK_INT >= 30) fmt.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        fmt.setInteger(MediaFormat.KEY_PRIORITY, 0) // tiempo real
        val name = pickDecoder(fmt)
        return try {
            val c = if (name != null) MediaCodec.createByCodecName(name) else MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.setCallback(callback, handler)
            c.configure(fmt, surface, null, 0)
            c.start()
            codec = c
            Log.i(TAG, "decoder ${c.name} ${width}x$height")
            true
        } catch (e: Exception) {
            Log.e(TAG, "no se pudo configurar el decoder: ${e.message}")
            false
        }
    }

    /** El HW de Allwinner primero; el que diga MediaCodecList si no. */
    private fun pickDecoder(fmt: MediaFormat): String? {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)
        val hw = list.codecInfos.firstOrNull { !it.isEncoder && it.name.startsWith("c2.allwinner.avc") }
        return hw?.name ?: list.findDecoderForFormat(fmt)
    }

    private val callback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(c: MediaCodec, index: Int) {
            if (c !== codec) return
            freeInputs.add(index)
            drain()
        }

        override fun onOutputBufferAvailable(c: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            if (c !== codec) return
            val arrived = arrivals.remove(info.presentationTimeUs)
            if (arrived != null) {
                decodeMsSum += (SystemClock.elapsedRealtime() - arrived).toDouble()
                decodeMsCount++
            }
            if (arrivals.size > 256) arrivals.clear()
            try {
                c.releaseOutputBuffer(index, true)
                rendered++
            } catch (e: Exception) { /* codec parándose */ }
        }

        override fun onError(c: MediaCodec, e: MediaCodec.CodecException) {
            if (c !== codec) return
            Log.w(TAG, "error del codec: ${e.diagnosticInfo} recuperable=${e.isRecoverable} transitorio=${e.isTransient}")
            restart()
        }

        override fun onOutputFormatChanged(c: MediaCodec, format: MediaFormat) {
            Log.i(TAG, "formato de salida: $format")
        }
    }

    /** Tras un error: codec nuevo en el siguiente keyframe. */
    private fun restart() {
        releaseCodec()
        waitKey = true
    }

    private fun releaseCodec() {
        val c = codec ?: return
        codec = null
        freeInputs.clear()
        pending.clear()
        arrivals.clear()
        try { c.stop() } catch (e: Exception) {}
        try { c.release() } catch (e: Exception) {}
    }

    /** Media de llegada → salida del decoder desde la última llamada. */
    fun takeDecodeMs(): Double {
        val v = if (decodeMsCount == 0) 0.0 else decodeMsSum / decodeMsCount
        decodeMsSum = 0.0
        decodeMsCount = 0
        return v
    }

    fun release() {
        handler.post {
            released = true
            handler.removeCallbacks(pump)
            delayed.clear()
            releaseCodec()
            thread.quitSafely()
        }
    }

    /** SPS y PPS (con su start code) del AU de un keyframe. */
    private fun paramSets(au: ByteArray): Pair<ByteArray?, ByteArray?> {
        var sps: ByteArray? = null
        var pps: ByteArray? = null
        val starts = ArrayList<Int>()
        var i = 0
        while (i + 3 < au.size) {
            if (au[i].toInt() == 0 && au[i + 1].toInt() == 0 && au[i + 2].toInt() == 1) { starts.add(i); i += 3; continue }
            i++
        }
        for ((n, s) in starts.withIndex()) {
            val begin = if (s > 0 && au[s - 1].toInt() == 0) s - 1 else s
            val end = if (n + 1 < starts.size) {
                val next = starts[n + 1]
                if (au[next - 1].toInt() == 0) next - 1 else next
            } else au.size
            val type = au[s + 3].toInt() and 0x1f
            if (type == 7) sps = au.copyOfRange(begin, end)
            if (type == 8) pps = au.copyOfRange(begin, end)
        }
        return Pair(sps, pps)
    }
}
