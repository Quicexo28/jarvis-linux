// frontend/src/gestures/pose.ts
// Capa de pose estática: curl crudo → estados de dedo con histéresis →
// pose clasificada → pose estable (debounce de N frames).
import type { FingerState, FingerStates, LeftPose } from './types'
import type { HandFeatures } from './features'
import {
  CURL_CONTRACTED_ENTER, CURL_CONTRACTED_EXIT,
  CURL_EXTENDED_ENTER, CURL_EXTENDED_EXIT,
  THUMB_CONTRACTED_ENTER, THUMB_CONTRACTED_EXIT,
  THUMB_EXTENDED_ENTER, THUMB_EXTENDED_EXIT,
  POSE_STABLE_FRAMES,
  PEACE_SEP_ENTER, PEACE_CLOSE_ENTER,
} from './config'

type FingerName = keyof FingerStates
const FINGER_NAMES: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky']

interface Hysteresis {
  contractedEnter: number
  contractedExit: number
  extendedEnter: number
  extendedExit: number
}

const FINGER_T: Hysteresis = {
  contractedEnter: CURL_CONTRACTED_ENTER,
  contractedExit: CURL_CONTRACTED_EXIT,
  extendedEnter: CURL_EXTENDED_ENTER,
  extendedExit: CURL_EXTENDED_EXIT,
}

const THUMB_T: Hysteresis = {
  contractedEnter: THUMB_CONTRACTED_ENTER,
  contractedExit: THUMB_CONTRACTED_EXIT,
  extendedEnter: THUMB_EXTENDED_ENTER,
  extendedExit: THUMB_EXTENDED_EXIT,
}

function nextFingerState(current: FingerState, curl: number, t: Hysteresis): FingerState {
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

export function isDown(s: FingerState): boolean {
  return s !== 'extended'
}

/** Estados de dedo con histéresis (Schmitt trigger por dedo). */
export class FingerTracker {
  private states: FingerStates = {
    thumb: 'extended', index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended',
  }

  update(curl: HandFeatures['curl']): FingerStates {
    for (const name of FINGER_NAMES) {
      const t = name === 'thumb' ? THUMB_T : FINGER_T
      // Iterar hasta punto fijo: un salto grande de curl puede cruzar dos estados en un frame.
      let prev: FingerState
      let next = this.states[name]
      do {
        prev = next
        next = nextFingerState(prev, curl[name], t)
      } while (next !== prev)
      this.states[name] = next
    }
    return { ...this.states }
  }

  reset(): void {
    for (const name of FINGER_NAMES) this.states[name] = 'extended'
  }
}

/**
 * Clasificación de la mano izquierda. `prevPeace` da histéresis al gap
 * índice-medio: entre PEACE_CLOSE_ENTER y PEACE_SEP_ENTER se mantiene el
 * sub-estado anterior en vez de caer a idle (que soltaba el click a destiempo).
 * `prevPose` da histéresis al grab: la ENTRADA exige el puño completo (pulgar
 * incluido), pero una vez en grab el pulgar deja de contar — su rango de curl
 * es estrechísimo (0.79-0.99) y al arrastrar/rotar el puño cruza el umbral de
 * extended, lo que soltaba el grab a mitad de gesto (verificado con el probe:
 * episodios de 1-2 s cayendo a idle con la mano visible).
 */
export function classifyLeft(
  fingers: FingerStates,
  feat: HandFeatures,
  prevPeace: 'sep' | 'close' | null,
  prevPose: LeftPose = 'idle',
): LeftPose {
  const peacePosture =
    fingers.index === 'extended' &&
    fingers.middle === 'extended' &&
    isDown(fingers.ring) &&
    isDown(fingers.pinky)

  if (peacePosture) {
    if (feat.indexMiddleGap > PEACE_SEP_ENTER) return 'peace_sep'
    if (feat.indexMiddleGap < PEACE_CLOSE_ENTER) return 'peace_close'
    if (prevPeace === 'close') return 'peace_close'
    return 'peace_sep'
  }

  if (
    fingers.index === 'extended' &&
    isDown(fingers.middle) &&
    isDown(fingers.ring) &&
    isDown(fingers.pinky)
  ) return 'point'

  const downCount =
    [fingers.index, fingers.middle, fingers.ring, fingers.pinky].filter(isDown).length

  // Entrada estricta: puño completo, pulgar incluido (deliberado).
  if (isDown(fingers.thumb) && downCount === 4) return 'grab'

  // Grab pegajoso: ya enganchado, un dedo dudoso no suelta. Soltar = apertura
  // clara (≥2 dedos extendidos). point/peace arriba siguen ganando — la
  // transición deliberada a otra pose no pasa por aquí.
  if (prevPose === 'grab' && downCount >= 3) return 'grab'

  return 'idle'
}

/**
 * Debounce de pose: la pose estable solo cambia cuando la candidata se
 * sostiene POSE_STABLE_FRAMES frames seguidos. Evita flicker en transiciones
 * y con motion blur.
 */
export class PoseStabilizer<P extends string> {
  private stable: P
  private candidate: P | null = null
  private count = 0

  constructor(initial: P) {
    this.stable = initial
  }

  update(raw: P): P {
    if (raw === this.stable) {
      this.candidate = null
      this.count = 0
      return this.stable
    }
    if (raw === this.candidate) {
      this.count++
    } else {
      this.candidate = raw
      this.count = 1
    }
    if (this.count >= POSE_STABLE_FRAMES) {
      this.stable = raw
      this.candidate = null
      this.count = 0
    }
    return this.stable
  }

  get current(): P {
    return this.stable
  }

  reset(initial: P): void {
    this.stable = initial
    this.candidate = null
    this.count = 0
  }
}
