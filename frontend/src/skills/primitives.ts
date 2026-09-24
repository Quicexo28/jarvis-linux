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
/**
 * Say something out loud through the renderer's TTS. This is what lets the
 * BACKEND speak on its own initiative — proactive notices, and the verifier
 * telling the truth after a turn claimed something that never happened. Without
 * it every backend-side correction was silent.
 */
async function speakText(payload: any = {}): Promise<unknown> {
  const text = String(payload?.text ?? '').trim()
  if (!text) throw new Error('missing_text')
  if (text.length > 600) throw new Error('text_too_long')
  await speakThroughRenderer(text)
  return { spoken: true, chars: text.length }
}

async function displayHide(): Promise<unknown> {
  useDisplayStore.getState().hide()
  return { hidden: true }
}

/** Normalize a model3d payload: single spec, {objects:[...]} or {specs:[...]} → spec array. */
function model3dSpecs(payload: any): Model3DSpec[] {
  const list = Array.isArray(payload?.objects) ? payload.objects
    : Array.isArray(payload?.specs) ? payload.specs
    : [payload]
  if (!list.length) throw new Error('empty_model3d_specs')
  for (const s of list) {
    if (!MODEL3D_KINDS.includes(s?.kind)) throw new Error('invalid_model3d_kind')
  }
  return list as Model3DSpec[]
}

/** Show the 3D viewer. payload: single Model3DSpec, or { objects: Model3DSpec[], scene? }. */
async function model3dShow(payload: any = {}): Promise<unknown> {
  const specs = model3dSpecs(payload)
  useModel3dStore.getState().show(specs, payload?.scene)
  return { shown: true, count: specs.length, kinds: specs.map((s) => s.kind) }
}

/** Append object(s) to the current 3D scene without clearing it. */
async function model3dAdd(payload: any = {}): Promise<unknown> {
  const specs = model3dSpecs(payload)
  useModel3dStore.getState().add(specs)
  return { added: specs.length, total: useModel3dStore.getState().objects.length }
}

/** Transport control for a running simulation (play/pause/speed/reset).
 *  Separate from show/add because it must NOT rebuild the scene: rebuilding
 *  would restart the physics, which is the opposite of "pause it". */
async function model3dSim(payload: any = {}): Promise<unknown> {
  const store = useSimStore.getState()
  switch (String(payload?.action ?? 'toggle')) {
    case 'play': store.setPlaying(true); break
    case 'pause': store.setPlaying(false); break
    case 'reset': store.reset(); break
    case 'speed': {
      const v = Number(payload?.speed)
      if (!isFinite(v) || v <= 0) throw new Error('invalid_speed')
      store.setSpeed(v)
      break
    }
    case 'toggle': store.toggle(); break
    default: throw new Error('invalid_action')
  }
  const now = useSimStore.getState()
  // `active` no puede salir solo del simStore de ESTA ventana: con el proyector
  // encendido el visor se monta en la ventana `wall`, que tiene su propio store.
  // El contenido sí se conoce aquí, así que la verdad sobre "¿hay simulación?"
  // se lee del model3dStore, que es el que se espeja.
  const m = useModel3dStore.getState()
  const onScreen = m.open && m.objects.some((o) => o.kind === 'simulation')
  return {
    active: now.active || onScreen,
    playing: now.playing,
    speed: now.speed,
    title: now.title || (onScreen ? 'Simulación' : ''),
  }
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
import { useVaultGraphStore, resolveNodeRef } from '../state/vaultGraphStore'
import { speakThroughRenderer } from './speakBridge'
import { useTimerStore } from '../state/timerStore'
import { useChronoStore } from '../state/chronoStore'
import { useDisplayStore } from '../state/displayStore'
import { useModel3dStore, MODEL3D_KINDS, type Model3DSpec } from '../state/model3dStore'
import { useSimStore } from '../state/simStore'
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
import { useGestureStore } from '../state/gestureStore'

const VALID_MODES: ReadonlyArray<Mode> = [
  'home', 'house', 'plan2d', 'plan3d', 'space', 'cloud', 'system', 'mobile', 'utils', 'timer', 'chrono',
  'vault',
]

const VALID_OVERLAYS: ReadonlyArray<OverlayName> = [
  'terminal', 'gesture_debug', 'speaker_config',
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
      speaker_config: u.speakerConfigOpen,
    },
    voiceEnabled: j.voiceEnabled,
    clapWakeEnabled: j.clapWakeEnabled,
  }
}

