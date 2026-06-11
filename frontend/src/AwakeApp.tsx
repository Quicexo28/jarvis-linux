import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useJarvisStore } from './state/jarvisStore'
import { useBootStore } from './state/bootStore'
import { Plan2DEditor, loadSavedPlans } from './modes/Plan2DEditor'
import { Plan3DViewer } from './modes/Plan3DViewer'
import { SpaceViewer } from './modes/SpaceViewer'
import { HudPanel } from './components/HudPanel'
import { HudBtn } from './components/HudBtn'
import { CoreTerminal } from './components/CoreTerminal'
import { GlassPanel } from './components/GlassPanel'
import { GestureMonitor } from './components/GestureMonitor'
import { GestureDebugView } from './components/GestureDebugView'
import { GestureTrainer } from './components/GestureTrainer'
import { SpeakerIdPanel } from './components/SpeakerIdPanel'
import { PttKeyConfig } from './components/PttKeyConfig'
import { SpeakerConfigWindow } from './components/SpeakerConfigWindow'
import { TtsTestWidget } from './components/TtsTestWidget'
import { ObsidianStatusBadge } from './components/ObsidianStatusBadge'
import { TimerPanel } from './components/TimerPanel'
import { ChronoPanel } from './components/ChronoPanel'
import { startTimerTicker } from './state/timerStore'
import { startChronoTicker } from './state/chronoStore'
import { useUiStore } from './state/uiStore'
import { VoiceHalo } from './components/VoiceHalo'
import { useAudioLevel } from './hooks/useAudioLevel'
import { WorldScene } from './scenes/WorldScene'
import { PlanSelectorOverlay } from './components/PlanSelectorOverlay'
import { DisplayCard } from './components/DisplayCard'
import { Model3DViewer } from './components/Model3DViewer'
import { WakeWordWizard } from './components/WakeWordWizard'
import { EnrollmentWizard } from './components/EnrollmentWizard'
import { usePushToTalk } from './hooks/usePushToTalk'
import { getApiBase } from './api/client'
import { streamTtsAndPlay, setTtsDucking } from './audio/streamingTts'
import { streamConverse } from './audio/converse'
import { useClapDetection } from './hooks/useClapDetection'
import { useLocalStt } from './hooks/useLocalStt'
import { useSkillBus } from './hooks/useSkillBus'
import { useGesturePipeline } from './hooks/useGesturePipeline'
import { useGestureStore } from './state/gestureStore'
import { getWakeConfirmation } from './utils/wakeReply'
import { PINCH_ENTER_THRESHOLD, PINCH_VIGNETTE_START, RING_DRAG_SENSITIVITY } from './gestures/config'
import { useGestureRotation } from './lib/gestures/useGestureRotation'
import { snapToNearestSlot } from './state/ringSnap'
import { modeMeta } from './constants'
import QRCode from 'qrcode'
import type { SystemTelemetry, MobileTokenInfo, MobileStatus, Mode } from './types'
import { useModel3dStore } from './state/model3dStore'

// Default to false; replaced at runtime by /api/system/config.
// Server reads JARVIS_TELEMETRY_ENABLED to enable the periodic poll.

// Modes that fully replace the world canvas when zoomed
const CANVAS_MODES = new Set(['plan2d', 'plan3d', 'space'])

