/**
 * Renderer primitives — the verb set that self-built backend skills compose via
 * the skill bus. Each primitive runs in the browser (where camera/permissions
 * live) and returns a JSON-serializable result.
 *
 * Add a new verb here only when a self-built skill needs a genuinely new
 * renderer capability; skills compose existing verbs in the backend without any
 * frontend change.
 */

type Primitive = (payload: any) => Promise<unknown>

/** List the input devices the OS exposes to the browser. */
async function enumerateDevices(): Promise<unknown> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const cameras = devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Cámara ${i + 1}` }))
  const microphones = devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Micrófono ${i + 1}` }))
  return { cameras, microphones }
}

/** Find an already-playing hidden <video> (e.g. the gesture pipeline's). */
function findLiveVideo(): HTMLVideoElement | null {
  const vids = Array.from(document.querySelectorAll('video'))
  for (const v of vids) {
    if (v.srcObject && v.readyState >= 2 && v.videoWidth > 0) return v
  }
  return null
}

function frameToDataUrl(video: HTMLVideoElement): { dataUrl: string; width: number; height: number } {
  const w = video.videoWidth
  const h = video.videoHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no_canvas_context')
  ctx.drawImage(video, 0, 0, w, h)
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: w, height: h }
}

/**
 * Capture a still frame. Reuses a live camera stream if one is already running
 * (no permission flash); otherwise opens the requested/default camera briefly.
 * payload: { deviceId?: string, reuseLive?: boolean }
 */