/**
 * Enfoca un nodo del grafo de conocimiento.
 *
 * Abre la vista si hace falta y espera el grafo antes de resolver: pedir "enfoca
 * la nota de física" con la vista cerrada tenía que funcionar igual, o el señor
 * acabaría dando dos órdenes para una sola intención.
 *
 * Devuelve el nodo resuelto, no un `{ok:true}`: el verificador de turnos
 * comprueba postcondiciones, y "enfoqué algo" sin decir QUÉ es indistinguible
 * de haber enfocado el nodo equivocado.
 */
async function vaultFocus(payload: { node?: string } = {}): Promise<unknown> {
  const ref = String(payload.node ?? '').trim()
  if (!ref) throw new Error('missing_node')

  await modeOpen({ mode: 'vault' })

  const store = useVaultGraphStore.getState()
  if (!store.data) await store.load()
  const data = useVaultGraphStore.getState().data
  if (!data) throw new Error('graph_unavailable')

  const node = resolveNodeRef(data.nodes, ref)
  if (!node) throw new Error('node_not_found')

  useVaultGraphStore.getState().setFocused(node.id)
  return { node: node.id, label: node.label, type: node.type, folder: node.folder, degree: node.degree }
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

async function voiceModeSet(payload: { mode?: string }): Promise<unknown> {
  const { setVoiceMode, voiceMode } = useJarvisStore.getState()
  const m = payload.mode
  if (m === 'off' || m === 'continuous' || m === 'wake_word' || m === 'ptt') {
    setVoiceMode(m)
    return { voiceMode: m }
  }
  return { voiceMode, error: 'unknown_mode' }
}

async function pttStart(): Promise<unknown> {
  useJarvisStore.getState().setPttActive(true)
  return { pttActive: true }
}

async function pttStop(): Promise<unknown> {
  useJarvisStore.getState().setPttActive(false)
  return { pttActive: false }
}

/** Enter PIP (mini window) mode. */
async function bootPip(): Promise<unknown> {
  useBootStore.getState().enterPip()
  try { window.resizeTo(400, 300) } catch {}
  return { bootState: 'PIP' }
}

/** Return to full-screen AWAKE mode from PIP. */
async function bootAwake(): Promise<unknown> {
  useBootStore.getState().leavePip()
  try { window.resizeTo(window.screen.width, window.screen.height) } catch {}
  return { bootState: 'AWAKE' }
}

/** Enable or disable the gesture pipeline. */
async function gestureSet(payload: { enabled?: boolean } = {}): Promise<unknown> {
  const enabled = Boolean(payload.enabled)
  useGestureStore.getState().setEnabled(enabled)
  return { gestureEnabled: enabled }
}

/** Estado vivo del pipeline de gestos — observabilidad remota (curl / brain).
 * Incluye el output actual: permite verificar por curl si un gesto está
 * llegando al store mientras alguien lo hace frente a la cámara. */
async function gestureStatus(): Promise<unknown> {
  const g = useGestureStore.getState()
  // `landmarks` es el health-check del canal único: cuántos consumidores lo
  // piden y si de verdad está llegando algo. Sin esto, comprobar la captura por
  // manos obligaba a mirar la pantalla.
  return {
    enabled: g.enabled,
    status: g.status,
    detail: g.statusDetail,
    fps: g.fps,
    landmarks: {
      consumers: g.landmarkConsumers,
      streaming: g.handsFrame !== null,
      left: Boolean(g.handsFrame?.left),
      right: Boolean(g.handsFrame?.right),
    },
    output: g.output,
  }
}

const PRIMITIVES: Record<string, Primitive> = {
  enumerate_devices: enumerateDevices,
  capture_photo: capturePhoto,
  notify,
  speak_text: speakText,
  display_show: displayShow,
  display_hide: displayHide,
  pick_file: pickFile,
  model3d_show: model3dShow,
  model3d_add: model3dAdd,
  model3d_hide: model3dHide,
  model3d_sim: model3dSim,
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
  vault_focus: vaultFocus,
  ring_rotate: ringRotate,
  overlay_open: overlayOpen,
  overlay_close: overlayClose,
  sleep_system: sleepSystem,
  toggle_voice: toggleVoice,
  toggle_clap_wake: toggleClapWake,
  voice_mode_set:  voiceModeSet,
  ptt_start: pttStart,
  ptt_stop:  pttStop,
  boot_pip:    bootPip,
  boot_awake:  bootAwake,
  gesture_set: gestureSet,
  gesture_status: gestureStatus,
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