export function AwakeApp() {
  const mode            = useJarvisStore(s => s.mode)
  const zoomedMode      = useJarvisStore(s => s.zoomedMode)
  const setZoomedMode   = useJarvisStore(s => s.setZoomedMode)
  const voiceEnabled    = useJarvisStore(s => s.voiceEnabled)
  const setVoiceEnabled = useJarvisStore(s => s.setVoiceEnabled)
  const pttEnabled      = useJarvisStore(s => s.pttEnabled)
  const setPttEnabled   = useJarvisStore(s => s.setPttEnabled)
  const pttActive       = useJarvisStore(s => s.pttActive)
  const wakeListening   = useJarvisStore(s => s.wakeListening)
  const clapWakeEnabled  = useJarvisStore(s => s.clapWakeEnabled)
  const setClapWakeEnabled = useJarvisStore(s => s.setClapWakeEnabled)
  const setCoreInput    = useJarvisStore(s => s.setCoreInput)
  const setCoreReply    = useJarvisStore(s => s.setCoreReply)
  const focusedEntity   = useJarvisStore(s => s.focusedEntity)
  const ringLevel       = useJarvisStore(s => s.ringLevel)
  const activeRingMode  = useJarvisStore(s => s.activeRingMode)
  const setRingLevel    = useJarvisStore(s => s.setRingLevel)
  const rotateRing      = useJarvisStore(s => s.rotateRing)
  const setActiveRingMode = useJarvisStore(s => s.setActiveRingMode)
  const ringAngle       = useJarvisStore(s => s.ringAngle)
  const setRingAngle    = useJarvisStore(s => s.setRingAngle)
  const setBootState    = useBootStore(s => s.setBootState)

  const pinchZoomProgress    = useJarvisStore(s => s.pinchZoomProgress)
  const setPinchZoomProgress = useJarvisStore(s => s.setPinchZoomProgress)
  const speakerName          = useJarvisStore(s => s.speakerName)

  const gestureEnabled    = useGestureStore(s => s.enabled)
  const setGestureEnabled = useGestureStore(s => s.setEnabled)
  const gestureOutput     = useGestureStore(s => s.output)
  const model3dOpen       = useModel3dStore(s => s.open)

  useGesturePipeline()

  const ringRotRef = useGestureRotation({
    sensitivity: RING_DRAG_SENSITIVITY,
    emaAlpha: 0.20,
    deadZone: 0.015,
    nonLinearExp: 1.4,
  })

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
  const gestureTrainerOpen = useUiStore(s => s.gestureTrainerOpen)
  const setGestureTrainerOpen = useUiStore(s => s.setGestureTrainerOpen)
  const speakerConfigOpen = useUiStore(s => s.speakerConfigOpen)
  const setSpeakerConfigOpen = useUiStore(s => s.setSpeakerConfigOpen)
  const terminalOpen = useUiStore(s => s.terminalOpen)
  const setTerminalOpen = useUiStore(s => s.setTerminalOpen)
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

  // Gesture: click → enter zoomed mode
  useEffect(() => {
    if (!gestureOutput.click || zoomedMode) return
    enterMode(activeRingMode)
  }, [gestureOutput.click])

  // Gesture: back → handle back
  useEffect(() => {
    if (gestureOutput.back) {
      if (zoomedMode != null) handleBack()
      else if (ringLevel === 'house-sub' || ringLevel === 'utils-sub') setRingLevel('main')
    }
  }, [gestureOutput.back])

  // Start ticker singletons globally (idempotent). They keep counting even when
  // the panel is closed so opening it again shows the up-to-date state.
  useEffect(() => { startTimerTicker(); startChronoTicker() }, [])

  // Gesture: grab → drag ring continuously; snap to nearest slot on release.
  // Uses useGestureRotation (clutch + EMA + dead zone) for smooth, precise control.
  const MAIN_RING_SLOTS = 5  // MAIN_RING has 5 modes: home, house, system, cloud, utils

  useEffect(() => {
    if (gestureOutput.pinch.active || zoomedMode != null || model3dOpen) return

    const { deltaYaw, grabActive, justReleased } = ringRotRef.current

    if (grabActive) {
      // Drag: update continuous ringAngle. Only affect main ring while at main level.
      if (ringLevel === 'main') {
        setRingAngle(ringAngle + deltaYaw)
      }
      return
    }

    if (justReleased && ringLevel === 'main') {
      // Snap to nearest slot and update activeRingMode
      const MAIN_RING: Mode[] = ['home', 'house', 'system', 'cloud', 'utils']
      const slot = snapToNearestSlot(ringAngle, MAIN_RING_SLOTS)
      setRingAngle(slot)
      setActiveRingMode(MAIN_RING[slot])
    }
  }, [gestureOutput.grab.active, gestureOutput.grab.deltaX, gestureOutput.grab.deltaY,
      gestureOutput.pinch.active, zoomedMode, ringAngle, ringLevel,
      setRingAngle, setActiveRingMode])

  // Gesture: pinch → zoom into hologram (ring only)
  useEffect(() => {
    if (zoomedMode !== null || !gestureOutput.pinch.active) {
      setPinchZoomProgress(0)
      return
    }
    const raw = (gestureOutput.pinch.zoom - 1.0) / (PINCH_ENTER_THRESHOLD - 1.0)
    const progress = Math.max(0, Math.min(1, raw))
    setPinchZoomProgress(progress)

    if (progress >= 1.0) {
      setPinchZoomProgress(0)
      enterMode(activeRingMode)
    }
  }, [gestureOutput.pinch.zoom, gestureOutput.pinch.active, zoomedMode, activeRingMode])

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
  // True only while TTS audio is actually playing. Gates barge-in: a new owner
  // utterance may cut Jarvis off only while he's speaking.
  const speakingRef = useRef(false)
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
  const enrollHintShownRef = useRef(false)

  // Local STT (faster-whisper) — always-on when voice enabled.
  // Each final transcript is sent to the backend for intent classification + response.
  const handleSttFinal = useCallback((text: string, speakerConfidence: number) => {
    if (!text.trim()) return
    // Always restore TTS gain when a final arrives — whether we barge in or not.
    // fast=true so the new reply (if any) plays at full volume immediately.
    if (duckRestoreRef.current) { clearTimeout(duckRestoreRef.current); duckRestoreRef.current = null }
    setTtsDucking(false, true)
    if (turnBusyRef.current) {
      // Barge-in: cut Jarvis off only while he's actually speaking, and only for
      // a confident owner utterance with real content. The cloned TTS voice
      // doesn't match the owner embedding (low conf) so Jarvis won't interrupt
      // himself via mic echo; AEC (echoCancellation) is the first line.
      const wordCount = text.trim().split(/\s+/).length
      const canBargeIn = speakingRef.current && speakerConfidence >= 0.65 && wordCount >= 2
      if (!canBargeIn) { console.log(`[turn] ignored (busy): "${text}"`); return }
      console.log(`[turn] barge-in -> stop speaking, new turn: "${text}"`)
      speakAbortRef.current?.abort()
      // fall through: this final becomes a fresh turn below
    }
    setCoreInput(text)
    if (!speakerName && !enrollHintShownRef.current) {
      enrollHintShownRef.current = true
      setCoreReply('Para identificarte y guardar tus tareas, configura tu nombre y graba una muestra de voz en el panel Sistema.')
    }
    // Pass speakerName only when STT is confident the owner is talking,
    // otherwise leave null so the backend writes to Speakers/Unknown/.
    const nameForTurn = (speakerName && speakerConfidence >= 0.65) ? speakerName : null

    const myTurn = ++turnSeqRef.current
    turnBusyRef.current = true
    // Longer safety than the buffered path: a streamed multi-sentence reply can
    // legitimately take a while across sentences.
    const safety = setTimeout(() => { if (turnSeqRef.current === myTurn) turnBusyRef.current = false }, 30000)
    const release = () => {
      clearTimeout(safety)
      if (turnSeqRef.current === myTurn) { turnBusyRef.current = false; speakingRef.current = false }
    }

    // PTT turns bypass the backend speaker/mute gates: in PTT mode every
    // capture is an explicit key hold. Read via getState() to avoid staleness.
    const { pttEnabled: pttMode, pttActive: pttHeld } = useJarvisStore.getState()
    const payload = { text, speakerConfidence, speakerName: nameForTurn, alwaysOn: true, ptt: pttMode || pttHeld, context: { mode } }
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

    // Pipeline: each sentence starts SYNTHESIZING the instant it arrives (its
    // WS opens and fills the worklet buffer), but PLAYBACK is gated on the
    // previous sentence finishing (gate = prior play promise). So sentence N+1
    // is already buffered when N ends → it starts immediately, no audible gap.
    let tail: Promise<void> = Promise.resolve()
    const speakSentence = (t: string) => {
      const gate = tail
      spoke = true
      speakingRef.current = true
      tail = streamTtsAndPlay({ url: ttsUrl, text: t, lang: 'es', fx: true, signal: ctrl.signal, gate })
        .catch((e) => {
          if ((e as any)?.name !== 'AbortError') console.warn('[tts] sentence failed:', (e as Error)?.message)
        })
    }

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
      .then(() => tail) // wait for the last queued sentence to finish playing
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
  }, [mode, setCoreInput, setCoreReply, voiceEnabled, speakerName, speak])

  usePushToTalk()

  const { listening: sttListening } = useLocalStt({
    // PTT mode replaces continuous listening: mic streams only while the key
    // is held. pttActive alone (global Hyprland bind) also forces capture.
    enabled: pttActive || (!pttEnabled && voiceEnabled),
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

  useClapDetection({ enabled: clapWakeEnabled && voiceEnabled, onDoubleClap: handleWakeDetected })

  // Skill bus: lets self-built backend skills drive renderer primitives
  // (camera, notifications) while AWAKE.
  useSkillBus(true)


  const isVoiceActive = sttListening || wakeListening
  const audioLevel = useAudioLevel({ enabled: isVoiceActive || processingReply })
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
        </div>
      )}

      {/* Status bar */}
      <div className="status-bar">
        <span className="mode-label">{zoomedMode ? modeMeta[zoomedMode].label : 'JARVIS'}</span>
        <span className="clock">{time}</span>
        {isVoiceActive && zoomedMode !== 'home' && <span className="voice-dot-mini" />}
      </div>

      {zoomedMode && (
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
              <HudBtn active={sttListening} onClick={() => setVoiceEnabled(!voiceEnabled)}>
                {sttListening ? 'Escuchando' : 'Activar voz'}
              </HudBtn>
              <HudBtn active={clapWakeEnabled} onClick={() => setClapWakeEnabled(!clapWakeEnabled)}>
                {clapWakeEnabled ? 'Aplauso activo' : 'Activar aplauso'}
              </HudBtn>
              <HudBtn onClick={() => setBootState('DORMANT')}>Dormir sistema</HudBtn>
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
          <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: '4px 0', letterSpacing: '0.04em', lineHeight: 1.5 }}>
            <div style={{ fontSize: 10, letterSpacing: '2px', color: 'var(--cyan, #00e5ff)', opacity: 0.7, marginBottom: 8 }}>
              SINCRONIZACIÓN
            </div>
            <div style={{ marginBottom: 6 }}>
              Esta vista alojará la sincronización de tu bóveda de Obsidian con la nube y la replicación de planos 3D entre dispositivos.
            </div>
            <div style={{ opacity: 0.6, fontSize: 10 }}>
              · Backup cifrado de Speakers/&lt;nombre&gt;/<br />
              · Sync de planos 2D/3D entre escritorio y móvil<br />
              · Historial cruzado de conversaciones<br />
              <br />
              Disponible en una próxima versión.
            </div>
          </div>
        </HudPanel>
      )}

      {/* System panel */}
      {panelMounted && (zoomedMode === 'system' || (!zoomedMode && activeRingMode === 'system')) && (
        <HudPanel mode="System" exiting={panelExiting} className="mode-panel" style={{ opacity: panelOpacity, transition: 'opacity 0.15s ease' }}>

          {/* Conexion Movil */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 9, letterSpacing: '2px', color: 'var(--cyan, #00e5ff)', opacity: 0.7, marginBottom: 8 }}>
              CONEXION MOVIL
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <canvas ref={qrCanvasRef} style={{ borderRadius: 4 }} />
                <div style={{ fontSize: 9, color: '#ffd700' }}>{countdown}</div>
                <button
                  className="hud-btn"
                  style={{ fontSize: 9 }}
                  onClick={refreshQr}
                >
                  nuevo QR
                </button>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10 }}>
                {mobileToken?.tailscaleUrl ? (
                  <div
                    style={{ border: '1px solid #00e5ff44', borderRadius: 4, padding: 8, cursor: 'pointer' }}
                    onClick={() => copyUrl(mobileToken.tailscaleUrl!)}
                    title="Copiar"
                  >
                    <div style={{ fontSize: 8, color: '#00e5ff', marginBottom: 2 }}>
                      TAILSCALE {copiedUrl === mobileToken.tailscaleUrl ? '· Copiado' : '· Clic para copiar'}
                    </div>
                    <div style={{ wordBreak: 'break-all', opacity: 0.9 }}>{mobileToken.tailscaleUrl}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 9, color: '#ffd700', opacity: 0.8 }}>
                    Tailscale no detectado — QR usa LAN
                  </div>
                )}
                <div
                  style={{ border: '1px solid #ffffff22', borderRadius: 4, padding: 8, cursor: mobileToken?.lanUrl ? 'pointer' : 'default' }}
                  onClick={() => mobileToken?.lanUrl && copyUrl(mobileToken.lanUrl)}
                  title={mobileToken?.lanUrl ? 'Copiar' : undefined}
                >
                  <div style={{ fontSize: 8, opacity: 0.5, marginBottom: 2 }}>
                    LAN {mobileToken?.lanUrl && copiedUrl === mobileToken.lanUrl ? '· Copiado' : mobileToken?.lanUrl ? '· Clic para copiar' : ''}
                  </div>
                  <div style={{ wordBreak: 'break-all', opacity: 0.7 }}>{mobileToken?.lanUrl ?? '—'}</div>
                </div>
                {mobileStatus?.connected && (
                  <div style={{ border: '1px solid #64ffda33', borderRadius: 4, padding: 8 }}>
                    <div style={{ fontSize: 8, color: '#64ffda', marginBottom: 2 }}>SESION ACTIVA</div>
                    <div style={{ opacity: 0.8 }}>
                      {mobileStatus.lastSeen
                        ? `Hace ${Math.round((Date.now() - mobileStatus.lastSeen) / 60_000)} min`
                        : 'Conectado'}
                      {mobileStatus.via ? ` · ${mobileStatus.via}` : ''}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Gestos */}
          <GestureMonitor />
          <HudBtn onClick={() => setGestureDebugOpen(true)}>Debug gestos</HudBtn>
          <HudBtn onClick={() => setGestureTrainerOpen(true)}>Entrenar gestos ML</HudBtn>

          {/* Speaker ID */}
          <SpeakerIdPanel onOpenConfig={() => setSpeakerConfigOpen(true)} />

          {/* Push-to-talk */}
          <PttKeyConfig />

          {/* TTS Test */}
          <TtsTestWidget />

          {/* Obsidian */}
          <ObsidianStatusBadge />

          {/* Telemetria */}
          {telemetryEnabled ? (
            <>
              <div className="hud-stat">CPU · {(systemTelemetry?.host?.cpu?.usagePct ?? 0).toFixed(1)}%</div>
              <div className="hud-stat">GPU · {(systemTelemetry?.host?.gpu?.avgUtilizationPct ?? 0).toFixed(1)}%</div>
              <div className="hud-stat">
                Red · ↓{(systemTelemetry?.host?.network?.rxMbps ?? 0).toFixed(2)} ↑{(systemTelemetry?.host?.network?.txMbps ?? 0).toFixed(2)} Mbps
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: '4px 0' }}>Telemetría desactivada.</div>
          )}
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

      {/* Voice + Gesture toggles — floating top-right */}
      <GlassPanel style={{ position: 'fixed', top: 16, right: 36, padding: '6px 14px', zIndex: 100, display: 'flex', gap: 8 }}>
        <HudBtn active={voiceEnabled} onClick={() => setVoiceEnabled(!voiceEnabled)}>
          Voz
        </HudBtn>
        <HudBtn active={pttEnabled} onClick={() => setPttEnabled(!pttEnabled)}>
          PTT
        </HudBtn>
        <HudBtn active={gestureEnabled} onClick={() => setGestureEnabled(!gestureEnabled)}>
          Gestos
        </HudBtn>
      </GlassPanel>

      {/* Push-to-talk live indicator */}
      {pttActive && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9050, padding: '6px 18px', borderRadius: 20,
          background: 'rgba(255,107,107,0.12)', border: '1px solid rgba(255,107,107,0.6)',
          color: '#ff6b6b', fontSize: 11, letterSpacing: 2, fontFamily: 'monospace',
        }}>
          ● ESCUCHANDO (PTT)
        </div>
      )}

      {/* Point gesture pointer */}
      {gestureOutput.point.active && (
        <div style={{
          position: 'fixed',
          left: `${(1 - gestureOutput.point.screenX) * 100}%`,
          top: `${gestureOutput.point.screenY * 100}%`,
          width: 16, height: 16,
          borderRadius: '50%',
          background: 'radial-gradient(circle, #00f0ff 0%, transparent 70%)',
          boxShadow: '0 0 12px #00f0ff, 0 0 24px #00f0ff44',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 9000,
          transition: 'left 0.05s linear, top 0.05s linear',
        }} />
      )}

      {gestureDebugOpen && <GestureDebugView onClose={() => setGestureDebugOpen(false)} />}
      {gestureTrainerOpen && <GestureTrainer onClose={() => setGestureTrainerOpen(false)} />}
      {speakerConfigOpen && <SpeakerConfigWindow onClose={() => setSpeakerConfigOpen(false)} />}

      {/* Self-controlled via displayStore — Jarvis pushes content over the bus. */}
      <DisplayCard />

      {/* 3D model viewer — full-screen overlay driven by model3dStore */}
      <Model3DViewer />

      {/* Wake word calibration wizard — shown on first boot if not yet calibrated */}
      <WakeWordWizard />

      {/* Speaker enrollment wizard — first boot, until a voice is enrolled */}
      <EnrollmentWizard />
    </div>
  )
}
