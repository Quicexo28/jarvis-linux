// frontend/src/gestures/engine.ts
// Orquestador puro del sistema de gestos: HandFrames (ya swapeados a lado
// físico) → GestureOutput. Sin DOM, sin MediaPipe — testeable en Node.
//
// Funciones (contrato de producto, no cambiar sin avisar):
//   mano IZQUIERDA física — grab (puño) = arrastrar/rotar, point (índice) = cursor,
//     peace abierta soltada = click, peace cerrada soltada = back.
//   mano DERECHA física — pinch pulgar-índice = zoom progresivo.
import type { HandFrame, GestureOutput, LeftPose } from './types'
import { extractFeatures, type HandFeatures } from './features'
import { FingerTracker, PoseStabilizer, classifyLeft } from './pose'
import { GrabTracker, PinchTracker, PointerTracker, DiscreteTracker } from './dynamics'
import { LOST_GRACE_MS } from './config'

export class GestureEngine {
  private leftFingers = new FingerTracker()
  private rightFingers = new FingerTracker()
  private leftPose = new PoseStabilizer<LeftPose>('idle')
  private prevPeace: 'sep' | 'close' | null = null
  private lastLeftSeenT = -Infinity
  private lastLeftPose: LeftPose = 'idle'

  private grab = new GrabTracker()
  private pointer = new PointerTracker()
  private pinch = new PinchTracker()
  private discrete = new DiscreteTracker()

  update(left: HandFrame | null, right: HandFrame | null, t: number): GestureOutput {
    // --- Izquierda: pose estable con gracia ante dropouts ---
    let leftFeat: HandFeatures | null = null
    let leftStable: LeftPose | null = null

    if (left) {
      leftFeat = extractFeatures(left.world, left.image)
      const fingers = this.leftFingers.update(leftFeat.curl)
      const raw = classifyLeft(fingers, leftFeat, this.prevPeace, this.leftPose.current)
      this.prevPeace = raw === 'peace_sep' ? 'sep' : raw === 'peace_close' ? 'close' : null
      leftStable = this.leftPose.update(raw)
      this.lastLeftSeenT = t
      this.lastLeftPose = leftStable
    } else if (t - this.lastLeftSeenT <= LOST_GRACE_MS) {
      // Dropout breve: mantener la pose (los trackers congelan sus valores).
      leftStable = this.lastLeftPose
    } else {
      this.leftPose.reset('idle')
      this.leftFingers.reset()
      this.lastLeftPose = 'idle'
      this.prevPeace = null
      leftStable = null
    }

    this.grab.update(leftStable === 'grab', leftFeat, t)
    this.pointer.update(leftStable === 'point', leftFeat, t)
    this.discrete.update(leftStable, left !== null, t)

    // --- Derecha: pinch (engage/release y zoom viven en el tracker) ---
    let rightFeat: HandFeatures | null = null
    let rightFingers = null
    if (right) {
      rightFeat = extractFeatures(right.world, right.image)
      rightFingers = this.rightFingers.update(rightFeat.curl)
    }
    this.pinch.update(rightFingers, rightFeat, t)

    return {
      grab: {
        active: this.grab.active,
        deltaX: this.grab.deltaX,
        deltaY: this.grab.deltaY,
        deltaAngle: this.grab.deltaAngle,
        rotYaw: this.grab.rotYaw,
        rotPitch: this.grab.rotPitch,
      },
      point: {
        active: this.pointer.active,
        screenX: this.pointer.screenX,
        screenY: this.pointer.screenY,
      },
      pinch: {
        active: this.pinch.active,
        zoom: this.pinch.zoom,
        paused: false,
      },
      pinkyExtended: false,
      click: this.discrete.click,
      back: this.discrete.back,
      debug: {
        leftDetected: left !== null,
        rightDetected: right !== null,
        leftGesture: leftStable ?? 'idle',
        rightGesture: this.pinch.active ? 'pinch' : 'idle',
      },
    }
  }

  reset(): void {
    this.leftFingers.reset()
    this.rightFingers.reset()
    this.leftPose.reset('idle')
    this.prevPeace = null
    this.lastLeftSeenT = -Infinity
    this.lastLeftPose = 'idle'
    this.grab.reset()
    this.pointer.reset()
    this.pinch.reset()
    this.discrete.reset()
  }
}
