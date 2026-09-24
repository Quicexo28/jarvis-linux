import { useEffect, useRef } from 'react'
import { acquireMic, releaseMic } from '../audio/micFeed'
import { isTtsSpeaking } from '../audio/ttsLevelBus'
import { ClapEngine, CLAP_DEFAULTS, lowBandShare, highBandShare } from '../audio/clapEngine'

interface ClapDetectionOptions {
  enabled: boolean
  onDoubleClap: () => void
  /** Logs every loud-frame's metrics to the console so thresholds can be
   *  calibrated against the real microphone/room. Off in production. */
  debug?: boolean
}

// Adaptador WebAudio del detector de doble aplauso. Toda la lógica DSP (gates,
// emparejado, umbrales medidos) vive en `audio/clapEngine.ts`, que es puro y se
// testea en Node — aquí sólo se abre el micro compartido y se bombean frames.

const FRAME_MS = 10
const FFT_SIZE = 512
/** Silencia la detección un poco más allá del final del TTS (cola + latencia BT). */
const TTS_TAIL_MS = 400
/**
 * Sordera inicial al arrancar el detector. Éste se enciende en el instante en
 * que Jarvis pasa a DORMANT (típicamente porque acabas de cerrarlo con Super+W),
 * y el ruido de ese momento — teclado, silla, la propia palmada — puede colar un
 * par de transitorios y reabrir la ventana que acabas de cerrar.
 */
const STARTUP_DEAF_MS = 2000

export function useClapDetection({ enabled, onDoubleClap, debug = false }: ClapDetectionOptions) {
  const callbackRef = useRef(onDoubleClap)
  callbackRef.current = onDoubleClap

  useEffect(() => {
    if (!enabled) return

    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let intervalId: ReturnType<typeof setInterval> | null = null
    let keepAliveId: ReturnType<typeof setInterval> | null = null
    let cancelled = false
    let engine: ClapEngine | null = null
    let lowBinsRef = 12
    let highBinsRef = 31

    const freqBuf = new Uint8Array(FFT_SIZE / 2)
    const timeBuf = new Uint8Array(FFT_SIZE)

    // Watchdog de calibración: cada 2 s saca el frame MÁS fuerte visto y sus
    // features. Sin esto, "no detectó" no distingue entre micro mudo,
    // AudioContext suspendido y umbral mal puesto.
    let wdAt = 0
    let wdMaxRms = 0
    let wdHigh = 0
    let wdLow = 0
    const wdBands = new Array<number>(8).fill(0)

    const loop = () => {
      if (!analyser || !engine) return
      analyser.getByteFrequencyData(freqBuf)
      analyser.getByteTimeDomainData(timeBuf)

      let sumSq = 0
      for (let i = 0; i < timeBuf.length; i++) {
        const v = (timeBuf[i] - 128) / 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / timeBuf.length)
      const now = performance.now()

      // Mientras Jarvis habla su propio audio no debe contar como aplauso (el
      // AEC de PipeWire no cancela del todo a volumen alto).
      if (isTtsSpeaking()) engine.suppressUntil(now + TTS_TAIL_MS)

      if (debug) {
        if (rms > wdMaxRms) {
          wdMaxRms = rms
          wdHigh = highBandShare(freqBuf, highBinsRef)
          wdLow  = lowBandShare(freqBuf, lowBinsRef)
          // Media de cada octavo del espectro (32 bins ≈ 2.7 kHz a 44.1 kHz):
          // la forma real que ve WebKitGTK, que NO coincide con el modelo
          // teórico de getByteFrequencyData.
          for (let g = 0; g < 8; g++) {
            let s = 0
            for (let i = g * 32; i < (g + 1) * 32; i++) s += freqBuf[i]
            wdBands[g] = s / 32
          }
        }
        if (now - wdAt > 2000) {
          console.log(`[clap-wd] max_rms=${wdMaxRms.toFixed(3)} high=${wdHigh.toFixed(2)} ` +
                      `low=${wdLow.toFixed(2)} bands=${wdBands.map((v) => Math.round(v)).join(',')}`)
          wdAt = now; wdMaxRms = 0
        }
      }

      const event = engine.push({ rms, freq: freqBuf, now })

      if (event.type === 'double') {
        console.log(`[clap] DOBLE APLAUSO gap=${Math.round(event.gapMs)}ms sim=${event.similarity.toFixed(2)}`)
        callbackRef.current()
      } else if (debug && event.type !== 'none') {
        console.log(`[clap] ${JSON.stringify(event)}`)
      }
    }

    // Micro COMPARTIDO. Las constraints (noiseSuppression off — la supresión del
    // navegador se come justo los transitorios del aplauso — y AGC off) viven en
    // audio/micFeed.ts. Abrir un stream propio aquí es lo que hacía crashear el
    // WebProcess al cambiar de modo de voz.
    let held = false
    acquireMic()
      .then((s) => {
        if (cancelled) { releaseMic(); return }
        held     = true
        audioCtx = new AudioContext()
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = FFT_SIZE
        // Default 0.8 time-averages frames and smears the transient we rely on.
        analyser.smoothingTimeConstant = 0
        audioCtx.createMediaStreamSource(s).connect(analyser)

        // Ancho de bin = sampleRate / fftSize (≈93.75 Hz a 48 kHz).
        const binHz = audioCtx.sampleRate / FFT_SIZE
        const lowBins = Math.max(1, Math.round(CLAP_DEFAULTS.lowBandHz / binHz))
        const highBins = Math.max(lowBins + 1, Math.round(CLAP_DEFAULTS.highBandHz / binHz))
        lowBinsRef = lowBins
        highBinsRef = highBins
        engine = new ClapEngine(lowBins, highBins)
        engine.suppressUntil(performance.now() + STARTUP_DEAF_MS)
        console.log(`[clap] detector activo (sampleRate=${audioCtx.sampleRate}, lowBins=${lowBins}, highBins=${highBins}, sordo ${STARTUP_DEAF_MS}ms)`)

        audioCtx.onstatechange = () => {
          if (audioCtx?.state === 'suspended') audioCtx.resume()
        }
        keepAliveId = setInterval(() => {
          if (audioCtx?.state === 'suspended') audioCtx.resume()
        }, 2000)

        intervalId = setInterval(loop, FRAME_MS)
      })
      .catch((err) => console.warn('[clap] no se pudo abrir el micro', err))

    return () => {
      cancelled = true
      if (intervalId  !== null) clearInterval(intervalId)
      if (keepAliveId !== null) clearInterval(keepAliveId)
      // stream compartido: sólo soltar la referencia (nunca parar sus tracks).
      if (held) releaseMic()
      audioCtx?.close()
    }
  }, [enabled, debug])
}
