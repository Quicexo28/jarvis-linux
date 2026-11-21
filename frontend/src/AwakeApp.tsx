import { useEffect, useState } from 'react'
import { useJarvisStore } from './state/jarvisStore'
import { Plan2DEditor } from './modes/Plan2DEditor'
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
import { Nucleus } from './components/nucleus/Nucleus'
import { PlanSelectorOverlay } from './components/PlanSelectorOverlay'
import { ModeErrorBoundary } from './components/ModeErrorBoundary'
import { StatusBar } from './components/StatusBar'
import { CorePanel } from './components/panels/CorePanel'
import { CloudPanel } from './components/panels/CloudPanel'
import { SystemPanel } from './components/panels/SystemPanel'
import { DisplayCard } from './components/DisplayCard'
import { Model3DViewer } from './components/Model3DViewer'
import { useWall3dMirror } from './hooks/useWall3dMirror'
import { WakeWordWizard } from './components/WakeWordWizard'
import { useSkillBus } from './hooks/useSkillBus'
import { useGesturePipeline } from './hooks/useGesturePipeline'
import { useGestureCursor } from './hooks/useGestureCursor'
import { useVoiceTurn } from './hooks/useVoiceTurn'
import { useRingDrag } from './hooks/useRingDrag'
import { useNavigation, CANVAS_MODES } from './hooks/useNavigation'
import { useGestureStore } from './state/gestureStore'
import { PINCH_VIGNETTE_START } from './gestures/config'
import type { Mode } from './types'

export function AwakeApp() {
  const zoomedMode = useJarvisStore(s => s.zoomedMode)
  const pinchZoomProgress = useJarvisStore(s => s.pinchZoomProgress)
  const gestureEnabled = useGestureStore(s => s.enabled)
  // Con el proyector encendido el 3D se va a la pared; aquí NO se pinta, para
  // que el portátil quede libre en vez de mostrarlo duplicado.
  const wall3dOwner = useWall3dMirror()

  useGesturePipeline()
  // El cursor de mano convierte el puntero en eventos de puntero del DOM, así
  // que los menús se manejan señalando y tocando (ver useGestureCursor). Va
  // ligado al pipeline: sin manos no hay cursor que emitir.
  useGestureCursor(gestureEnabled)
  useRingDrag()

  const nav = useNavigation()
  const gestureDebugOpen = useUiStore(s => s.gestureDebugOpen)
  const setGestureDebugOpen = useUiStore(s => s.setGestureDebugOpen)
  const speakerConfigOpen = useUiStore(s => s.speakerConfigOpen)
  const setSpeakerConfigOpen = useUiStore(s => s.setSpeakerConfigOpen)
  const textInputOpen = useUiStore(s => s.textInputOpen)
  const setTextInputOpen = useUiStore(s => s.setTextInputOpen)

  // Los contadores siguen corriendo con el panel cerrado: al abrirlo muestra el estado al día.
  useEffect(() => { startTimerTicker(); startChronoTicker() }, [])

  const { handleSttFinal, isVoiceActive, voiceHeard } = useVoiceTurn()

  // Skill bus: deja que skills del backend manejen primitivas del renderer
  // (cámara, notificaciones) mientras está AWAKE.
  useSkillBus(true)

  const isCanvasMode = !!zoomedMode && CANVAS_MODES.has(zoomedMode)
  const isPanelMode = !!zoomedMode && !CANVAS_MODES.has(zoomedMode)

  // Fundido del canvas al entrar a un modo de pantalla completa.
  const [overlayVisible, setOverlayVisible] = useState(false)
  useEffect(() => {
    if (!isCanvasMode) { setOverlayVisible(false); return }
    const t = setTimeout(() => setOverlayVisible(true), 80)
    return () => clearTimeout(t)
  }, [isCanvasMode])

  // Montaje con retardo para que se vea la animación de salida del panel.
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
  const panelFor = (m: Mode) => panelMounted && zoomedMode === m

  return (
    <div className="jarvis-app" data-panel-open={isPanelMode ? 'true' : 'false'}>

      <Nucleus listening={voiceHeard} onOrb={nav.toggleMenu} onEnter={nav.enterMode} />

      {/* Viñeta del pinch: avisa de que está a punto de activar. */}
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

      {/* Selector de plano (al entrar a Espacio 3D / Inmersivo desde Casa). */}
      {nav.showPlanSelector && nav.pendingCanvasMode && (
        <PlanSelectorOverlay
          plans={nav.housePlans}
          onCancel={nav.cancelPlanSelector}
          onSelect={nav.selectPlan}
          onSkip={nav.skipPlan}
        />
      )}

      {/* Modos de pantalla completa: Plano 2D / Espacio 3D / Inmersivo / Memoria. */}
      {isCanvasMode && (
        <div className="mode-overlay" style={{ opacity: overlayVisible ? 1 : 0 }}>
          <ModeErrorBoundary key={zoomedMode} onFail={nav.handleBack}>
            {zoomedMode === 'plan2d' && <Plan2DEditor />}
            {zoomedMode === 'plan3d' && <Plan3DViewer initialSelectedKey={nav.housePlanKey} />}
            {zoomedMode === 'space'  && <SpaceViewer  initialSelectedKey={nav.housePlanKey} />}
            {zoomedMode === 'vault'  && <VaultGraph />}
          </ModeErrorBoundary>
        </div>
      )}

      <StatusBar voiceActive={isVoiceActive} voiceHeard={voiceHeard} onEnter={nav.enterMode} />

      {/* Los canvas tapan el núcleo: necesitan su propio "volver". Memoria trae el suyo dentro del HUD. */}
      {!nav.showPlanSelector && isCanvasMode && zoomedMode !== 'vault' && (
        <button className="world-back-btn" onClick={nav.handleBack}>
          ← Volver
        </button>
      )}

      {/* Paneles: se montan con retardo para que se vea la animación de salida. */}
      {panelFor('home')   && <CorePanel   exiting={panelExiting} voiceHeard={voiceHeard} />}
      {panelFor('cloud')  && <CloudPanel  exiting={panelExiting} />}
      {panelFor('system') && <SystemPanel exiting={panelExiting} />}
      {panelFor('timer')  && <TimerPanel  exiting={panelExiting} />}
      {panelFor('chrono') && <ChronoPanel exiting={panelExiting} />}

      {/* Puntero de mano: componente propio, se re-renderiza solo él a la tasa del pipeline. */}
      <GesturePointer />

      {gestureDebugOpen && <GestureDebugView onClose={() => setGestureDebugOpen(false)} />}
      {speakerConfigOpen && <SpeakerConfigWindow onClose={() => setSpeakerConfigOpen(false)} />}
      {textInputOpen && (
        <TextInputBox
          onSubmit={(text) => handleSttFinal(text, 1, undefined, { typed: true })}
          onClose={() => setTextInputOpen(false)}
        />
      )}

      {/* Se controla solo por displayStore: Jarvis le manda el contenido por el bus. */}
      <DisplayCard />

      {/* Visor 3D de modelos. Solo se monta si el dueño es ESTA ventana: con `pending`
          (aún no se sabe si el proyector está encendido) montar aquí crearía un segundo
          contexto WebGL y la iGPU mataría uno de los dos. */}
      {wall3dOwner === 'main' ? <Model3DViewer /> : null}

      {/* Asistente de calibración del wake word: solo en el primer arranque. */}
      <WakeWordWizard />
    </div>
  )
}
