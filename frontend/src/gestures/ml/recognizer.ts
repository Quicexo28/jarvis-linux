import { GestureMLModel } from './model'
import { type GestureClass } from './classes'
import type { HandFeatures, GestureResult, GestureId } from '../types'
import { DISCRETE_MIN_HOLD_MS } from '../config'

function mlClassToGestureId(cls: GestureClass): GestureId {
  switch (cls) {
    case 'grab': return 'grab'
    case 'point': return 'point'
    case 'pinch': return 'pinch'
    case 'peace_sep': return 'peace_sep'
    case 'peace_close': return 'peace_close'
    case 'pinky_extended': return 'pinky_extended'
    default: return 'idle'
  }
}

export class MLGestureRecognizer {
  private model = new GestureMLModel()
  private ready = false
  private minConfidence = 0.6

  private peaceSepActive = false
  private peaceSepStartMs = 0
  private peaceCloseActive = false
  private peaceCloseStartMs = 0
  private pendingClick = false
  private pendingBack = false

  async init(): Promise<boolean> {
    this.ready = await this.model.load()
    return this.ready
  }

  isReady(): boolean { return this.ready }

  update(
    leftFeatures: HandFeatures | null,
    rightFeatures: HandFeatures | null,
    timestampMs: number,
  ): GestureResult {
    let left: GestureId = 'idle'
    let right: GestureId = 'idle'

    if (leftFeatures && this.ready) {
      const pred = this.model.predict(leftFeatures)
      if (pred.confidence >= this.minConfidence) {
        const cls = pred.gesture
        if (cls === 'grab' || cls === 'point' || cls === 'peace_sep' || cls === 'peace_close') {
          left = mlClassToGestureId(cls)
        }
      }
    }

    if (rightFeatures && this.ready) {
      const pred = this.model.predict(rightFeatures)
      if (pred.confidence >= this.minConfidence) {
        const cls = pred.gesture
        if (cls === 'pinch' || cls === 'pinky_extended') {
          right = mlClassToGestureId(cls)   // ambos son salidas reales (pinky_extended ya no → idle)
        }
      }
    }

    // Discrete release tracking: peace_sep -> click
    if (left === 'peace_sep') {
      if (!this.peaceSepActive) {
        this.peaceSepActive = true
        this.peaceSepStartMs = timestampMs
      }
    } else {
      if (this.peaceSepActive) {
        if (timestampMs - this.peaceSepStartMs >= DISCRETE_MIN_HOLD_MS) {
          this.pendingClick = true
        }
        this.peaceSepActive = false
      }
    }

    // Discrete release tracking: peace_close -> back
    if (left === 'peace_close') {
      if (!this.peaceCloseActive) {
        this.peaceCloseActive = true
        this.peaceCloseStartMs = timestampMs
      }
    } else {
      if (this.peaceCloseActive) {
        if (timestampMs - this.peaceCloseStartMs >= DISCRETE_MIN_HOLD_MS) {
          this.pendingBack = true
        }
        this.peaceCloseActive = false
      }
    }

    return { left, right }
  }

  consumeDiscreteEvents(): { click: boolean; back: boolean } {
    const events = { click: this.pendingClick, back: this.pendingBack }
    this.pendingClick = false
    this.pendingBack = false
    return events
  }

  isPinkyExtended(rightFeatures: HandFeatures | null): boolean {
    if (!rightFeatures || !this.ready) return false
    const pred = this.model.predict(rightFeatures)
    return pred.gesture === 'pinky_extended' && pred.confidence >= this.minConfidence
  }
}
