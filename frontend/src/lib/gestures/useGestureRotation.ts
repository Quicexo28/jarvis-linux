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
}

/**
 * Returns a stable mutable ref updated on each gesture change.
 * Read deltaYaw/deltaPitch inside useFrame (R3F) or useEffect (ring).
 *
 * Clutch model: puño cerrado (grab.active) = engaged; abrir = released.
 * On engage: captures base position so deltaX/Y are relative to engagement point.
 * On release: sets justReleased=true for one cycle, then false.
 */
export function useGestureRotation(
  opts: UseGestureRotationOptions = {}
): React.MutableRefObject<GestureRotationFrame> {
  const {
    sensitivity = 2.0,
    emaAlpha = 0.25,
    deadZone = 0.018,
    nonLinearExp = 1.5,
    enabled = true,
  } = opts

  // Selectores PRIMITIVOS, no `s.output`: el engine publica un objeto nuevo por
  // frame (~25/s) — suscribirse al objeto re-renderizaba el host (AwakeApp
  // entero) en cada frame aunque nada hubiera cambiado.
  const grabActive = useGestureStore(s => s.output.grab.active)
  const grabDeltaX = useGestureStore(s => s.output.grab.deltaX)
  const grabDeltaY = useGestureStore(s => s.output.grab.deltaY)

  const frameRef = useRef<GestureRotationFrame>({
    deltaYaw: 0, deltaPitch: 0, grabActive: false, justReleased: false,
  })
  const prevGrabRef = useRef(false)
  const baseRef = useRef({ x: 0, y: 0 })
  const smoothedRef = useRef({ x: 0, y: 0 })
  const prevSmoothedRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
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
  }, [grabActive, grabDeltaX, grabDeltaY, enabled, sensitivity, emaAlpha, deadZone, nonLinearExp])

  return frameRef
}
