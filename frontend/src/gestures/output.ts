// frontend/src/gestures/output.ts
import type { GestureResult, HandFeatures, ModifierStatus, GestureOutput } from './types'
import { MIN_PINCH_DIST, MAX_PINCH_DIST, MIN_ZOOM, MAX_ZOOM, ZOOM_SMOOTH_FACTOR, GRAB_DEAD_ZONE, PINCH_HOLD_MS } from './config'

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const clamped = Math.max(inMin, Math.min(inMax, value))
  return ((clamped - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin
}

// Wrap an angle delta to [-π, π] so crossing the ±π boundary doesn't jump.
function wrapAngle(a: number): number {
  let x = a
  while (x > Math.PI) x -= 2 * Math.PI
  while (x < -Math.PI) x += 2 * Math.PI
  return x
}

export class OutputProcessor {
  private grabOnset: { x: number; y: number } | null = null
  private grabOnsetAngle = 0
  private grabPalmSize = 1
  private zoomSmoothed = 1.0
  private wasGrabActive = false
  private pinchHoldUntil = 0

  update(
    gesture: GestureResult,
    leftFeatures: HandFeatures | null,
    rightFeatures: HandFeatures | null,
    modifier: ModifierStatus,
    click: boolean,
    back: boolean,
    timestampMs?: number,
  ): GestureOutput {
    const now = timestampMs ?? performance.now()

    // Grab
    const grabActive = gesture.left === 'grab'
    let deltaX = 0
    let deltaY = 0
    let deltaAngle = 0

    if (grabActive && leftFeatures) {
      if (!this.wasGrabActive) {
        this.grabOnset = { x: leftFeatures.wristPosition.x, y: leftFeatures.wristPosition.y }
        this.grabOnsetAngle = leftFeatures.palmAngle
        this.grabPalmSize = leftFeatures.palmSize > 1e-6 ? leftFeatures.palmSize : 1
      }
      if (this.grabOnset) {
        const rawDx = (leftFeatures.wristPosition.x - this.grabOnset.x) / this.grabPalmSize
        const rawDy = (leftFeatures.wristPosition.y - this.grabOnset.y) / this.grabPalmSize
        deltaX = Math.abs(rawDx) > GRAB_DEAD_ZONE ? rawDx : 0
        deltaY = Math.abs(rawDy) > GRAB_DEAD_ZONE ? rawDy : 0
        // Palm roll relative to grab onset → 1:1 angular rotation of the figure.
        deltaAngle = wrapAngle(leftFeatures.palmAngle - this.grabOnsetAngle)
      }
    } else {
      this.grabOnset = null
    }
    this.wasGrabActive = grabActive

    // Point
    const pointActive = gesture.left === 'point'
    const screenX = pointActive && leftFeatures ? leftFeatures.indexTipPosition.x : 0
    const screenY = pointActive && leftFeatures ? leftFeatures.indexTipPosition.y : 0

    // Pinch with grace period
    const rawPinch = gesture.right === 'pinch'
    if (rawPinch) {
      this.pinchHoldUntil = now + PINCH_HOLD_MS
    }
    const pinchActive = rawPinch || now < this.pinchHoldUntil

    let zoomValue = this.zoomSmoothed
    let paused = false

    if (pinchActive) {
      if (modifier.type === 'paused' || modifier.type === 'waiting_resume') {
        paused = true
        zoomValue = modifier.frozenValue
        this.zoomSmoothed = modifier.frozenValue
      } else if (rightFeatures) {
        const dist = rightFeatures.tipDistances.thumbIndex2D
        const zoomTarget = mapRange(dist, MIN_PINCH_DIST, MAX_PINCH_DIST, MIN_ZOOM, MAX_ZOOM)
        this.zoomSmoothed += (zoomTarget - this.zoomSmoothed) * ZOOM_SMOOTH_FACTOR
        zoomValue = this.zoomSmoothed
      }
    } else {
      this.zoomSmoothed = 1.0
    }

    return {
      grab: { active: grabActive, deltaX, deltaY, deltaAngle },
      point: { active: pointActive, screenX, screenY },
      pinch: { active: pinchActive, zoom: zoomValue, paused },
      pinkyExtended: gesture.right === 'pinky_extended',
      click,
      back,
      debug: { leftDetected: false, rightDetected: false, leftGesture: 'idle' as const, rightGesture: 'idle' as const },
    }
  }

  reset(): void {
    this.grabOnset = null
    this.zoomSmoothed = 1.0
    this.wasGrabActive = false
    this.pinchHoldUntil = 0
  }
}
