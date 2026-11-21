import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useJarvisStore } from '../state/jarvisStore'
import { useGestureStore } from '../state/gestureStore'
import { useModel3dStore } from '../state/model3dStore'
import { loadSavedPlans } from '../modes/Plan2DEditor'
import { PINCH_ENTER_THRESHOLD } from '../gestures/config'
import {
  activation, backStep, dialItems, isActivatable, isTypingTarget, keyAction, nucleusLevel,
} from '../lib/nucleus'
import type { Mode } from '../types'

/** Modos que ocupan toda la pantalla con su propio canvas: sus teclas son suyas. */
export const CANVAS_MODES = new Set<Mode>(['plan2d', 'plan3d', 'space', 'vault'])

/**
 * Navegación del Núcleo: el ÚNICO sitio donde teclado, ratón y gestos se
 * traducen a "entrar", "atrás" o "abrir el menú".
 *
 *   click (V suelta)  reposo → abre el menú · menú → entra al modo resaltado
 *   back (V cerrada)  con el visor 3D abierto lo cierra; si no, sube un nivel
 *   pinch ≥ 1        igual que click (con enclavamiento: hay que soltarlo)
 *   Espacio/Enter    igual que click · dentro de un modo, vuelve al menú
 *   Escape           sube un nivel
 *   flechas          mueven el resalte (o cambian de modo desde dentro de uno)
 *   1…9              eligen una entrada del dial
 *
 * Los eventos de gesto llegan por suscripción IMPERATIVA al store: el pipeline
 * publica ~20 veces/s y suscribir React aquí re-renderizaría toda la app.
 */
