// frontend/src/gestures/types.ts

export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * Una mano detectada, ya asignada a su lado FÍSICO.
 * El swap de handedness (label MediaPipe invertida por stream sin espejar)
 * se aplica ANTES de construir esto — el engine no sabe de labels.
 */
export interface HandFrame {
  /** Landmarks image-space (0..1 sobre el frame, SIN espejar). */
  image: Vec3[]
  /** Landmarks world (métricos, centrados en la mano) — para clasificar pose. */
  world: Vec3[]
  score: number
}

export type FingerState = 'extended' | 'half' | 'contracted'

export interface FingerStates {
  thumb: FingerState
  index: FingerState
  middle: FingerState
  ring: FingerState
  pinky: FingerState
}

export type GestureId = 'grab' | 'point' | 'peace_sep' | 'peace_close' | 'pinch' | 'idle'
export type LeftPose = 'grab' | 'point' | 'peace_sep' | 'peace_close' | 'idle'

export interface GestureOutput {
  grab: {
    active: boolean
    /** >0 = mano físicamente a la DERECHA de donde empezó el grab (coords de pantalla). */
    deltaX: number
    /** >0 = mano ABAJO de donde empezó (convención de drag de pantalla). */
    deltaY: number
    /** Roll de la palma desde el inicio del grab (rad, [-π,π]), signo natural para el usuario. */
    deltaAngle: number
    /** Yaw del puño (girar la palma izq/der) desde el enganche, rad, signo espejo-natural. */
    rotYaw: number
    /** Pitch del puño (inclinar nudillos adelante/atrás) desde el enganche, rad. */
    rotPitch: number
  }
  point: {
    active: boolean
    /** Coords de pantalla 0..1, espejo ya aplicado — usar directo. */
    screenX: number
    screenY: number
  }
  pinch: {
    active: boolean
    /** Zoom relativo integrado: 1.0 al engancharse, ZOOM_MIN..ZOOM_MAX. Vuelve a 1.0 al soltar. */
    zoom: number
    paused: boolean
  }
  pinkyExtended: boolean
  /** Pulso de un ciclo: soltar peace_sep tras ≥150 ms con la mano visible. */
  click: boolean
  /** Pulso de un ciclo: soltar peace_close tras ≥150 ms con la mano visible. */
  back: boolean
  debug: {
    leftDetected: boolean
    rightDetected: boolean
    leftGesture: GestureId
    rightGesture: GestureId
  }
}

export const DEFAULT_OUTPUT: GestureOutput = {
  grab: { active: false, deltaX: 0, deltaY: 0, deltaAngle: 0, rotYaw: 0, rotPitch: 0 },
  point: { active: false, screenX: 0, screenY: 0 },
  pinch: { active: false, zoom: 1.0, paused: false },
  pinkyExtended: false,
  click: false,
  back: false,
  debug: { leftDetected: false, rightDetected: false, leftGesture: 'idle', rightGesture: 'idle' },
}

/** Una mano cruda de MediaPipe (label SIN swap — el swap se hace en splitHands). */
export interface DetectedHand {
  label: 'Left' | 'Right'
  score: number
  image: Vec3[]
  world: Vec3[]
}

/** Landmarks image-space post-swap para el panel de debug (null = mano no detectada). */
export interface DebugFrame {
  left: Vec3[] | null
  right: Vec3[] | null
}
