// frontend/src/gestures/recognizer.ts
import type { HandState, HandFeatures, GestureId, GestureResult } from './types'
import { PEACE_SEP_MIN_DISTANCE, PEACE_CLOSE_MAX_DISTANCE, DISCRETE_MIN_HOLD_MS, CONTACT_THUMB_INDEX_ENTER } from './config'

interface DiscreteEvents {
  click: boolean
  back: boolean
}

function isContractedOrHalf(state: 'extended' | 'half' | 'contracted'): boolean {
  return state === 'contracted' || state === 'half'
}

function evaluateLeft(state: HandState, features: HandFeatures): GestureId {
  const { fingers } = state
  const { tipDistances } = features

  // Priority 1: peace_sep — index+middle extended, ring+pinky not extended, fingers spread
  if (
    fingers.index === 'extended' &&
    fingers.middle === 'extended' &&
    isContractedOrHalf(fingers.ring) &&
    isContractedOrHalf(fingers.pinky) &&
    tipDistances.indexMiddle > PEACE_SEP_MIN_DISTANCE
  ) return 'peace_sep'

  // Priority 2: peace_close — index+middle extended, ring+pinky not extended, fingers close
  if (
    fingers.index === 'extended' &&
    fingers.middle === 'extended' &&
    isContractedOrHalf(fingers.ring) &&
    isContractedOrHalf(fingers.pinky) &&
    tipDistances.indexMiddle < PEACE_CLOSE_MAX_DISTANCE
  ) return 'peace_close'

  // Priority 3: point — only index extended
  if (
    fingers.index === 'extended' &&
    isContractedOrHalf(fingers.middle) &&
    isContractedOrHalf(fingers.ring) &&
    isContractedOrHalf(fingers.pinky)
  ) return 'point'

  // Priority 4: grab — all fingers not extended
  if (
    isContractedOrHalf(fingers.thumb) &&
    isContractedOrHalf(fingers.index) &&
    isContractedOrHalf(fingers.middle) &&
    isContractedOrHalf(fingers.ring) &&
    isContractedOrHalf(fingers.pinky)
  ) return 'grab'

  // Fallback
  return 'idle'
}

export function evaluateRight(state: HandState, features: HandFeatures): GestureId {
  const { fingers } = state

  // Priority 1: pinch — middle/ring/pinky not extended, thumb+index close together
  if (
    isContractedOrHalf(fingers.middle) &&
    isContractedOrHalf(fingers.ring) &&
    isContractedOrHalf(fingers.pinky) &&
    features.tipDistances.thumbIndex < CONTACT_THUMB_INDEX_ENTER
  ) return 'pinch'

  // Fallback
  return 'idle'
}

export class GestureRecognizer {
  private peaceSepActive = false
  private peaceSepStartMs = 0
  private peaceCloseActive = false
  private peaceCloseStartMs = 0
  private pendingClick = false
  private pendingBack = false

  update(
    leftState: HandState | null,
    rightState: HandState | null,
    leftFeatures: HandFeatures | null,
    rightFeatures: HandFeatures | null,
    timestampMs: number,
  ): GestureResult {
    const left: GestureId = leftState && leftFeatures
      ? evaluateLeft(leftState, leftFeatures)
      : 'idle'
    const right: GestureId = rightState && rightFeatures
      ? evaluateRight(rightState, rightFeatures)
      : 'idle'

    // Discrete release tracking: peace_sep → click
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

    // Discrete release tracking: peace_close → back
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

  consumeDiscreteEvents(): DiscreteEvents {
    const events = { click: this.pendingClick, back: this.pendingBack }
    this.pendingClick = false
    this.pendingBack = false
    return events
  }
}
