// frontend/src/gestures/state.ts
import type { HandFeatures, HandState, FingerState } from './types'
import {
  CURL_CONTRACTED_ENTER, CURL_CONTRACTED_EXIT,
  CURL_EXTENDED_ENTER, CURL_EXTENDED_EXIT,
  THUMB_CONTRACTED_ENTER, THUMB_CONTRACTED_EXIT,
  THUMB_EXTENDED_ENTER, THUMB_EXTENDED_EXIT,
  CONTACT_THUMB_INDEX_ENTER, CONTACT_THUMB_INDEX_EXIT,
} from './config'

type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'
const FINGER_NAMES: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky']

interface HysteresisThresholds {
  contractedEnter: number
  contractedExit: number
  extendedEnter: number
  extendedExit: number
}

const FINGER_THRESHOLDS: HysteresisThresholds = {
  contractedEnter: CURL_CONTRACTED_ENTER,
  contractedExit: CURL_CONTRACTED_EXIT,
  extendedEnter: CURL_EXTENDED_ENTER,
  extendedExit: CURL_EXTENDED_EXIT,
}

const THUMB_THRESHOLDS: HysteresisThresholds = {
  contractedEnter: THUMB_CONTRACTED_ENTER,
  contractedExit: THUMB_CONTRACTED_EXIT,
  extendedEnter: THUMB_EXTENDED_ENTER,
  extendedExit: THUMB_EXTENDED_EXIT,
}

function nextFingerState(current: FingerState, curl: number, t: HysteresisThresholds): FingerState {
  switch (current) {
    case 'contracted':
      if (curl > t.contractedExit) return 'half'
      return 'contracted'
    case 'half':
      if (curl < t.contractedEnter) return 'contracted'
      if (curl > t.extendedEnter) return 'extended'
      return 'half'
    case 'extended':
      if (curl < t.extendedExit) return 'half'
      return 'extended'
  }
}

export class HandStateTracker {
  private fingerStates: Record<FingerName, FingerState> = {
    thumb: 'extended', index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended',
  }
  private thumbIndexContact = false

  update(features: HandFeatures): HandState {
    for (const name of FINGER_NAMES) {
      const thresholds = name === 'thumb' ? THUMB_THRESHOLDS : FINGER_THRESHOLDS
      let prev: FingerState
      let next = this.fingerStates[name]
      do {
        prev = next
        next = nextFingerState(prev, features.curl[name], thresholds)
      } while (next !== prev)
      this.fingerStates[name] = next
    }

    if (this.thumbIndexContact) {
      if (features.tipDistances.thumbIndex > CONTACT_THUMB_INDEX_EXIT) {
        this.thumbIndexContact = false
      }
    } else {
      if (features.tipDistances.thumbIndex < CONTACT_THUMB_INDEX_ENTER) {
        this.thumbIndexContact = true
      }
    }

    const fingers = { ...this.fingerStates }
    let extendedCount = 0
    for (const name of FINGER_NAMES) {
      if (fingers[name] === 'extended') extendedCount++
    }

    return {
      fingers,
      contacts: { thumbIndex: this.thumbIndexContact },
      isIdle: extendedCount === 5,
      extendedCount,
    }
  }
}
