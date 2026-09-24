import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useJarvisStore } from './state/jarvisStore'
import { useBootStore } from './state/bootStore'
import { Plan2DEditor, loadSavedPlans } from './modes/Plan2DEditor'
import { Plan3DViewer } from './modes/Plan3DViewer'
import { SpaceViewer } from './modes/SpaceViewer'
import { VaultGraph } from './modes/VaultGraph'
import { HudPanel } from './components/HudPanel'
import { HudBtn } from './components/HudBtn'
import { CoreTerminal } from './components/CoreTerminal'
import { GestureMonitor } from './components/GestureMonitor'
import { GesturePointer } from './components/GesturePointer'
import { GestureDebugView } from './components/GestureDebugView'
import { SpeakerIdPanel } from './components/SpeakerIdPanel'
import { SpeakerConfigWindow } from './components/SpeakerConfigWindow'
import { TtsTestWidget } from './components/TtsTestWidget'
import { ObsidianStatusBadge } from './components/ObsidianStatusBadge'
import { PanelSection } from './components/PanelSection'
import { StatRow } from './components/StatRow'
import { HoloMeter } from './components/HoloMeter'
import { Badge } from './components/Badge'
import { TimerPanel } from './components/TimerPanel'
import { ChronoPanel } from './components/ChronoPanel'
import { startTimerTicker } from './state/timerStore'
import { startChronoTicker } from './state/chronoStore'
import { useUiStore } from './state/uiStore'
import { VoiceHalo } from './components/VoiceHalo'
import { useAudioLevel } from './hooks/useAudioLevel'
import { WorldScene } from './scenes/WorldScene'
import { PlanSelectorOverlay } from './components/PlanSelectorOverlay'
import { ListeningOverlay } from './components/ListeningOverlay'
import { DisplayCard } from './components/DisplayCard'
import { Model3DViewer } from './components/Model3DViewer'
import { useWall3dMirror } from './hooks/useWall3dMirror'
import { WakeWordWizard } from './components/WakeWordWizard'
import { getApiBase } from './api/client'
import { streamTtsAndPlay, streamTtsSession, setTtsDucking, type TtsSession } from './audio/streamingTts'
import { registerSpeaker } from './skills/speakBridge'
import { streamConverse } from './audio/converse'
import { ttsBusThinking } from './audio/ttsLevelBus'
import { useClapDetection } from './hooks/useClapDetection'
import { useLocalStt } from './hooks/useLocalStt'
import { useSkillBus } from './hooks/useSkillBus'
import { useGesturePipeline } from './hooks/useGesturePipeline'
import { useGestureCursor } from './hooks/useGestureCursor'
import { useGestureStore } from './state/gestureStore'
import { getWakeConfirmation } from './utils/wakeReply'
import { PINCH_ENTER_THRESHOLD, PINCH_VIGNETTE_START, RING_DRAG_SENSITIVITY } from './gestures/config'
import { snapToNearestSlot, dragToRingAngle } from './state/ringSnap'
import { modeMeta, MAIN_RING } from './constants'
import QRCode from 'qrcode'
import type { SystemTelemetry, MobileTokenInfo, MobileStatus, Mode } from './types'
import { useModel3dStore } from './state/model3dStore'
// wake_word gate. Tolerant of common Whisper mis-spellings of "jarvis".
import { hasWakePhrase, stripWakePhrase } from './lib/wakePhrase'

// Default to false; replaced at runtime by /api/system/config.
// Server reads JARVIS_TELEMETRY_ENABLED to enable the periodic poll.

// Modes that fully replace the world canvas when zoomed
const CANVAS_MODES = new Set(['plan2d', 'plan3d', 'space', 'vault'])

const WAKE_WINDOW_MS = 15000
// Ctrl+C grace: while Jarvis is THINKING (turn accepted, not yet speaking) a new
// final normally interrupts and replaces the turn. Within this window after the
// turn started, a final that DUPLICATES the in-flight utterance is treated as a
// trailing STT fragment (reconnect re-finalize / late segment) and ignored, so
// the same sentence can't restart its own turn ("si le repites se corta").
const INTERRUPT_GRACE_MS = 1200

