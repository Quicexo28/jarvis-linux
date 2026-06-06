// frontend/src/gestures/types.ts

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface HandFeatures {
  palmSize: number
  curl: {
    thumb: number
    index: number
    middle: number
    ring: number
    pinky: number
  }
  tipDistances: {
    thumbIndex: number
    thumbIndex2D: number
    indexMiddle: number
    middleRing: number
    ringPinky: number
  }
  wristPosition: Vec3
  indexTipPosition: Vec3
  /** Palm roll angle (radians) in the image plane: atan2 of wrist→middle-MCP. */
  palmAngle: number
}

export type FingerState = 'extended' | 'half' | 'contracted'

export interface HandState {
  fingers: {
    thumb: FingerState
    index: FingerState
    middle: FingerState
    ring: FingerState
    pinky: FingerState
  }
  contacts: {
    thumbIndex: boolean
  }
  isIdle: boolean
  extendedCount: number
}

export type GestureId = 'grab' | 'pinch' | 'point' | 'peace_sep' | 'peace_close' | 'pinky_extended' | 'idle'

export interface GestureResult {
  left: GestureId
  right: GestureId
}

export interface ActiveGesture {
  id: GestureId
  hand: 'left' | 'right'
  continuousValue?: number
}

export type ModifierStatus =
  | { type: 'none' }
  | { type: 'paused'; frozenValue: number }
  | { type: 'waiting_resume'; frozenValue: number; target: number; tolerance: number }

export interface GestureOutput {
  grab: {
    active: boolean
    deltaX: number
    deltaY: number
    /** Palm roll delta (radians) since grab onset, wrapped to [-π,π]. For 1:1 angular rotation. */
    deltaAngle: number
  }
  point: {
    active: boolean
    screenX: number
    screenY: number
  }
  pinch: {
    active: boolean
    zoom: number
    paused: boolean
  }
  pinkyExtended: boolean
  click: boolean
  back: boolean
  debug: {
    leftDetected: boolean
    rightDetected: boolean
    leftGesture: GestureId
    rightGesture: GestureId
  }
}
