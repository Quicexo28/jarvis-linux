import React, { useRef, useEffect } from 'react'
import { useGestureStore } from '../../state/gestureStore'
import { applyEMA, applyDeadZone, applyNonLinear } from './gestureRotationHelpers'

export interface GestureRotationFrame {
  /** Smoothed yaw delta this cycle. Add to rotation.y. */
  deltaYaw: number
  /** Smoothed pitch delta this cycle. Add to rotation.x. */
  deltaPitch: number
  /** Whether grab clutch is currently engaged. */
  grabActive: boolean
  /**
   * True in the single effect cycle when grab transitions active→inactive.
   * Use in a useEffect on [gestureOutput.grab.active] to detect release.
   */
  justReleased: boolean
}

export interface UseGestureRotationOptions {
  /** Base sensitivity multiplier. Default 2.0. */
  sensitivity?: number
  /** EMA smoothing alpha (0=no smooth, 1=instant). Default 0.25. */
  emaAlpha?: number
  /** Dead zone threshold below which delta is ignored. Default 0.018. */
  deadZone?: number
  /** Non-linear exponent (>1 = slow near center, fast far). Default 1.5. */
  nonLinearExp?: number
  /** Whether to process gestures at all. Default true. */
  enabled?: boolean
  /** Se llama tras procesar cada muestra de gesto, con el frame ya calculado. */
  onFrame?: (frame: GestureRotationFrame) => void
}

/**
 * Returns a stable mutable ref updated on each gesture change.
 * Read deltaYaw/deltaPitch inside useFrame (R3F) or dentro de `onFrame`.
 *
 * Clutch model: puño cerrado (grab.active) = engaged; abrir = released.
 * On engage: captures base position so deltaX/Y are relative to engagement point.
 * On release: sets justReleased=true for one cycle, then false.
 *
 * La suscripción al store es IMPERATIVA (`useGestureStore.subscribe`), no por
 * selector: el engine publica una muestra nueva ~20 veces/s y, con selectores,
 * el host (AwakeApp entero) se re-renderizaba en cada una aunque el gesto no
 * hiciera nada — el coste dominante cuando hay una escena 3D encima. Ahora solo
 * hay render si el consumidor decide cambiar estado dentro de `onFrame`.
 */
export function useGestureRotation(
  opts: UseGestureRotationOptions = {}
): React.MutableRefObject<GestureRotationFrame> {
  const frameRef = useRef<GestureRotationFrame>({
    deltaYaw: 0, deltaPitch: 0, grabActive: false, justReleased: false,
  })
  const prevGrabRef = useRef(false)
  const baseRef = useRef({ x: 0, y: 0 })
  const smoothedRef = useRef({ x: 0, y: 0 })
  const prevSmoothedRef = useRef({ x: 0, y: 0 })

  // Opciones vivas en un ref: el listener se registra UNA vez y no debe
  // re-suscribirse porque el host re-renderice.
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const process = (grabActive: boolean, grabDeltaX: number, grabDeltaY: number) => {
      const {
        sensitivity = 2.0,
        emaAlpha = 0.25,
        deadZone = 0.018,
        nonLinearExp = 1.5,
        enabled = true,
        onFrame,
      } = optsRef.current

      if (!enabled) {
        frameRef.current = { deltaYaw: 0, deltaPitch: 0, grabActive: false, justReleased: false }
        return
      }

      const wasGrabbing = prevGrabRef.current
      const isGrabbing = grabActive

      // Clutch engage: capture base position, reset smoothing state
      if (isGrabbing && !wasGrabbing) {
        baseRef.current = { x: grabDeltaX, y: grabDeltaY }
        smoothedRef.current = { x: 0, y: 0 }
        prevSmoothedRef.current = { x: 0, y: 0 }
      }

      const justReleased = wasGrabbing && !isGrabbing
      prevGrabRef.current = isGrabbing

      if (!isGrabbing) {
        frameRef.current = { deltaYaw: 0, deltaPitch: 0, grabActive: false, justReleased }
        onFrame?.(frameRef.current)
        return
      }

      // Delta from clutch base
      const rawX = grabDeltaX - baseRef.current.x
      const rawY = grabDeltaY - baseRef.current.y

      // EMA smoothing (reduces jitter from MediaPipe tracking noise)
      const newSX = applyEMA(smoothedRef.current.x, rawX, emaAlpha)
      const newSY = applyEMA(smoothedRef.current.y, rawY, emaAlpha)

      // Delta since last cycle (additive rotation signal)
      const dX = newSX - prevSmoothedRef.current.x
      const dY = newSY - prevSmoothedRef.current.y

      smoothedRef.current = { x: newSX, y: newSY }
      prevSmoothedRef.current = { x: newSX, y: newSY }

      // Dead zone + non-linear + sensitivity
      const finalX = applyNonLinear(applyDeadZone(dX, deadZone), nonLinearExp) * sensitivity
      const finalY = applyNonLinear(applyDeadZone(dY, deadZone), nonLinearExp) * sensitivity

      frameRef.current = { deltaYaw: finalX, deltaPitch: finalY, grabActive: true, justReleased: false }
      onFrame?.(frameRef.current)
    }

    const g0 = useGestureStore.getState().output.grab
    process(g0.active, g0.deltaX, g0.deltaY)

    return useGestureStore.subscribe((s, prev) => {
      const g = s.output.grab
      const p = prev.output.grab
      if (g.active === p.active && g.deltaX === p.deltaX && g.deltaY === p.deltaY) return
      process(g.active, g.deltaX, g.deltaY)
    })
  }, [])

  return frameRef
}