// --- Self-echo detection by content ----------------------------------------
// Speaker confidence cannot reliably separate Jarvis's own echo from the owner
// (similar tone). Instead we look at NOVEL words: words the mic heard that
// Jarvis did NOT just say. Pure echo carries zero novel words. When the user
// talks over Jarvis the transcript is a MIX (Jarvis's words + the user's), but
// the user's words are still novel — so counting novel words (absolute, not a
// ratio) lets a real interruption through even while echo dominates the mix.
function normalizeForEcho(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Single-word commands that should always count as a real interruption even
// though one word alone is below the novel-word count threshold.
const INTERRUPT_WORDS = new Set([
  'para', 'parate', 'detente', 'espera', 'stop', 'callate', 'silencio',
  'jarvis', 'oye', 'no', 'cancela',
])

// Decide whether a transcript heard during/just-after TTS is real speech (vs
// pure self-echo). Returns true to ALLOW (treat as a real utterance / barge-in).
function hasRealSpeech(transcript: string, spokenNormalized: string): boolean {
  const words = normalizeForEcho(transcript).split(' ').filter(Boolean)
  if (words.length === 0) return false
  // Nothing was spoken → nothing to be echo of → it's real.
  if (!spokenNormalized) return true
  const spoken = new Set(spokenNormalized.split(' '))
  let novel = 0
  let hasCommand = false
  for (const w of words) {
    if (!spoken.has(w)) {
      novel++
      if (INTERRUPT_WORDS.has(w)) hasCommand = true
    }
  }
  // ≥2 novel words → real content present even if mixed with echo.
  // 1 novel word that's a known command → short interruption ("para", "jarvis").
  return novel >= 2 || hasCommand
}

export function AwakeApp() {
  const mode            = useJarvisStore(s => s.mode)
  const zoomedMode      = useJarvisStore(s => s.zoomedMode)
  const setZoomedMode   = useJarvisStore(s => s.setZoomedMode)
  const voiceMode       = useJarvisStore(s => s.voiceMode)
  const setVoiceMode    = useJarvisStore(s => s.setVoiceMode)
  const voiceEnabled    = useJarvisStore(s => s.voiceEnabled)
  const wakeListening    = useJarvisStore(s => s.wakeListening)
  const setWakeListening = useJarvisStore(s => s.setWakeListening)
  const clapWakeEnabled  = useJarvisStore(s => s.clapWakeEnabled)
  const setClapWakeEnabled = useJarvisStore(s => s.setClapWakeEnabled)
  const setCoreInput    = useJarvisStore(s => s.setCoreInput)
  const setCoreReply    = useJarvisStore(s => s.setCoreReply)
  const focusedEntity   = useJarvisStore(s => s.focusedEntity)
  const ringLevel       = useJarvisStore(s => s.ringLevel)
  const activeRingMode  = useJarvisStore(s => s.activeRingMode)
  const setRingLevel    = useJarvisStore(s => s.setRingLevel)
  const rotateRing      = useJarvisStore(s => s.rotateRing)
  const setBootState    = useBootStore(s => s.setBootState)

  const pinchZoomProgress    = useJarvisStore(s => s.pinchZoomProgress)
  const setPinchZoomProgress = useJarvisStore(s => s.setPinchZoomProgress)
  const speakerName          = useJarvisStore(s => s.speakerName)

  const gestureEnabled    = useGestureStore(s => s.enabled)
  const gestureStatus     = useGestureStore(s => s.status)
  const gestureFps        = useGestureStore(s => s.fps)
  const setGestureEnabled = useGestureStore(s => s.setEnabled)
  // NADA del `output` de gestos se suscribe con selectores de React aquí. El
  // engine publica una muestra nueva ~20 veces/s; incluso con selectores
  // primitivos (deltaX/zoom cambian cada muestra) AwakeApp entero se
  // re-renderizaba a esa cadencia mientras hubiera una mano a la vista —
  // el coste dominante con el visor 3D encima. Todo el consumo va por
  // suscripción IMPERATIVA (abajo) y solo cambia estado cuando toca actuar.
  // El puntero vive en <GesturePointer/> con su propia suscripción.
  const model3dOpen       = useModel3dStore(s => s.open)
  // Con el proyector encendido el 3D se va a la pared; aqui NO se pinta,
  // para que el portatil quede libre en vez de mostrarlo duplicado.
  const wall3dOwner       = useWall3dMirror()
  const model3dHide       = useModel3dStore(s => s.hide)

  useGesturePipeline()
  // El cursor de mano convierte el puntero en eventos de puntero del DOM, así
  // que los menús se manejan señalando y tocando (ver useGestureCursor). Va
  // ligado al pipeline: sin manos no hay cursor que emitir.
  useGestureCursor(gestureEnabled)

  /** Handler de eventos de gesto; se reasigna en cada render (ver más abajo). */
  const gestureEventsRef = useRef<Parameters<typeof useGestureStore.subscribe>[0]>(() => {})

  // Gesture: el puño AGARRA el carrusel y lo gira; al soltar, snap al slot más
  // cercano. Manipulación DIRECTA y absoluta — el ángulo es una función de
  // dónde está la mano ahora mismo, no la integral de sus incrementos.
  //
  // Lo que había antes y por qué se cambió entero:
  //  1. `ringAngle` lo escribía este arrastre y no lo leía NADIE: el carrusel
  //     seguía `activeRingMode`, así que mientras arrastrabas no se movía un
  //     pixel y al soltar saltaba de golpe al slot elegido. Sin feedback no hay
  //     manera de apuntar: arrastrabas a ciegas.
  //  2. Se sumaban "radianes" (deltaYaw · sensibilidad) a un valor medido en
  //     SLOTS — dos unidades distintas en la misma variable.
  //  3. `useGestureRotation` metía EMA + zona muerta + exponente 1.4 sobre el
  //     INCREMENTO POR FRAME, encima del One-Euro que el GrabTracker ya aplica.
  //     Una zona muerta sobre la derivada mata los movimientos lentos enteros
  //     (a 20 Hz un gesto suave da ~0.005/frame, por debajo del umbral 0.015) y
  //     el exponente aplasta lo que queda. De ahí que hubiera que "remar".
  // El visor 3D (overlay z-index 5000) CAPTURA los gestos: mientras esté
  // abierto, el ring de debajo no se mueve.
  useEffect(() => {
    let dragging = false
    let baseAngle = 0
    let lastSlot = -1

    const stop = () => {
      if (!dragging) return
      dragging = false
      lastSlot = -1
      const jarvis = useJarvisStore.getState()
      const slot = snapToNearestSlot(jarvis.ringAngle, MAIN_RING.length)
      // El orden importa: soltar la bandera ANTES deja que setActiveRingMode
      // vuelva a mantener el invariante ángulo↔modo (ver jarvisStore).
      jarvis.setRingDragging(false)
      jarvis.setRingAngle(slot)
      jarvis.setActiveRingMode(MAIN_RING[slot])
    }

    return useGestureStore.subscribe((s, prev) => {
      const g = s.output.grab
      const p = prev.output.grab
      if (g.active === p.active && g.deltaX === p.deltaX) return

      const jarvis = useJarvisStore.getState()
      const blocked =
        jarvis.zoomedMode != null ||
        useModel3dStore.getState().open ||
        s.output.pinch.active

      if (!g.active || blocked || jarvis.ringLevel !== 'main') { stop(); return }

      if (!dragging) {
        dragging = true
        baseAngle = jarvis.ringAngle
        jarvis.setRingDragging(true)
      }
      const angle = dragToRingAngle(baseAngle, g.deltaX, RING_DRAG_SENSITIVITY)
      jarvis.setRingAngle(angle)
      // Resalte en vivo del slot que pasa por el frente: sin esto el holograma
      // no se ilumina hasta soltar y el arrastre sigue siendo a ciegas.
      const slot = snapToNearestSlot(angle, MAIN_RING.length)
      if (slot !== lastSlot) {
        lastSlot = slot
        jarvis.setActiveRingMode(MAIN_RING[slot])
      }
    })
  }, [])

  const [housePlanKey, setHousePlanKey]     = useState<string>('')
  const [systemTelemetry, setSystemTelemetry] = useState<SystemTelemetry | null>(null)
  const [telemetryEnabled, setTelemetryEnabled] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(false)
  const [mobileToken, setMobileTokenInfo]   = useState<MobileTokenInfo | null>(null)
  const [mobileStatus, setMobileStatus]     = useState<MobileStatus | null>(null)
  const [countdown, setCountdown]           = useState<string>('')
  const [showPlanSelector, setShowPlanSelector] = useState(false)
  const [pendingCanvasMode, setPendingCanvasMode] = useState<Mode | null>(null)
  const gestureDebugOpen = useUiStore(s => s.gestureDebugOpen)
  const setGestureDebugOpen = useUiStore(s => s.setGestureDebugOpen)
  const speakerConfigOpen = useUiStore(s => s.speakerConfigOpen)
  const setSpeakerConfigOpen = useUiStore(s => s.setSpeakerConfigOpen)
  const terminalOpen = useUiStore(s => s.terminalOpen)
  const setTerminalOpen = useUiStore(s => s.setTerminalOpen)
  const pttActive         = useJarvisStore(s => s.pttActive)
  const [processingReply] = useState(false)
  const [copiedUrl, setCopiedUrl]           = useState<string | null>(null)
  const qrCanvasRef        = useRef<HTMLCanvasElement>(null)
  const housePlans = useMemo(() => loadSavedPlans(), [zoomedMode])

  const handleBack = useCallback(() => {
    setZoomedMode(null)
  }, [setZoomedMode])

  const enterMode = useCallback((mode: Mode) => {
    if (ringLevel === 'main' && mode === 'house') { setRingLevel('house-sub'); return }
    if (ringLevel === 'main' && mode === 'utils') { setRingLevel('utils-sub'); return }
    if (ringLevel === 'house-sub' && (mode === 'plan3d' || mode === 'space') && housePlans.length > 0) {
      setPendingCanvasMode(mode)
      setShowPlanSelector(true)
    } else {
      setZoomedMode(mode)
    }
  }, [ringLevel, housePlans.length, setZoomedMode, setRingLevel])

  const now  = new Date()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  // Overlay fade-in when a canvas-mode zooms in
  useEffect(() => {
    if (zoomedMode && CANVAS_MODES.has(zoomedMode)) {
      const t = setTimeout(() => setOverlayVisible(true), 80)
      return () => clearTimeout(t)
    } else {
      setOverlayVisible(false)
    }
  }, [zoomedMode])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoomedMode != null) handleBack()
        else if (ringLevel === 'house-sub' || ringLevel === 'utils-sub') setRingLevel('main')
        return
      }
      if (zoomedMode != null) return
      if (e.key === 'ArrowLeft')  { rotateRing(-1); return }
      if (e.key === 'ArrowRight') { rotateRing(+1); return }
      if (e.key === 'Enter') enterMode(activeRingMode)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [zoomedMode, handleBack, ringLevel, activeRingMode, setRingLevel, rotateRing, enterMode])

  // Start ticker singletons globally (idempotent). They keep counting even when
  // the panel is closed so opening it again shows the up-to-date state.
  useEffect(() => { startTimerTicker(); startChronoTicker() }, [])

  // Eventos discretos + pinch, por suscripción imperativa (ver nota de arriba).
  // El handler se guarda en un ref y se reescribe en cada render, así ve estado
  // fresco sin re-suscribir ni volver a montar el listener.
  gestureEventsRef.current = (s, before) => {
    const out = s.output
    const prev = before.output
    if (out === prev) return

    // click (flanco) → entrar al modo enfocado del ring
    if (out.click && !prev.click && !zoomedMode && !model3dOpen) enterMode(activeRingMode)

    // back (flanco) → cerrar lo que se está viendo. Con el visor 3D abierto
    // cierra el visor: es el "atrás" de lo visible, no del ring de debajo.
    if (out.back && !prev.back) {
      if (model3dOpen) model3dHide()
      else if (zoomedMode != null) handleBack()
      else if (ringLevel === 'house-sub' || ringLevel === 'utils-sub') setRingLevel('main')
    }

    // pinch → progreso de zoom sobre el holograma (solo en el ring)
    const pinch = out.pinch
    if (zoomedMode !== null || model3dOpen || !pinch.active) {
      if (useJarvisStore.getState().pinchZoomProgress !== 0) setPinchZoomProgress(0)
      return
    }
    const raw = (pinch.zoom - 1.0) / (PINCH_ENTER_THRESHOLD - 1.0)
    const progress = Math.max(0, Math.min(1, raw))
    if (progress >= 1.0) {
      setPinchZoomProgress(0)
      enterMode(activeRingMode)
      return
    }
    // Umbral de escritura: sin él, el ruido del pinch re-renderizaba la app por
    // cambios invisibles del progreso.
    if (Math.abs(progress - useJarvisStore.getState().pinchZoomProgress) > 0.002) {
      setPinchZoomProgress(progress)
    }
  }

  useEffect(() => useGestureStore.subscribe((s, prev) => gestureEventsRef.current(s, prev)), [])

  // El progreso de pinch también debe limpiarse cuando cambia lo que hay en
  // pantalla, no solo cuando llega una muestra de gesto.
  useEffect(() => {
    if (zoomedMode !== null || model3dOpen) setPinchZoomProgress(0)
  }, [zoomedMode, model3dOpen, setPinchZoomProgress])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/system/config`)
        const data = await res.json() as { telemetryEnabled?: boolean }
        if (!cancelled) setTelemetryEnabled(Boolean(data.telemetryEnabled))
      } catch {}
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!telemetryEnabled) return
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false
    const pull = async () => {
      try {
        const res  = await fetch(`${getApiBase()}/api/system/telemetry`)
        const data = await res.json() as SystemTelemetry
        if (!cancelled) setSystemTelemetry(data)
      } catch {}
    }
    if (zoomedMode === 'system') { pull(); timer = setInterval(pull, 2000) }
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [zoomedMode, telemetryEnabled])

  useEffect(() => {
    if (zoomedMode !== 'system') return
    let cancelled = false
    async function fetchToken() {
      try {
        const res  = await fetch(`${getApiBase()}/api/mobile/token`)
        const data = await res.json() as MobileTokenInfo
        if (!cancelled) setMobileTokenInfo(data)
      } catch {}
    }
    fetchToken()
    const timer = setInterval(fetchToken, 60_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [zoomedMode])

  useEffect(() => {
    if (zoomedMode !== 'system') return
    let cancelled = false
    async function fetchStatus() {
      try {
        const res  = await fetch(`${getApiBase()}/api/mobile/status`)
        const data = await res.json() as MobileStatus
        if (!cancelled) setMobileStatus(data)
      } catch {}
    }
    fetchStatus()
    const timer = setInterval(fetchStatus, 10_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [zoomedMode])

  useEffect(() => {
    if (!mobileToken || !qrCanvasRef.current) return
    QRCode.toCanvas(qrCanvasRef.current, mobileToken.qrUrl, { width: 120, margin: 1 })
  }, [mobileToken])

  useEffect(() => {
    if (zoomedMode !== 'system' || !mobileToken) return
    const activated = mobileToken.activated || mobileStatus?.connected === true
    if (activated) { setCountdown('Sesión activa'); return }
    if (mobileToken.permanent) { setCountdown('Token permanente'); return }
    const tick = () => {
      const diff = mobileToken.expiresAt - Date.now()
      if (diff <= 0) { setCountdown('Expirado'); return }
      const m   = Math.floor(diff / 60_000)
      const sec = Math.floor((diff % 60_000) / 1000)
      setCountdown(`Expira en ${m}:${String(sec).padStart(2, '0')}`)
    }
    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [zoomedMode, mobileToken, mobileStatus])

  const refreshQr = async () => {
    try {
      await fetch(`${getApiBase()}/api/mobile/token/refresh`, { method: 'POST' })
      const res = await fetch(`${getApiBase()}/api/mobile/token`)
      setMobileTokenInfo(await res.json() as MobileTokenInfo)
    } catch {}
  }

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url)
      setTimeout(() => setCopiedUrl(null), 1500)
    })
  }

  const speakAbortRef = useRef<AbortController | null>(null)
  // Normalized text Jarvis is currently / was just speaking, used to detect
  // self-echo by content (the only reliable signal when the TTS voice is cloned
  // from the owner, so speaker-confidence can't tell echo from real owner).
  const spokenTextRef = useRef('')
  // True only while TTS audio is actually playing. Gates barge-in: a new owner
  // utterance may cut Jarvis off only while he's speaking.
  const speakingRef = useRef(false)
  // Timestamp (ms) when the last TTS finished. Used for post-speech echo cooldown.
  const postSpeakTimeRef = useRef(0)
  // Timer that auto-restores TTS gain if the user starts speaking but doesn't
  // produce a final transcript (background noise, too short for Whisper, etc.).
  const duckRestoreRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speak = useCallback((text: string): Promise<void> => {
    if (!voiceEnabled || !text) { console.log(`[tts] skip (voiceEnabled=${voiceEnabled}, textLen=${text?.length ?? 0})`); return Promise.resolve() }
    console.log(`[tts] speak start "${text.slice(0, 40)}"`)
    speakAbortRef.current?.abort()
    const ctrl = new AbortController()
    speakAbortRef.current = ctrl
    speakingRef.current = true
    // Remember what we're saying so the STT gate can recognize its own echo by
    // content, independent of speaker confidence.
    spokenTextRef.current = normalizeForEcho(text)
    return streamTtsAndPlay({
      url: `${getApiBase()}/api/jarvis/tts/ws`,
      text,
      lang: 'es',
      fx: true,
      signal: ctrl.signal,
    }).then(() => { console.log('[tts] speak done') })
      .catch((e) => {
        if ((e as any)?.name !== 'AbortError') console.warn('[tts] failed:', (e as Error)?.message)
        else console.log('[tts] aborted (newer reply or stop)')
      })
      .finally(() => { if (speakAbortRef.current === ctrl) speakingRef.current = false })
  }, [voiceEnabled])

  // Expose the REAL speak() to the skill bus, so backend-initiated speech goes
  // through the same abort + echo-gate bookkeeping as a normal reply.
  useEffect(() => registerSpeaker(speak), [speak])

  // Duck TTS volume while the user is speaking. Called on every interim
  // transcript so the fade starts as soon as Whisper detects speech. An
  // auto-restore timer fires 2.5s later in case no final transcript arrives
  // (e.g. the noise was too short). The final-transcript handler always
  // cancels this timer and restores immediately.
  const duckTts = useCallback(() => {
    if (!speakingRef.current) return
    if (duckRestoreRef.current) clearTimeout(duckRestoreRef.current)
    setTtsDucking(true)
    duckRestoreRef.current = setTimeout(() => {
      setTtsDucking(false)
      duckRestoreRef.current = null
    }, 2500)
  }, [])

  // One turn at a time. True from the moment a final is accepted until its
  // reply finishes playing — so new finals (including Jarvis's own voice through
  // the mic) are ignored mid-turn instead of spawning a second, overlapping
  // reply. Safety-timed so a hung turn can't deafen the app forever.
  const turnBusyRef = useRef(false)
  // Per-turn sequence. Each turn captures its own id; its release only clears
  // turnBusyRef if it's still the current turn. Without this, an aborted turn's
  // release (firing when its speak() promise resolves) would clear the busy flag
  // of the new barge-in turn.
  const turnSeqRef = useRef(0)
  // Start time + normalized text of the in-flight turn — used by the Ctrl+C
  // interrupt guard to tell a real new command from a trailing STT fragment of
  // the utterance already being processed.
  const turnStartRef = useRef(0)
  const turnTextRef = useRef('')

  // wake_word listening window. Opened by hearing "jarvis" (on-device) or by the
  // wake-bus. While open we respond to every utterance; each turn re-arms the
  // timer so a conversation keeps going. Closes after inactivity.
  const wakeWindowRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openWakeWindow = useCallback(() => {
    setWakeListening(true)
    if (wakeWindowRef.current) clearTimeout(wakeWindowRef.current)
    wakeWindowRef.current = setTimeout(() => setWakeListening(false), WAKE_WINDOW_MS)
  }, [setWakeListening])


  // Local STT (faster-whisper) — always-on when voice enabled.
  // Each final transcript is sent to the backend for intent classification + response.
  const handleSttFinal = useCallback((text: string, speakerConfidence: number, sttSpeakerName?: string, meta?: { speakerConfidenceRaw?: number; avgLogprob?: number; confidence?: number }) => {
    if (!text.trim()) return

    // Minimum confidence required even outside of barge-in. TTS echo through
    // the mic returns conf ≈ 0 (speaker is Jarvis, not owner). Real owner
    // utterances should be >= 0.55 after lowering the voiceprint threshold.
    if (speakerConfidence < 0.55) {
      console.log(`[turn] ignored (low conf ${speakerConfidence?.toFixed?.(2)}): "${text}"`)
      return
    }

    // Self-echo filter (novel-word based). Active while Jarvis speaks and for a
    // short tail after (the mic still carries residual echo). We drop the final
    // ONLY if it has no real speech — i.e. it's just Jarvis's own words coming
    // back. If the user talks over Jarvis, the transcript is a mix but still
    // carries novel words / a command word, so a genuine interruption (or
    // talking before the STT window closes) is NOT blocked.
    const msSinceSpoke = Date.now() - postSpeakTimeRef.current
    const echoActive = speakingRef.current || msSinceSpoke < 1200
    if (echoActive && !hasRealSpeech(text, spokenTextRef.current)) {
      console.log(`[turn] ignored (self-echo, no novel words): "${text}"`)
      return
    }

    // wake_word gate. Mic is always open in this mode; we only act when the
    // window is open. Hearing "jarvis" opens it (and this same utterance is
    // handled, with the wake word stripped). Each accepted turn re-arms the
    // window so a back-and-forth keeps going without repeating "jarvis".
    if (voiceMode === 'wake_word') {
      const heard = hasWakePhrase(text)
      if (!wakeListening && !heard) {
        console.log(`[wake] gated (no wake word): "${text}"`)
        return
      }
      openWakeWindow()
      if (heard) {
        const stripped = stripWakePhrase(text)
        if (stripped) text = stripped
      }
    }

    // Always restore TTS gain when a final arrives — whether we barge in or not.
    // fast=true so the new reply (if any) plays at full volume immediately.
    if (duckRestoreRef.current) { clearTimeout(duckRestoreRef.current); duckRestoreRef.current = null }
    setTtsDucking(false, true)

    // Barge-in / Ctrl+C. A new real final (it already passed the novel-word echo
    // filter above, so it's genuine speech) interrupts the in-flight turn —
    // whether Jarvis is SPEAKING or still THINKING — and starts fresh, instead
    // of being dropped or waiting for the reply. This is the "Ctrl+C in the CLI"
    // behavior: aborting the turn's controller cancels the NDJSON stream AND any
    // TTS playback. (Echo never reaches here.)
    if (speakingRef.current) {
      console.log(`[turn] barge-in (speaking, conf=${speakerConfidence?.toFixed?.(2)}): "${text}"`)
      speakAbortRef.current?.abort()
      // fall through: this final becomes a fresh turn
    } else if (turnBusyRef.current) {
      // Thinking (Claude working, not yet speaking). Guard against the SAME
      // utterance's trailing STT fragment (a reconnect re-finalize or a late
      // segment) restarting the turn: within the grace window, ignore a final
      // that duplicates / is contained in the one already in flight.
      const sinceStart = Date.now() - turnStartRef.current
      const norm = normalizeForEcho(text)
      const prior = turnTextRef.current
      const dup = !!prior && (norm === prior || prior.includes(norm) || norm.includes(prior))
      if (sinceStart < INTERRUPT_GRACE_MS && dup) {
        console.log(`[turn] ignored (dup tail within grace ${sinceStart}ms): "${text}"`)
        return
      }
      console.log(`[turn] interrupt (thinking → Ctrl+C, conf=${speakerConfidence?.toFixed?.(2)}): "${text}"`)
      speakAbortRef.current?.abort()
      // fall through: this final replaces the in-flight turn
    }
    setCoreInput(text)
    // Prefer the human-readable name from the store; fall back to the STT-detected
    // speaker ID (e.g. "owner") so turns are always attributed when the voiceprint
    // matches, even before the user has configured a display name.
    const resolvedName = speakerName || (speakerConfidence >= 0.65 ? sttSpeakerName : undefined)
    const nameForTurn = resolvedName || null

    const myTurn = ++turnSeqRef.current
    turnBusyRef.current = true
    turnStartRef.current = Date.now()
    turnTextRef.current = normalizeForEcho(text)
    // Longer safety than the buffered path: a streamed multi-sentence reply can
    // legitimately take a while across sentences.
    const safety = setTimeout(() => { if (turnSeqRef.current === myTurn) turnBusyRef.current = false }, 30000)
    const release = () => {
      clearTimeout(safety)
      ttsBusThinking(false) // turn over (spoken, silent, or failed) — back to idle
      if (turnSeqRef.current === myTurn) {
        turnBusyRef.current = false
        speakingRef.current = false
        postSpeakTimeRef.current = Date.now()
        // Don't close the wake window here — the inactivity timer (re-armed each
        // turn in the gate above) owns closing it, so follow-up turns within the
        // window don't need the wake word repeated.
      }
    }

    const payload = { text, speakerConfidence, speakerConfidenceRaw: meta?.speakerConfidenceRaw, speakerName: nameForTurn, alwaysOn: true, context: { mode }, avgLogprob: meta?.avgLogprob, confidence: meta?.confidence }
    console.log(`[speech] -> converse text="${text}" conf=${speakerConfidence?.toFixed?.(2) ?? speakerConfidence} name=${nameForTurn}`)

    // One AbortController for the whole turn: aborting it (barge-in / newer turn)
    // cancels the NDJSON stream AND the in-flight sentence playback.
    const ctrl = new AbortController()
    speakAbortRef.current?.abort()
    speakAbortRef.current = ctrl

    const ttsUrl = `${getApiBase()}/api/jarvis/tts/ws`
    let spoke = false
    let shown = ''
    ctrl.signal.addEventListener('abort', () => { speakingRef.current = false }, { once: true })

    // One persistent TTS session for the whole reply. Sentences pipe into a
    // single server-side paplay back-to-back: gapless, no overlap, no respawn
    // dead-air. The session is created lazily on the first sentence.
    let session: TtsSession | null = null
    const speakSentence = (t: string) => {
      spoke = true
      speakingRef.current = true
      ttsBusThinking(false) // reply started — hologram switches to speak-inflate
      if (ctrl.signal.aborted) return
      if (!session) session = streamTtsSession({ url: ttsUrl, lang: 'es', fx: true, signal: ctrl.signal })
      session.speak(t)
    }

    ttsBusThinking(true) // turn in flight — hologram grows while the brain works
    ctrl.signal.addEventListener('abort', () => ttsBusThinking(false), { once: true })
    streamConverse(`${getApiBase()}/api/jarvis/converse`, payload, {
      signal: ctrl.signal,
      onSentence: (t) => {
        if (!t) return
        console.log(`[speech] <- sentence "${t.slice(0, 40)}"`)
        shown = shown ? `${shown} ${t}` : t
        setCoreReply(shown)
        if (voiceEnabled) speakSentence(t)
      },
      onDone: (result) => {
        console.log(`[speech] <- done action=${result.action} reason=${result.reason ?? '-'} state=${result.state ?? '-'}`)
        if (result?.reply) setCoreReply(result.reply)
      },
    })
      .then(() => { session?.end(); return session?.done }) // flush + wait for full reply to finish
      .catch(async (e) => {
        if ((e as any)?.name === 'AbortError' || ctrl.signal.aborted) return
        console.warn('[speech] converse failed, falling back to process-speech:', (e as Error)?.message)
        if (spoke) return
        try {
          const data = await fetch(`${getApiBase()}/api/jarvis/process-speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).then(r => r.json())
          if (data.action === 'respond' && data.reply) { setCoreReply(data.reply); await speak(data.reply) }
        } catch (e2) { console.warn('[speech] fallback failed', e2) }
      })
      .finally(release)
  }, [mode, setCoreInput, setCoreReply, voiceEnabled, voiceMode, wakeListening, openWakeWindow, speakerName, speak])

  // wake_word keeps the mic OPEN continuously (so the wake word can ever be
  // heard). The response is gated on the word "jarvis" in handleSttFinal, not on
  // the mic being closed.
  const sttEnabled =
    voiceMode === 'continuous' ||
    voiceMode === 'wake_word' ||
    (voiceMode === 'ptt' && pttActive)
  const { listening: sttListening } = useLocalStt({
    enabled: sttEnabled,
    onFinalTranscript: handleSttFinal,
    onInterimTranscript: (text) => {
      setCoreInput(text)
      duckTts()  // fade Jarvis down as soon as speech detected mid-reply
    },
  })

  const handleWakeDetected = useCallback(() => {
    if (turnBusyRef.current) return
    const myTurn = ++turnSeqRef.current
    turnBusyRef.current = true
    const safety = setTimeout(() => { if (turnSeqRef.current === myTurn) turnBusyRef.current = false }, 12000)
    speak(getWakeConfirmation(focusedEntity?.label)).finally(() => { clearTimeout(safety); if (turnSeqRef.current === myTurn) turnBusyRef.current = false })
  }, [focusedEntity, speak])

  useClapDetection({ enabled: clapWakeEnabled && voiceMode !== 'off', onDoubleClap: handleWakeDetected })

  // In wake_word mode, an external trigger (openWakeWord via wake-bus) can also
  // open the listening window, in addition to the on-device "jarvis" gate below.
  useEffect(() => {
    if (voiceMode !== 'wake_word') return
    let ws: WebSocket | null = null
    let stopped = false

    function connect() {
      if (stopped) return
      ws = new WebSocket(`${getApiBase().replace(/^http/, 'ws')}/api/jarvis/wake-bus`)
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string)
          if (msg.type === 'wake') openWakeWindow()
        } catch {}
      }
      ws.onclose = () => { if (!stopped) setTimeout(connect, 3000) }
      ws.onerror = () => ws?.close()
    }
    connect()
    return () => {
      stopped = true
      ws?.close()
      setWakeListening(false)
    }
  }, [voiceMode, openWakeWindow, setWakeListening])

  // Skill bus: lets self-built backend skills drive renderer primitives
  // (camera, notifications) while AWAKE.
  useSkillBus(true)


  const isVoiceActive = sttListening || wakeListening
  // Para las ETIQUETAS del modo de voz, no `sttListening`: en continuo y en
  // wake_word el micro está abierto siempre, así que «Escuchando…» tapaba el
  // nombre del modo y los dos se veían idénticos (parecía que wake no existía).
  // Solo cuenta como escucha la ventana de wake abierta o el PTT sostenido.
  const voiceHeard = wakeListening || (voiceMode === 'ptt' && sttListening)
  const audioLevel = useAudioLevel({ enabled: isVoiceActive || processingReply })

  // Early duck: as soon as mic level rises (before any transcript), fade Jarvis
  // down. duckTts() is a no-op when TTS isn't playing, so no guard needed here.
  useEffect(() => {
    if (audioLevel > 0.12) duckTts()
  }, [audioLevel, duckTts])

  const haloState: 'capturing' | 'processing' | null = processingReply ? 'processing' : isVoiceActive ? 'capturing' : null
  const isCanvasMode  = zoomedMode && CANVAS_MODES.has(zoomedMode)

  // Panel visibility by proximity: show when pinch zooming toward a panel-mode hologram
  const PANEL_PROXIMITY_THRESHOLD = 0.7
  const panelTarget = !CANVAS_MODES.has(activeRingMode) ? activeRingMode : null
  const showPanelByProximity = !!(panelTarget && !zoomedMode && pinchZoomProgress >= PANEL_PROXIMITY_THRESHOLD)
  const isPanelMode = !!(zoomedMode && !CANVAS_MODES.has(zoomedMode)) || showPanelByProximity
  const panelOpacity = showPanelByProximity && !zoomedMode
    ? (pinchZoomProgress - PANEL_PROXIMITY_THRESHOLD) / (1 - PANEL_PROXIMITY_THRESHOLD)
    : 1

  // Delayed unmount so exit animation can play before React removes the panel
  const [panelMounted, setPanelMounted] = useState(false)
  const [panelExiting, setPanelExiting] = useState(false)
  useEffect(() => {
    if (isPanelMode) {
      setPanelMounted(true)
      setPanelExiting(false)
    } else if (panelMounted) {
      setPanelExiting(true)
      const t = setTimeout(() => { setPanelMounted(false); setPanelExiting(false) }, 220)
      return () => clearTimeout(t)
    }
  }, [isPanelMode, panelMounted])

  return (
    <div className="jarvis-app" data-panel-open={isPanelMode ? 'true' : 'false'}>

      {haloState === 'processing' && <VoiceHalo active={true} audioLevel={audioLevel} state="processing" />}


      {/* World scene — fades out when canvas-mode overlay fully covers it.
          When a panel mode is open we dim (not hide) the carousel via CSS. */}
      <div className="world-layer" style={{
        position: 'fixed', inset: 0,
        opacity: isCanvasMode && overlayVisible ? 0 : 1,
        transition: 'opacity 0.55s ease',
        pointerEvents: isCanvasMode && overlayVisible ? 'none' : 'auto',
      }}>
        <WorldScene />
      </div>

      {/* Listening window indicator (wake_word window open, or PTT held) */}
      <ListeningOverlay
        listening={isVoiceActive}
        ptt={voiceMode === 'ptt'}
      />

      {/* Pinch zoom vignette */}
      {pinchZoomProgress > PINCH_VIGNETTE_START && (
        <div style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 40,
          opacity: (pinchZoomProgress - PINCH_VIGNETTE_START) * (1 / (1 - PINCH_VIGNETTE_START)),
          background: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.7) 100%)',
          transition: 'opacity 0.08s ease',
        }} />
      )}

      {/* Plan selector overlay (when entering plan3d/space from sub-ring) */}
      {showPlanSelector && pendingCanvasMode && (
        <PlanSelectorOverlay
          plans={housePlans}
          onSelect={(key) => {
            setHousePlanKey(key)
            setShowPlanSelector(false)
            setZoomedMode(pendingCanvasMode)
            setPendingCanvasMode(null)
          }}
          onSkip={() => {
            setShowPlanSelector(false)
            setZoomedMode(pendingCanvasMode!)
            setPendingCanvasMode(null)
          }}
        />
      )}

      {/* Canvas-mode overlay: Plan2D / Plan3D / Space. Plan3D and Space accept
          the active house-panel selection via initialSelectedKey. */}
      {isCanvasMode && (
        <div className="mode-overlay" style={{ opacity: overlayVisible ? 1 : 0 }}>
          {zoomedMode === 'plan2d' && <Plan2DEditor />}
          {zoomedMode === 'plan3d' && <Plan3DViewer initialSelectedKey={housePlanKey} />}
          {zoomedMode === 'space'  && <SpaceViewer  initialSelectedKey={housePlanKey} />}
          {zoomedMode === 'vault'  && <VaultGraph />}
        </div>
      )}

      {/* Barra de estado. Antes era marca + hora + un punto sin explicación; el
          punto no distinguía "escuchando" de "pensando", que es justo lo que uno
          quiere saber cuando Jarvis tarda. Ahora cada estado lleva su hue. */}
      <div className="status-bar">
        <span className="status-brand">JARVIS</span>
        <span className="status-divider" />
        <span className="mode-label">
          {modeMeta[zoomedMode ?? activeRingMode].label}
        </span>
        <span className="status-spacer" />
        {/* Las insignias son los CONTROLES: antes había un panel flotante
            aparte que decía lo mismo y se solapaba con el reloj. Un clic cicla
            el modo de voz; otro enciende o apaga los gestos. */}
        <button
          className="status-badge-btn"
          title={`Modo de voz: ${voiceMode} · clic para cambiar`}
          onClick={() => {
            const cycle: Record<string, import('./state/jarvisStore').VoiceMode> = {
              off: 'continuous', continuous: 'wake_word', wake_word: 'ptt', ptt: 'off',
            }
            setVoiceMode(cycle[voiceMode])
          }}
        >
          <Badge
            tone={voiceMode === 'off' ? 'idle' : processingReply ? 'attn' : isVoiceActive ? 'voice' : 'info'}
            live={processingReply || isVoiceActive}
          >
            {voiceMode === 'off' ? 'voz off'
             : processingReply ? 'pensando'
             : voiceHeard ? 'escucha'
             : voiceMode === 'wake_word' ? 'wake'
             : voiceMode === 'ptt' ? 'ptt' : 'continuo'}
          </Badge>
        </button>
        <button
          className="status-badge-btn"
          title="Pipeline de gestos"
          onClick={() => setGestureEnabled(!gestureEnabled)}
        >
          <Badge
            tone={!gestureEnabled ? 'idle' : gestureStatus === 'error' ? 'fail' : gestureStatus === 'running' ? 'ok' : 'attn'}
            live={gestureEnabled && gestureStatus === 'starting'}
          >
            gestos
          </Badge>
        </button>
        <span className="clock">{time}</span>
      </div>

      {/* El modo `vault` trae su propio botón dentro del HUD, y el global le
          caía encima de la marca de la barra de estado. Un solo "volver". */}
      {zoomedMode && zoomedMode !== 'vault' && (
        <button className="world-back-btn" onClick={handleBack}>
          ← Volver
        </button>
      )}

      {/* Core panel (home mode) */}
      {panelMounted && (zoomedMode === 'home' || (!zoomedMode && activeRingMode === 'home')) && (
        <HudPanel mode="Core" exiting={panelExiting} className={`core-panel${terminalOpen ? ' core-panel--expanded' : ''}`} style={{ opacity: panelOpacity, transition: 'opacity 0.15s ease' }}>
          {!terminalOpen && (
            <div className="core-menu core-menu-enter">
              <HudBtn onClick={() => setTerminalOpen(true)}>Terminal</HudBtn>
              <HudBtn
                active={voiceMode !== 'off'}
                onClick={() => {
                  const cycle: Record<string, import('./state/jarvisStore').VoiceMode> = {
                    off: 'continuous', continuous: 'wake_word', wake_word: 'ptt', ptt: 'off',
                  }
                  setVoiceMode(cycle[voiceMode])
                }}
              >
                {voiceMode === 'off'       ? 'Voz apagada'
                 : voiceHeard               ? 'Escuchando…'
                 : voiceMode === 'continuous' ? 'Siempre activa'
                 : voiceMode === 'wake_word'  ? 'Wake word'
                 : /* ptt */                   'Modo PTT'}
              </HudBtn>
              <HudBtn active={clapWakeEnabled} onClick={() => setClapWakeEnabled(!clapWakeEnabled)}>
                {clapWakeEnabled ? 'Aplauso activo' : 'Activar aplauso'}
              </HudBtn>
              {/* El clic por permanencia del cursor de mano no puede dormir el
                  sistema sin querer: aquí solo vale un tap deliberado. */}
              <span data-gesture-nodwell style={{ display: 'contents' }}>
                <HudBtn onClick={() => setBootState('DORMANT')}>Dormir sistema</HudBtn>
              </span>
            </div>
          )}
          {terminalOpen && (
            <div className="core-terminal-wrapper core-terminal-enter">
              <CoreTerminal onClose={() => setTerminalOpen(false)} />
            </div>
          )}
        </HudPanel>
      )}


      {/* Cloud panel */}
      {panelMounted && (zoomedMode === 'cloud' || (!zoomedMode && activeRingMode === 'cloud')) && (
        <HudPanel mode="Cloud" exiting={panelExiting} className="mode-panel" style={{ opacity: panelOpacity, transition: 'opacity 0.15s ease' }}>
          <PanelSection title="Sincronización" tone="idle" meta="pendiente">
            <StatRow label="Backup de voz" value="no" tone="idle" />
            <StatRow label="Planos 2D/3D" value="no" tone="idle" />
            <StatRow label="Historial cruzado" value="no" tone="idle" />
          </PanelSection>
          <PanelSection title="Bóveda" tone="info">
            <ObsidianStatusBadge />
            <HudBtn onClick={() => setZoomedMode('vault')}>Abrir grafo de conocimiento</HudBtn>
          </PanelSection>
        </HudPanel>
      )}

      {/* System panel.

          Antes: ~120 líneas de estilos inline con siete colores literales
          distintos (#64ffda, #ffd700, #00e5ff, #ffffff22…), cada bloque con su
          propio tamaño de fuente. Ahora cada bloque es una PanelSection y cada
          número una fila o un medidor, así que el panel se lee en vertical y el
          COLOR queda reservado para lo que de verdad tiene estado. */}
      {panelMounted && (zoomedMode === 'system' || (!zoomedMode && activeRingMode === 'system')) && (
        <HudPanel mode="System" exiting={panelExiting} className="mode-panel" style={{ opacity: panelOpacity, transition: 'opacity 0.15s ease' }}>

          <PanelSection
            title="Conexión móvil"
            tone={mobileStatus?.connected ? 'ok' : 'idle'}
            meta={mobileStatus?.connected ? 'activa' : 'sin sesión'}
          >
            <div className="qr-block">
              <div className="qr-frame">
                <canvas ref={qrCanvasRef} />
                <span className="qr-countdown">{countdown}</span>
              </div>
              <div className="qr-urls">
                {mobileToken?.tunnelUrl
                  ? <StatRow label="Túnel" value={mobileToken.tunnelUrl} tone="ok" wrap
                      onClick={() => copyUrl(mobileToken.tunnelUrl!)}
                      title={copiedUrl === mobileToken.tunnelUrl ? 'Copiado' : 'Clic para copiar'} />
                  : <StatRow label="Túnel" value="no listo" tone="attn" />}
                {mobileToken?.tailscaleUrl && (
                  <StatRow label="Tailscale" value={mobileToken.tailscaleUrl} tone="info" wrap
                    onClick={() => copyUrl(mobileToken.tailscaleUrl!)}
                    title={copiedUrl === mobileToken.tailscaleUrl ? 'Copiado' : 'Clic para copiar'} />
                )}
                <StatRow label="LAN" value={mobileToken?.lanUrl ?? '—'} wrap
                  onClick={mobileToken?.lanUrl ? () => copyUrl(mobileToken.lanUrl!) : undefined}
                  title={mobileToken?.lanUrl ? 'Clic para copiar' : undefined} />
                {mobileStatus?.connected && (
                  <StatRow
                    label="Sesión"
                    tone="ok"
                    value={mobileStatus.lastSeen
                      ? `hace ${Math.round((Date.now() - mobileStatus.lastSeen) / 60_000)} min`
                      : 'conectado'}
                    unit={mobileStatus.via ?? undefined}
                  />
                )}
              </div>
            </div>
            <HudBtn onClick={refreshQr}>Nuevo QR</HudBtn>
          </PanelSection>

          <PanelSection
            title="Gestos"
            tone={!gestureEnabled ? 'idle' : gestureStatus === 'error' ? 'fail' : gestureStatus === 'running' ? 'ok' : 'attn'}
            meta={gestureEnabled && gestureStatus === 'running' ? `${gestureFps} fps` : undefined}
          >
            <GestureMonitor />
            <HudBtn onClick={() => setGestureDebugOpen(true)}>Debug gestos</HudBtn>
          </PanelSection>

          <PanelSection title="Hablante">
            <SpeakerIdPanel onOpenConfig={() => setSpeakerConfigOpen(true)} />
          </PanelSection>

          <PanelSection title="Voz sintética">
            <TtsTestWidget />
          </PanelSection>

          <PanelSection title="Bóveda">
            <ObsidianStatusBadge />
            <HudBtn onClick={() => setZoomedMode('vault')}>Grafo de conocimiento</HudBtn>
          </PanelSection>

          {/* Telemetría: medidores con umbral, no tres líneas de texto. El hue
              lo decide severityHue dentro de HoloMeter, así que un 92% de CPU se
              pone rojo sin que este sitio tenga que acordarse. */}
          <PanelSection
            title="Telemetría"
            tone={telemetryEnabled ? 'info' : 'idle'}
            meta={telemetryEnabled ? undefined : 'off'}
          >
            {telemetryEnabled ? (
              <>
                <HoloMeter label="CPU" value={systemTelemetry?.host?.cpu?.usagePct ?? null} warn={70} crit={90} decimals={1} />
                <HoloMeter label="GPU" value={systemTelemetry?.host?.gpu?.avgUtilizationPct ?? null} warn={80} crit={95} decimals={1} />
                <HoloMeter label="RAM" value={systemTelemetry?.host?.memory?.usagePct ?? null} warn={80} crit={93} decimals={0} />
                <StatRow label="Red ↓" value={(systemTelemetry?.host?.network?.rxMbps ?? 0).toFixed(2)} unit="Mbps" />
                <StatRow label="Red ↑" value={(systemTelemetry?.host?.network?.txMbps ?? 0).toFixed(2)} unit="Mbps" />
              </>
            ) : (
              <StatRow label="Estado" value="desactivada" tone="idle" />
            )}
          </PanelSection>
        </HudPanel>
      )}

      {/* Timer panel */}
      {panelMounted && (zoomedMode === 'timer' || (!zoomedMode && activeRingMode === 'timer')) && (
        <TimerPanel exiting={panelExiting} style={{ opacity: panelOpacity, transition: 'opacity 0.15s ease' }} />
      )}

      {/* Chrono panel */}
      {panelMounted && (zoomedMode === 'chrono' || (!zoomedMode && activeRingMode === 'chrono')) && (
        <ChronoPanel exiting={panelExiting} style={{ opacity: panelOpacity, transition: 'opacity 0.15s ease' }} />
      )}

      {/* Point gesture pointer — componente propio: se re-renderiza solo él a
          la tasa del pipeline, no toda la app. */}
      <GesturePointer />

      {gestureDebugOpen && <GestureDebugView onClose={() => setGestureDebugOpen(false)} />}
      {speakerConfigOpen && <SpeakerConfigWindow onClose={() => setSpeakerConfigOpen(false)} />}

      {/* Self-controlled via displayStore — Jarvis pushes content over the bus. */}
      <DisplayCard />

      {/* 3D model viewer — full-screen overlay driven by model3dStore.
          Solo se monta cuando el dueño es ESTA ventana: con `pending` (aún no se
          sabe si el proyector está encendido) montar aquí crearía un segundo
          contexto WebGL y la iGPU mataría uno de los dos. */}
      {wall3dOwner === 'main' ? <Model3DViewer /> : null}

      {/* Wake word calibration wizard — shown on first boot if not yet calibrated */}
      <WakeWordWizard />
    </div>
  )
}
