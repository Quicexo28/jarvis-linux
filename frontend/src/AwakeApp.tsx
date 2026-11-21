import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useJarvisStore } from './state/jarvisStore'
import { Plan2DEditor, loadSavedPlans } from './modes/Plan2DEditor'
import { Plan3DViewer } from './modes/Plan3DViewer'
import { SpaceViewer } from './modes/SpaceViewer'
import { VaultGraph } from './modes/VaultGraph'
import { GesturePointer } from './components/GesturePointer'
import { GestureDebugView } from './components/GestureDebugView'
import { SpeakerConfigWindow } from './components/SpeakerConfigWindow'
import { TextInputBox } from './components/TextInputBox'
import { TimerPanel } from './components/TimerPanel'
import { ChronoPanel } from './components/ChronoPanel'
import { startTimerTicker } from './state/timerStore'
import { startChronoTicker } from './state/chronoStore'
import { useUiStore } from './state/uiStore'
import { WorldScene } from './scenes/WorldScene'
import { PlanSelectorOverlay } from './components/PlanSelectorOverlay'
import { ModeErrorBoundary } from './components/ModeErrorBoundary'
import { StatusBar } from './components/StatusBar'
import { CorePanel } from './components/panels/CorePanel'
import { CloudPanel } from './components/panels/CloudPanel'
import { SystemPanel } from './components/panels/SystemPanel'
import { ListeningOverlay } from './components/ListeningOverlay'
import { DisplayCard } from './components/DisplayCard'
import { Model3DViewer } from './components/Model3DViewer'
import { useWall3dMirror } from './hooks/useWall3dMirror'
import { WakeWordWizard } from './components/WakeWordWizard'
import { useSkillBus } from './hooks/useSkillBus'
import { useGesturePipeline } from './hooks/useGesturePipeline'
import { useGestureCursor } from './hooks/useGestureCursor'
import { useVoiceTurn } from './hooks/useVoiceTurn'
import { useRingDrag } from './hooks/useRingDrag'
import { useGestureStore } from './state/gestureStore'
import { PINCH_ENTER_THRESHOLD, PINCH_VIGNETTE_START } from './gestures/config'
import type { Mode } from './types'
import { useModel3dStore } from './state/model3dStore'
// wake_word gate. Tolerant of common Whisper mis-spellings of "jarvis".

// Modes that fully replace the world canvas when zoomed
const CANVAS_MODES = new Set(['plan2d', 'plan3d', 'space', 'vault'])