async function capturePhoto(payload: { deviceId?: string; reuseLive?: boolean } = {}): Promise<unknown> {
  const { deviceId, reuseLive = true } = payload

  if (reuseLive && !deviceId) {
    const live = findLiveVideo()
    if (live) return { ...frameToDataUrl(live), source: 'live' }
  }

  const constraints: MediaStreamConstraints = {
    video: deviceId ? { deviceId: { exact: deviceId } } : { width: 1280, height: 720, facingMode: 'user' },
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  try {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    await video.play()
    // Let exposure/auto-focus settle before grabbing the frame.
    await new Promise((r) => setTimeout(r, 350))
    return { ...frameToDataUrl(video), source: 'fresh' }
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}

/** Show a transient notification in the UI. payload: { text: string } */
async function notify(payload: { text?: string } = {}): Promise<unknown> {
  const text = String(payload.text ?? '')
  window.dispatchEvent(new CustomEvent('jarvis:notify', { detail: { text } }))
  return { shown: true }
}

/**
 * Show the on-screen card with content awkward to verbalize (path/url/formula/
 * text/markdown/candidates). payload is a DisplayCardData.
 */
async function displayShow(payload: any = {}): Promise<unknown> {
  const kind = payload?.kind
  if (!['path', 'url', 'formula', 'text', 'markdown', 'candidates'].includes(kind)) {
    throw new Error('invalid_display_kind')
  }
  useDisplayStore.getState().show(payload)
  return { shown: true, kind }
}

/** Hide the on-screen card. */
async function displayHide(): Promise<unknown> {
  useDisplayStore.getState().hide()
  return { hidden: true }
}

/** Show the 3D model viewer. payload is a Model3DSpec. */
async function model3dShow(payload: any = {}): Promise<unknown> {
  const kind = payload?.kind
  if (!['parametric', 'polytope', 'implicit'].includes(kind)) throw new Error('invalid_model3d_kind')
  useModel3dStore.getState().show(payload as Model3DSpec)
  return { shown: true, kind, title: payload.title ?? '' }
}

/** Hide the 3D model viewer. */
async function model3dHide(): Promise<unknown> {
  useModel3dStore.getState().hide()
  return { hidden: true }
}

async function pickFile(_payload: { title?: string; multiple?: boolean; directory?: boolean } = {}): Promise<unknown> {
  throw new Error('picker_unavailable')
}

import { useJarvisStore } from '../state/jarvisStore'
import { useTimerStore } from '../state/timerStore'
import { useChronoStore } from '../state/chronoStore'
import { useDisplayStore } from '../state/displayStore'
import { useModel3dStore, type Model3DSpec } from '../state/model3dStore'
import type { Mode } from '../types'

/** Open a mode panel/canvas. payload: { mode: Mode, subRing?: boolean } */
async function modeOpen(payload: { mode: Mode; subRing?: boolean } = { mode: 'home' }): Promise<unknown> {
  const { mode, subRing } = payload
  const store = useJarvisStore.getState()
  // Sub-ring entries: route through ring-level so the carousel state is
  // consistent (timer/chrono live under utils-sub; plan3d/space/plan2d under house-sub).
  if (mode === 'timer' || mode === 'chrono') {
    store.setRingLevel('utils-sub')
    store.setActiveRingMode(mode)
  } else if (mode === 'plan3d' || mode === 'space' || mode === 'plan2d') {
    store.setRingLevel('house-sub')
    store.setActiveRingMode(mode)
  } else {
    store.setRingLevel('main')
    store.setActiveRingMode(mode)
  }
  store.setZoomedMode(mode)
  return { opened: mode, subRing: subRing ?? false }
}

/* ---- Timer primitives ---- */
async function timerCreate(payload: { label?: string; seconds?: number; durationMs?: number } = {}): Promise<unknown> {
  const durationMs = payload.durationMs ?? (Number(payload.seconds ?? 0) * 1000)
  if (!durationMs || durationMs < 1000) throw new Error('invalid_duration')
  const entry = useTimerStore.getState().create({ label: payload.label, durationMs })
  return { id: entry.id, label: entry.label, durationMs: entry.durationMs }
}

async function timerPause(payload: { id?: string; label?: string } = {}): Promise<unknown> {
  const store = useTimerStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  store.pause(target)
  return { paused: target ?? 'all_running' }
}

async function timerResume(payload: { id?: string; label?: string } = {}): Promise<unknown> {
  const store = useTimerStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  store.resume(target)
  return { resumed: target ?? 'all_paused' }
}

async function timerAdd(payload: { id?: string; label?: string; deltaMs?: number; seconds?: number } = {}): Promise<unknown> {
  const delta = payload.deltaMs ?? (Number(payload.seconds ?? 0) * 1000)
  if (!delta) throw new Error('invalid_delta')
  const store = useTimerStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  store.add(target, delta)
  return { added: delta, id: target ?? 'all_active' }
}

async function timerCancel(payload: { id?: string; label?: string; all?: boolean } = {}): Promise<unknown> {
  const store = useTimerStore.getState()
  if (payload.all) { store.cancelAll(); return { cancelled: 'all' } }
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  if (!target) throw new Error('not_found')
  store.cancel(target)
  return { cancelled: target }
}

async function timerReset(payload: { id?: string; label?: string } = {}): Promise<unknown> {
  const store = useTimerStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  store.reset(target)
  return { reset: target ?? 'all' }
}

async function timerList(): Promise<unknown> {
  return { timers: useTimerStore.getState().timers }
}

/* ---- Chrono primitives ---- */
async function chronoCreate(payload: { label?: string; autoStart?: boolean } = {}): Promise<unknown> {
  const entry = useChronoStore.getState().create({ label: payload.label, autoStart: payload.autoStart ?? true })
  return { id: entry.id, label: entry.label }
}

async function chronoStart(payload: { id?: string; label?: string } = {}): Promise<unknown> {
  const store = useChronoStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  // If no chrono exists yet, create one started.
  if (!target && store.chronos.length === 0) {
    const entry = store.create({ label: payload.label, autoStart: true })
    return { started: entry.id, label: entry.label }
  }
  store.start(target)
  return { started: target ?? 'all' }
}

async function chronoPause(payload: { id?: string; label?: string } = {}): Promise<unknown> {
  const store = useChronoStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  store.pause(target)
  return { paused: target ?? 'all_running' }
}

async function chronoReset(payload: { id?: string; label?: string } = {}): Promise<unknown> {
  const store = useChronoStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  store.reset(target)
  return { reset: target ?? 'all' }
}

async function chronoLap(payload: { id?: string; label?: string } = {}): Promise<unknown> {
  const store = useChronoStore.getState()
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  store.lap(target)
  return { lapped: target ?? 'all_running' }
}

async function chronoCancel(payload: { id?: string; label?: string; all?: boolean } = {}): Promise<unknown> {
  const store = useChronoStore.getState()
  if (payload.all) { store.cancelAll(); return { cancelled: 'all' } }
  const target = payload.id ?? (payload.label ? store.findByLabel(payload.label)?.id : undefined)
  if (!target) throw new Error('not_found')
  store.cancel(target)
  return { cancelled: target }
}

async function chronoList(): Promise<unknown> {
  return { chronos: useChronoStore.getState().chronos }
}

/* ---- Navigation primitives ---- */
import { useBootStore } from '../state/bootStore'
import { useUiStore, type OverlayName } from '../state/uiStore'

const VALID_MODES: ReadonlyArray<Mode> = [
  'home', 'house', 'plan2d', 'plan3d', 'space', 'cloud', 'system', 'mobile', 'utils', 'timer', 'chrono',
]

const VALID_OVERLAYS: ReadonlyArray<OverlayName> = [
  'terminal', 'gesture_debug', 'gesture_trainer', 'speaker_config',
]

async function viewOpen(payload: { view?: string } = {}): Promise<unknown> {
  const view = payload.view as Mode
  if (!view || !VALID_MODES.includes(view)) throw new Error('invalid_view')
  return modeOpen({ mode: view })
}

async function viewClose(): Promise<unknown> {
  const store = useJarvisStore.getState()
  if (store.zoomedMode != null) {
    store.setZoomedMode(null)
    return { closed: 'zoom' }
  }
  if (store.ringLevel !== 'main') {
    store.setRingLevel('main')
    return { closed: 'sub_ring' }
  }
  return { closed: 'noop' }
}

async function viewCurrent(): Promise<unknown> {
  const j = useJarvisStore.getState()
  const b = useBootStore.getState()
  const u = useUiStore.getState()
  return {
    mode: j.mode,
    zoomedMode: j.zoomedMode,
    ringLevel: j.ringLevel,
    activeRingMode: j.activeRingMode,
    bootState: b.bootState,
    overlays: {
      terminal: u.terminalOpen,
      gesture_debug: u.gestureDebugOpen,
      gesture_trainer: u.gestureTrainerOpen,
      speaker_config: u.speakerConfigOpen,
    },
    voiceEnabled: j.voiceEnabled,
    clapWakeEnabled: j.clapWakeEnabled,
  }
}

async function ringRotate(payload: { direction?: 'left' | 'right'; steps?: number } = {}): Promise<unknown> {
  const dir: 1 | -1 = payload.direction === 'left' ? -1 : 1
  const steps = Math.max(1, Math.min(10, Number(payload.steps ?? 1)))
  const store = useJarvisStore.getState()
  for (let i = 0; i < steps; i++) store.rotateRing(dir)
  return { rotated: steps, direction: dir === 1 ? 'right' : 'left', activeRingMode: useJarvisStore.getState().activeRingMode }
}

async function overlayOpen(payload: { name?: string } = {}): Promise<unknown> {
  const name = payload.name as OverlayName
  if (!name || !VALID_OVERLAYS.includes(name)) throw new Error('invalid_overlay')
  useUiStore.getState().setOverlay(name, true)
  return { opened: name }
}

async function overlayClose(payload: { name?: string } = {}): Promise<unknown> {
  const name = payload.name as OverlayName
  if (!name || !VALID_OVERLAYS.includes(name)) throw new Error('invalid_overlay')
  useUiStore.getState().setOverlay(name, false)
  return { closed: name }
}

async function sleepSystem(): Promise<unknown> {
  useBootStore.getState().setBootState('DORMANT')
  return { boot: 'DORMANT' }
}

async function toggleVoice(payload: { enabled?: boolean } = {}): Promise<unknown> {
  const store = useJarvisStore.getState()
  const next = typeof payload.enabled === 'boolean' ? payload.enabled : !store.voiceEnabled
  store.setVoiceEnabled(next)
  return { voiceEnabled: next }
}

async function toggleClapWake(payload: { enabled?: boolean } = {}): Promise<unknown> {
  const store = useJarvisStore.getState()
  const next = typeof payload.enabled === 'boolean' ? payload.enabled : !store.clapWakeEnabled
  store.setClapWakeEnabled(next)
  return { clapWakeEnabled: next }
}

const PRIMITIVES: Record<string, Primitive> = {
  enumerate_devices: enumerateDevices,
  capture_photo: capturePhoto,
  notify,
  display_show: displayShow,
  display_hide: displayHide,
  pick_file: pickFile,
  model3d_show: model3dShow,
  model3d_hide: model3dHide,
  mode_open: modeOpen,
  timer_create: timerCreate,
  timer_pause: timerPause,
  timer_resume: timerResume,
  timer_add: timerAdd,
  timer_cancel: timerCancel,
  timer_reset: timerReset,
  timer_list: timerList,
  chrono_create: chronoCreate,
  chrono_start: chronoStart,
  chrono_pause: chronoPause,
  chrono_reset: chronoReset,
  chrono_lap: chronoLap,
  chrono_cancel: chronoCancel,
  chrono_list: chronoList,
  view_open: viewOpen,
  view_close: viewClose,
  view_current: viewCurrent,
  ring_rotate: ringRotate,
  overlay_open: overlayOpen,
  overlay_close: overlayClose,
  sleep_system: sleepSystem,
  toggle_voice: toggleVoice,
  toggle_clap_wake: toggleClapWake,
}

/**
 * Run a primitive by verb. Throws 'unknown_verb' if not registered, so the
 * backend skill can fall back to a native path.
 */
export async function runPrimitive(verb: string, payload: unknown): Promise<unknown> {
  const fn = PRIMITIVES[verb]
  if (!fn) throw new Error('unknown_verb:' + verb)
  return fn(payload ?? {})
}