export function useNavigation() {
  const zoomedMode = useJarvisStore(s => s.zoomedMode)
  const setZoomedMode = useJarvisStore(s => s.setZoomedMode)
  const ringLevel = useJarvisStore(s => s.ringLevel)
  const setRingLevel = useJarvisStore(s => s.setRingLevel)
  const menuOpen = useJarvisStore(s => s.menuOpen)
  const setMenuOpen = useJarvisStore(s => s.setMenuOpen)
  const activeRingMode = useJarvisStore(s => s.activeRingMode)
  const setActiveRingMode = useJarvisStore(s => s.setActiveRingMode)
  const rotateRing = useJarvisStore(s => s.rotateRing)
  const setPinchZoomProgress = useJarvisStore(s => s.setPinchZoomProgress)
  const gestureStatus = useGestureStore(s => s.status)
  const model3dOpen = useModel3dStore(s => s.open)
  const model3dHide = useModel3dStore(s => s.hide)

  const [housePlanKey, setHousePlanKey] = useState('')
  const [showPlanSelector, setShowPlanSelector] = useState(false)
  const [pendingCanvasMode, setPendingCanvasMode] = useState<Mode | null>(null)
  const housePlans = useMemo(() => loadSavedPlans(), [zoomedMode])

  const cancelPlanSelector = useCallback(() => {
    setShowPlanSelector(false)
    setPendingCanvasMode(null)
  }, [])

  /** Un nivel hacia atrás por llamada; siempre limpia el pinch para no dejar un zoom a medias. */
  const handleBack = useCallback(() => {
    setPinchZoomProgress(0)
    switch (backStep({ selector: showPlanSelector, zoomedMode, ringLevel, menuOpen })) {
      case 'selector': cancelPlanSelector(); break
      case 'mode': setZoomedMode(null); break
      case 'sublevel': setRingLevel('main'); break
      case 'menu': setMenuOpen(false); break
      default: break
    }
  }, [showPlanSelector, zoomedMode, ringLevel, menuOpen, cancelPlanSelector, setZoomedMode, setRingLevel, setMenuOpen, setPinchZoomProgress])

  /** Casa y Útiles abren su sub-dial; el resto, el modo. Plano 3D / Inmersivo piden plano si hay guardados. */
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

  /** Clic del orbe: en reposo abre el menú; en cualquier otro nivel sube uno. */
  const toggleMenu = useCallback(() => {
    if (nucleusLevel(zoomedMode, menuOpen, ringLevel) === 'rest') setMenuOpen(true)
    else handleBack()
  }, [zoomedMode, menuOpen, ringLevel, setMenuOpen, handleBack])

  /** «Activar»: lo que hacen el clic, el pinch completo y Espacio/Enter. */
  const activate = useCallback(() => {
    const a = activation(nucleusLevel(zoomedMode, menuOpen, ringLevel), activeRingMode)
    if (a?.type === 'openMenu') setMenuOpen(true)
    else if (a?.type === 'enter') enterMode(a.mode)
  }, [zoomedMode, menuOpen, ringLevel, activeRingMode, setMenuOpen, enterMode])

  /** Elegir una entrada del dial por su posición (teclas 1…9). Desde dentro de un modo, lo cambia. */
  const pick = useCallback((mode: Mode) => {
    setActiveRingMode(mode)
    if (zoomedMode != null) setZoomedMode(null)
    enterMode(mode)
  }, [zoomedMode, setActiveRingMode, setZoomedMode, enterMode])

  // Selector de plano: solo existe en house-sub; cualquier salida de nivel (voz, Escape) lo cierra.
  useEffect(() => {
    if (ringLevel !== 'house-sub') cancelPlanSelector()
  }, [ringLevel, cancelPlanSelector])

  // Red de seguridad: si el pipeline cae con el pinch activo, no llegará otra muestra que lo limpie.
  useEffect(() => {
    if (gestureStatus !== 'running') setPinchZoomProgress(0)
  }, [gestureStatus, setPinchZoomProgress])

  // El progreso del pinch también se limpia cuando cambia lo que hay en pantalla.
  useEffect(() => {
    if (zoomedMode !== null || model3dOpen) setPinchZoomProgress(0)
  }, [zoomedMode, model3dOpen, setPinchZoomProgress])

  // --- Teclado ---------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') { handleBack(); return }
      // Escribiendo, con el visor 3D abierto o con un selector encima: las teclas son de ellos.
      if (isTypingTarget(e.target) || model3dOpen || showPlanSelector) return
      if ((e.key === ' ' || e.key === 'Enter') && isActivatable(e.target)) return

      const level = nucleusLevel(zoomedMode, menuOpen, ringLevel)
      const items = dialItems(ringLevel)
      const action = keyAction(e.key, level, items.length, zoomedMode != null && CANVAS_MODES.has(zoomedMode))
      if (!action) return
      e.preventDefault()

      if (action.type === 'activate') activate()
      else if (action.type === 'back') handleBack()
      else if (action.type === 'pick') pick(items[action.index])
      else if (action.type === 'move') {
        if (zoomedMode == null) { rotateRing(action.dir); return }
        const at = items.indexOf(zoomedMode)
        if (at >= 0) pick(items[(at + action.dir + items.length) % items.length])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomedMode, menuOpen, ringLevel, model3dOpen, showPlanSelector, handleBack, activate, pick, rotateRing])

  // --- Gestos ----------------------------------------------------------------
  /** Handler de eventos de gesto; se reasigna en cada render para ver estado fresco sin re-suscribir. */
  const gestureEventsRef = useRef<Parameters<typeof useGestureStore.subscribe>[0]>(() => {})
  /** Enclavamiento del pinch: tras activar hay que soltarlo para volver a activar. */
  const pinchLatchRef = useRef(false)

  gestureEventsRef.current = (s, before) => {
    const out = s.output
    const prev = before.output
    if (out === prev) return

    if (out.click && !prev.click && !zoomedMode && !model3dOpen) activate()

    // back: con el visor 3D abierto cierra el visor (es el "atrás" de lo visible).
    if (out.back && !prev.back) {
      if (model3dOpen) model3dHide()
      else handleBack()
    }

    const pinch = out.pinch
    if (!pinch.active) pinchLatchRef.current = false
    if (zoomedMode !== null || model3dOpen || !pinch.active || pinchLatchRef.current) {
      if (useJarvisStore.getState().pinchZoomProgress !== 0) setPinchZoomProgress(0)
      return
    }
    const progress = Math.max(0, Math.min(1, (pinch.zoom - 1.0) / (PINCH_ENTER_THRESHOLD - 1.0)))
    if (progress >= 1.0) {
      // Sostener el pinch encadenaba entradas (casa → sub-dial → plano).
      pinchLatchRef.current = true
      setPinchZoomProgress(0)
      activate()
      return
    }
    // Umbral de escritura: sin él, el ruido del pinch re-renderizaba la app por cambios invisibles.
    if (Math.abs(progress - useJarvisStore.getState().pinchZoomProgress) > 0.002) {
      setPinchZoomProgress(progress)
    }
  }
  useEffect(() => useGestureStore.subscribe((s, prev) => gestureEventsRef.current(s, prev)), [])

  const selectPlan = useCallback((key: string) => {
    setHousePlanKey(key)
    setShowPlanSelector(false)
    if (pendingCanvasMode) setZoomedMode(pendingCanvasMode)
    setPendingCanvasMode(null)
  }, [pendingCanvasMode, setZoomedMode])

  const skipPlan = useCallback(() => {
    setShowPlanSelector(false)
    if (pendingCanvasMode) setZoomedMode(pendingCanvasMode)
    setPendingCanvasMode(null)
  }, [pendingCanvasMode, setZoomedMode])

  return {
    handleBack, enterMode, toggleMenu,
    housePlans, housePlanKey, showPlanSelector, pendingCanvasMode, cancelPlanSelector, selectPlan, skipPlan,
  }
}
