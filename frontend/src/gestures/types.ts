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
/** Pose estática de UNA mano. Se llama `LeftPose` por historia: cuando solo la
 *  mano izquierda manejaba la interfaz. Hoy se clasifica igual en las dos. */
export type LeftPose = 'grab' | 'point' | 'peace_sep' | 'peace_close' | 'idle'
export type HandSide = 'left' | 'right'

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
    /** Velocidad en coords de pantalla por ms. La usa el cursor para adelantar
     * la posición y compensar el retardo del pipeline (~20 Hz + One-Euro). */
    vx: number
    vy: number
  }
  pinch: {
    active: boolean
    /** Zoom relativo integrado: 1.0 al engancharse, ZOOM_MIN..ZOOM_MAX. Vuelve a 1.0 al soltar. */
    zoom: number
    paused: boolean
  }
  /**
   * Tap de la mano que APUNTA (pulgar toca el índice sin deshacer el point).
   * Es el "botón del ratón" del cursor de mano: `down`/`up` son pulsos de un
   * ciclo y `pressed` el estado sostenido (permite arrastrar).
   */
  tap: {
    pressed: boolean
    down: boolean
    up: boolean
  }
  pinkyExtended: boolean
  /**
   * Qué mano está manejando la interfaz (cursor/tap/grab/discretos). La
   * izquierda si está a la vista; si no, la derecha. null = ninguna mano.
   * El zoom sigue en la derecha salvo que la derecha sea ESTA y esté apuntando.
   */
  pointerHand: HandSide | null
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
  point: { active: false, screenX: 0, screenY: 0, vx: 0, vy: 0 },
  tap: { pressed: false, down: false, up: false },
  pinch: { active: false, zoom: 1.0, paused: false },
  pinkyExtended: false,
  pointerHand: null,
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

/**
 * Canal ÚNICO de landmarks post-swap. Lo publica `useGesturePipeline` cuando
 * hay al menos un consumidor (refcount en `gestureStore`), y lo consumen tanto
 * el panel de debug como cualquier consumidor futuro de geometría de dedos.
 *
 * Lleva las DOS representaciones porque no son intercambiables: `image` es el
 * único marco COMÚN a las dos manos (0..1 sobre el frame, sin espejar), y
 * `world` está centrado POR MANO — sirve para clasificar pose y para recuperar
 * la escala métrica (palmSize world / palmSize image), nunca para relacionar
 * una mano con la otra.
 */
export interface HandsFrame {
  left: HandFrame | null
  right: HandFrame | null
  /** performance.now() del frame que produjo estos landmarks. */
  t: number
}
