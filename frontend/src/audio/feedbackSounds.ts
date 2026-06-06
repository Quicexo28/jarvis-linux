/**
 * Procedural audio feedback sounds for Jarvis state transitions.
 *
 * All sounds are generated via Web Audio API oscillators — no audio files needed.
 * Kept very subtle (gain 0.05-0.12) for premium, non-intrusive feel.
 */

let audioCtx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

function playTone(
  freq: number,
  duration: number,
  gain: number,
  type: OscillatorType = 'sine',
  fadeOut = true,
) {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const vol = ctx.createGain()

  osc.type = type
  osc.frequency.value = freq
  vol.gain.value = gain

  if (fadeOut) {
    vol.gain.setValueAtTime(gain, ctx.currentTime)
    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)
  }

  osc.connect(vol)
  vol.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + duration)
}

/** Soft rising chime — wake acknowledged. */
export function playWakeAck() {
  const ctx = getCtx()
  const now = ctx.currentTime

  // Two-note ascending chime
  const notes = [440, 660]
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    const vol = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    vol.gain.setValueAtTime(0, now + i * 0.08)
    vol.gain.linearRampToValueAtTime(0.08, now + i * 0.08 + 0.02)
    vol.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.15)
    osc.connect(vol)
    vol.connect(ctx.destination)
    osc.start(now + i * 0.08)
    osc.stop(now + i * 0.08 + 0.15)
  })
}

/** Subtle presence tone — Jarvis is listening (attentive state entered). */
export function playPresence() {
  playTone(520, 0.3, 0.04, 'sine')
}

/** Processing indicator — gentle ambient hum. */
export function playProcessing() {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const vol = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = 220
  vol.gain.value = 0.03
  vol.gain.setValueAtTime(0.03, ctx.currentTime)
  vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8)
  osc.connect(vol)
  vol.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + 0.8)
}

/** Low descending note — error or timeout. */
export function playError() {
  const ctx = getCtx()
  const osc = ctx.createOscillator()
  const vol = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(330, ctx.currentTime)
  osc.frequency.exponentialRampToValueAtTime(165, ctx.currentTime + 0.3)
  vol.gain.value = 0.06
  vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
  osc.connect(vol)
  vol.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + 0.35)
}

/** Very subtle "response starting" tone. */
export function playResponseStart() {
  playTone(587, 0.12, 0.05, 'sine')
}
