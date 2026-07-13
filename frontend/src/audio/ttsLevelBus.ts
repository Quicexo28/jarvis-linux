// Voice-level bus for UI reactivity (core hologram breathing with Jarvis's voice).
//
// TTS audio plays SERVER-side (paplay), so the browser never sees the PCM on
// the main path. Instead the backend streams {type:"levels", t0, dt, v:[...]}
// envelope events over the TTS WebSocket: RMS per 100ms block, t0 = seconds
// into the reply's audio timeline. Because synthesis outruns playback, events
// arrive AHEAD of the sound — this bus re-anchors the audio timeline onto
// performance.now() (plus a fixed output-latency guess) and hands out the
// level that is *currently audible*, not the one just synthesized.
//
// Deliberately outside React/zustand: consumers poll getTtsLevel() from a
// render loop (useFrame) at 60fps; pushing that through state would re-render
// the tree every frame for nothing.

const OUTPUT_LATENCY_MS = 300 // pipe (ffmpeg+paplay) + Bluetooth guess

let speaking = false
let anchorMs = 0 // performance.now() at which stream t=0 becomes audible
let points: { t: number; v: number }[] = []
let lastV = 0

/** A reply started (TTS session opened). Resets the timeline. */
export function ttsBusStart(): void {
  speaking = true
  holoAwake = true
  anchorMs = 0
  points = []
}

/** Envelope block from the server: values v[] start at t0, one per dt seconds. */
export function ttsBusLevels(t0: number, dt: number, v: number[]): void {
  if (!speaking) return
  if (!anchorMs) anchorMs = performance.now() + OUTPUT_LATENCY_MS - t0 * 1000
  for (let i = 0; i < v.length; i++) points.push({ t: t0 + i * dt, v: v[i] })
}

/** Reply finished / aborted — level decays back to 0 via getTtsLevel(). */
export function ttsBusEnd(): void {
  speaking = false
  anchorMs = 0
  points = []
}

export function isTtsSpeaking(): boolean {
  return speaking
}

// ---------------------------------------------------------------------------
// Thinking state: set while a turn is being processed (utterance sent to the
// brain, no spoken reply yet). The core hologram grows during this window and
// inflates further once TTS starts.

let thinking = false

export function ttsBusThinking(on: boolean): void {
  thinking = on
  if (on) holoAwake = true
}

export function isTtsThinking(): boolean {
  return thinking
}

// ---------------------------------------------------------------------------
// Boot state: from app launch until Jarvis's first activity (first turn or
// first spoken reply) the hologram stays "not yet active" — a bare point.
// One-way latch; never resets until page reload.

let holoAwake = false

export function isHoloAwake(): boolean {
  return holoAwake
}

/**
 * Smoothed 0..1 level of what's playing right now. Call once per animation
 * frame — smoothing state advances per call.
 */
export function getTtsLevel(): number {
  let target = 0
  if (speaking && anchorMs) {
    const tNow = (performance.now() - anchorMs) / 1000
    while (points.length > 1 && points[1].t <= tNow) points.shift()
    if (points.length && points[0].t <= tNow) target = points[0].v
  }
  lastV += (target - lastV) * 0.30
  if (lastV < 0.003) lastV = 0
  return lastV
}
