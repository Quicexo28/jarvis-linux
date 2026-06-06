import { useEffect, useRef } from 'react'

interface ClapDetectionOptions {
  enabled: boolean
  onDoubleClap: () => void
  /** Logs every loud-frame's metrics to the console so thresholds can be
   *  calibrated against the real microphone/room. Off in production. */
  debug?: boolean
}

// Pure DSP double-clap detector — no ML, no training data.
//
// A clap is a percussive broadband transient with four measurable signatures:
//   1. LOUD      — RMS jumps well above the adaptive noise floor.
//   2. SHARP     — near-instant attack (this frame ≫ previous frame).
//   3. PERCUSSIVE— high crest factor (peak/RMS): a spike, not a sustained level.
//   4. BROADBAND — high spectral flatness: energy spread across the spectrum,
//                  unlike the few dominant harmonics of speech/music.
// A double clap = two such onsets separated by 220–900 ms.
//
// Detection fires at the SECOND onset (not after it decays) → low latency and
// immune to reverb tails. A refractory window after each onset prevents a
// single clap's tail from registering as a second clap.

const FRAME_MS = 10
const FFT_SIZE = 512

const NOISE_ALPHA = 0.01        // noise-floor EMA — adapts to the room in ~1 s
const TRANSIENT_RATIO = 6       // LOUD:  rms > 6× noise floor
const RISE_RATIO = 2.5          // SHARP: rms[t] / rms[t-1] > 2.5
const CREST_MIN = 2.5           // PERCUSSIVE: peak / rms within the frame
const FLATNESS_MIN = 0.22       // BROADBAND: clap ≈ 0.3–0.8, speech ≈ 0.05–0.2
const REFRACTORY_MS = 150       // ignore a clap's own tail before allowing the next
const MIN_GAP_MS = 220          // tightest human double-clap spacing
const MAX_GAP_MS = 900          // loosest; beyond this the first clap is forgotten
const COOLDOWN_MS = 1500        // after a successful double clap

// Spectral flatness = geometric mean / arithmetic mean of the magnitude
// spectrum. ~1 = white-noise-like (broadband); ~0 = tonal (speech, music).
function spectralFlatness(freqData: Uint8Array): number {
  let logSum = 0, linSum = 0
  const n = freqData.length
  for (let i = 0; i < n; i++) {
    const v = freqData[i] + 1 // +1 avoids log(0)
    logSum += Math.log(v)
    linSum += v
  }
  return Math.exp(logSum / n) / (linSum / n)
}

export function useClapDetection({ enabled, onDoubleClap, debug = false }: ClapDetectionOptions) {
  const callbackRef = useRef(onDoubleClap)
  callbackRef.current = onDoubleClap

  useEffect(() => {
    if (!enabled) return

    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let stream: MediaStream | null = null
    let intervalId: ReturnType<typeof setInterval> | null = null
    let keepAliveId: ReturnType<typeof setInterval> | null = null

    const freqBuf = new Uint8Array(FFT_SIZE / 2)
    const timeBuf = new Uint8Array(FFT_SIZE)

    let noiseFloor     = 0.01
    let prevRms        = 0
    let firstClapAt    = 0  // timestamp of the pending first clap (0 = none)
    let refractoryUntil = 0
    let cooldownUntil  = 0

    const loop = () => {
      if (!analyser) return
      analyser.getByteFrequencyData(freqBuf)
      analyser.getByteTimeDomainData(timeBuf)

      // RMS + peak in one pass (peak feeds the crest-factor / percussive test).
      let sumSq = 0, peak = 0
      for (let i = 0; i < timeBuf.length; i++) {
        const v = (timeBuf[i] - 128) / 128
        sumSq += v * v
        const a = Math.abs(v)
        if (a > peak) peak = a
      }
      const curRms = Math.sqrt(sumSq / timeBuf.length)
      const now = performance.now()

      // Adapt the noise floor on quiet frames only, so claps never poison it.
      if (curRms < noiseFloor * 2.5) {
        noiseFloor = noiseFloor * (1 - NOISE_ALPHA) + curRms * NOISE_ALPHA
      }
      noiseFloor = Math.max(noiseFloor, 0.001)

      if (now < cooldownUntil || now < refractoryUntil) { prevRms = curRms; return }

      const isLoud  = curRms > noiseFloor * TRANSIENT_RATIO
      // Coming straight out of near-silence counts as a sharp attack even if the
      // ratio is muddied by a partially-filled previous frame.
      const isSharp = prevRms < noiseFloor * 2 || curRms / Math.max(prevRms, 1e-6) > RISE_RATIO
      const crest   = curRms > 1e-6 ? peak / curRms : 0
      const flatness = spectralFlatness(freqBuf)

      const isOnset = isLoud && isSharp && crest > CREST_MIN && flatness > FLATNESS_MIN

      if (debug && isLoud) {
        console.log(
          `[clap] rms=${curRms.toFixed(3)} floor=${noiseFloor.toFixed(3)} ` +
          `ratio=${(curRms / noiseFloor).toFixed(1)} rise=${(curRms / Math.max(prevRms, 1e-6)).toFixed(1)} ` +
          `crest=${crest.toFixed(1)} flat=${flatness.toFixed(2)} ` +
          `onset=${isOnset} gap=${firstClapAt ? Math.round(now - firstClapAt) : '-'}`
        )
      }

      if (isOnset) {
        const gap = now - firstClapAt
        if (firstClapAt > 0 && gap >= MIN_GAP_MS && gap <= MAX_GAP_MS) {
          firstClapAt = 0
          cooldownUntil = now + COOLDOWN_MS
          callbackRef.current()
        } else {
          firstClapAt = now // first clap of a (possibly new) pair
        }
        refractoryUntil = now + REFRACTORY_MS
      } else if (firstClapAt > 0 && now - firstClapAt > MAX_GAP_MS) {
        firstClapAt = 0 // the first clap got lonely — forget it
      }

      prevRms = curRms
    }

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          // Browser noise suppression attenuates exactly the broadband
          // transients claps produce; AGC would wander the noise-floor estimate.
          noiseSuppression: false,
          echoCancellation: true,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      })
      .then((s) => {
        stream   = s
        audioCtx = new AudioContext()
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = FFT_SIZE
        // Default 0.8 time-averages frames and smears the transient we rely on.
        analyser.smoothingTimeConstant = 0
        audioCtx.createMediaStreamSource(s).connect(analyser)

        audioCtx.onstatechange = () => {
          if (audioCtx?.state === 'suspended') audioCtx.resume()
        }
        keepAliveId = setInterval(() => {
          if (audioCtx?.state === 'suspended') audioCtx.resume()
        }, 2000)

        intervalId = setInterval(loop, FRAME_MS)
      })
      .catch(() => {})

    return () => {
      if (intervalId  !== null) clearInterval(intervalId)
      if (keepAliveId !== null) clearInterval(keepAliveId)
      stream?.getTracks().forEach((t) => t.stop())
      audioCtx?.close()
    }
  }, [enabled, debug])
}