export function AwakeApp() {
  const zoomedMode      = useJarvisStore(s => s.zoomedMode)
  const setZoomedMode   = useJarvisStore(s => s.setZoomedMode)
  const voiceMode       = useJarvisStore(s => s.voiceMode)
  const ringLevel       = useJarvisStore(s => s.ringLevel)
  const activeRingMode  = useJarvisStore(s => s.activeRingMode)
  const setRingLevel    = useJarvisStore(s => s.setRingLevel)
  const rotateRing      = useJarvisStore(s => s.rotateRing)

  const pinchZoomProgress    = useJarvisStore(s => s.pinchZoomProgress)
  const setPinchZoomProgress = useJarvisStore(s => s.setPinchZoomProgress)

  const gestureEnabled    = useGestureStore(s => s.enabled)
  const gestureStatus     = useGestureStore(s => s.status)
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
  /** Enclavamiento del pinch: tras entrar a un modo hay que soltarlo para volver a entrar. */
  const pinchLatchRef = useRef(false)

  useRingDrag()

  const [housePlanKey, setHousePlanKey]     = useState<string>('')
  const [overlayVisible, setOverlayVisible] = useState(false)
  const [showPlanSelector, setShowPlanSelector] = useState(false)
  const [pendingCanvasMode, setPendingCanvasMode] = useState<Mode | null>(null)
  const gestureDebugOpen = useUiStore(s => s.gestureDebugOpen)
  const setGestureDebugOpen = useUiStore(s => s.setGestureDebugOpen)
  const speakerConfigOpen = useUiStore(s => s.speakerConfigOpen)
  const setSpeakerConfigOpen = useUiStore(s => s.setSpeakerConfigOpen)
  const textInputOpen = useUiStore(s => s.textInputOpen)
  const setTextInputOpen = useUiStore(s => s.setTextInputOpen)
  const housePlans = useMemo(() => loadSavedPlans(), [zoomedMode])

  const cancelPlanSelector = useCallback(() => {
    setShowPlanSelector(false)
    setPendingCanvasMode(null)
  }, [])

  // Salida ÚNICA (botón, Escape, gesto back): cada llamada sube un nivel y
  // siempre limpia el pinch, para no dejar el holograma escalado sin modo.
  const handleBack = useCallback(() => {
    setPinchZoomProgress(0)
    if (showPlanSelector) { cancelPlanSelector(); return }
    if (zoomedMode != null) { setZoomedMode(null); return }
    if (ringLevel !== 'main') setRingLevel('main')
  }, [showPlanSelector, zoomedMode, ringLevel, cancelPlanSelector, setZoomedMode, setRingLevel, setPinchZoomProgress])

  // El selector de plano solo existe en house-sub: cualquier salida de nivel
  // (voz, Escape) lo cierra.
  useEffect(() => {
    if (ringLevel !== 'house-sub') cancelPlanSelector()
  }, [ringLevel, cancelPlanSelector])

  // Red de seguridad: si el pipeline cae con el pinch activo, no llegará otra
  // muestra que lo limpie.
  useEffect(() => {
    if (gestureStatus !== 'running') setPinchZoomProgress(0)
  }, [gestureStatus, setPinchZoomProgress])

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
      if (e.key === 'Escape') { handleBack(); return }
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
      else handleBack()
    }

    // pinch → progreso de zoom sobre el holograma (solo en el ring)
    const pinch = out.pinch
    if (!pinch.active) pinchLatchRef.current = false
    if (zoomedMode !== null || model3dOpen || !pinch.active || pinchLatchRef.current) {
      if (useJarvisStore.getState().pinchZoomProgress !== 0) setPinchZoomProgress(0)
      return
    }
    const raw = (pinch.zoom - 1.0) / (PINCH_ENTER_THRESHOLD - 1.0)
    const progress = Math.max(0, Math.min(1, raw))
    if (progress >= 1.0) {
      // Sostener el pinch encadenaba entradas (house → house-sub → plan3d).
      pinchLatchRef.current = true
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

  const { handleSttFinal, isVoiceActive, voiceHeard } = useVoiceTurn()

  // Skill bus: deja que skills del backend manejen primitivas del renderer
  // (cámara, notificaciones) mientras está AWAKE.
  useSkillBus(true)


  const isCanvasMode  = zoomedMode && CANVAS_MODES.has(zoomedMode)

  // Panel visibility by proximity: show when pinch zooming toward a panel-mode hologram
  const PANEL_PROXIMITY_THRESHOLD = 0.7
  const panelTarget = !CANVAS_MODES.has(activeRingMode) ? activeRingMode : null
  const showPanelByProximity = !!(panelTarget && !zoomedMode && pinchZoomProgress >= PANEL_PROXIMITY_THRESHOLD)
  const isPanelMode = !!(zoomedMode && !CANVAS_MODES.has(zoomedMode)) || showPanelByProximity
  const panelOpacity = showPanelByProximity && !zoomedMode
    ? (pinchZoomProgress - PANEL_PROXIMITY_THRESHOLD) / (1 - PANEL_PROXIMITY_THRESHOLD)
    : 1
  const panelStyle = { opacity: panelOpacity, transition: 'opacity 0.15s ease' }
  /** El panel de `m` está a la vista: abierto a pantalla completa o enfocado en el anillo. */
  const panelFor = (m: Mode) => panelMounted && (zoomedMode === m || (!zoomedMode && activeRingMode === m))

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
          onCancel={cancelPlanSelector}
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
          <ModeErrorBoundary key={zoomedMode} onFail={handleBack}>
            {zoomedMode === 'plan2d' && <Plan2DEditor />}
            {zoomedMode === 'plan3d' && <Plan3DViewer initialSelectedKey={housePlanKey} />}
            {zoomedMode === 'space'  && <SpaceViewer  initialSelectedKey={housePlanKey} />}
            {zoomedMode === 'vault'  && <VaultGraph />}
          </ModeErrorBoundary>
        </div>
      )}

      <StatusBar voiceActive={isVoiceActive} voiceHeard={voiceHeard} />

      {/* El modo `vault` trae su propio botón dentro del HUD, y el global le
          caía encima de la marca de la barra de estado. Un solo "volver". */}
      {!showPlanSelector && (zoomedMode ? zoomedMode !== 'vault' : ringLevel !== 'main') && (
        <button className="world-back-btn" onClick={handleBack}>
          ← Volver
        </button>
      )}

      {/* Paneles: se montan con retardo para que se vea la animación de salida. */}
      {panelFor('home')   && <CorePanel   exiting={panelExiting} style={panelStyle} voiceHeard={voiceHeard} />}
      {panelFor('cloud')  && <CloudPanel  exiting={panelExiting} style={panelStyle} />}
      {panelFor('system') && <SystemPanel exiting={panelExiting} style={panelStyle} zoomed={zoomedMode === 'system'} />}

      {/* Timer panel */}
      {panelFor('timer') && (
        <TimerPanel exiting={panelExiting} style={panelStyle} />
      )}

      {/* Chrono panel */}
      {panelFor('chrono') && (
        <ChronoPanel exiting={panelExiting} style={panelStyle} />
      )}

      {/* Point gesture pointer — componente propio: se re-renderiza solo él a
          la tasa del pipeline, no toda la app. */}
      <GesturePointer />

      {gestureDebugOpen && <GestureDebugView onClose={() => setGestureDebugOpen(false)} />}
      {speakerConfigOpen && <SpeakerConfigWindow onClose={() => setSpeakerConfigOpen(false)} />}
      {textInputOpen && (
        <TextInputBox
          onSubmit={(text) => handleSttFinal(text, 1, undefined, { typed: true })}
          onClose={() => setTextInputOpen(false)}
        />
      )}

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
