// frontend/src/gestures/engine.ts
// Orquestador puro del sistema de gestos: HandFrames (ya swapeados a lado
// físico) → GestureOutput. Sin DOM, sin MediaPipe — testeable en Node.
//
// Funciones (contrato de producto, no cambiar sin avisar):
//   MANO DE PUNTERO — grab (puño) = arrastrar/rotar, point (índice) = cursor,
//     tap (pulgar toca el índice SIN dejar de apuntar) = botón del cursor,
//     peace abierta soltada = click, peace cerrada soltada = back.
//   MANO DE ZOOM — pinch pulgar-índice = zoom progresivo.
//
// CUÁL ES CUÁL, y por qué dejó de estar fijo (2026-09-18): la v2 ataba el
// puntero a la mano IZQUIERDA física y el zoom a la derecha. Con una sola mano
// a la vista — el caso normal — el sistema detectaba perfectamente y aun así
// "no pasaba nada": si esa mano era la derecha, solo podía hacer zoom, y el
// cursor, el tap, el arrastre del anillo y el back no existían. Desde el otro
// lado de la cámara eso se siente exactamente igual que un pipeline que no ve
// nada (verificado en vivo: `R True pinch` sostenido, `L False idle`).
// Ahora el papel se ASIGNA:
//   - dos manos → como siempre: izquierda apunta, derecha hace zoom;
//   - una sola mano → esa manda la interfaz y NO hay zoom.
// La izquierda conserva la prioridad para que con las dos manos arriba el
// reparto sea estable y no parpadee entre roles.
//
// El zoom EXIGE la segunda mano a propósito. Intentar repartir una sola mano
// entre puntero y zoom por la pose falla en la práctica: el enganche del pinch
// solo pide meñique/anular/corazón bajados y el pulgar cerca del índice, cosa
// que una mano en REPOSO cumple sin querer — medido en vivo, `R pinch`
// sostenido con la mano quieta. Y como el pinch es pegajoso (solo suelta con la
// mano claramente abierta), se quedaba enganchado, y `pinch.active` bloquea el
// arrastre del anillo en AwakeApp: la interfaz dejaba de responder sola.
import type { HandFrame, GestureOutput, LeftPose, HandSide, FingerStates } from './types'
import { extractFeatures, type HandFeatures } from './features'
import { FingerTracker, PoseStabilizer, classifyLeft } from './pose'
import { GrabTracker, PinchTracker, PointerTracker, DiscreteTracker, TapTracker } from './dynamics'
import { LOST_GRACE_MS } from './config'

/**
 * Estado de pose de UNA mano: dedos con histéresis + pose estable + gracia ante
 * dropouts. Era código suelto dentro de `update` cuando solo la izquierda tenía
 * pose; con las dos manos clasificadas hace falta una instancia por lado.
 */
class HandPose {
  private fingerTracker = new FingerTracker()
  private stable = new PoseStabilizer<LeftPose>('idle')
  private prevPeace: 'sep' | 'close' | null = null
  private lastSeenT = -Infinity
  private lastPose: LeftPose = 'idle'

  feat: HandFeatures | null = null
  pose: LeftPose | null = null
  /** Dedos del frame actual. Se GUARDA en vez de recalcularse: `FingerTracker`
   *  lleva histéresis con estado, así que llamarlo dos veces por frame avanza
   *  el Schmitt de más y los dedos "saltan" un escalón antes de tiempo. */
  fingers: FingerStates | null = null

  update(hand: HandFrame | null, t: number): void {
    if (hand) {
      this.feat = extractFeatures(hand.world, hand.image)
      const fingers = this.fingerTracker.update(this.feat.curl)
      this.fingers = fingers
      const raw = classifyLeft(fingers, this.feat, this.prevPeace, this.stable.current)
      this.prevPeace = raw === 'peace_sep' ? 'sep' : raw === 'peace_close' ? 'close' : null
      this.pose = this.stable.update(raw)
      this.lastSeenT = t
      this.lastPose = this.pose
      return
    }
    this.feat = null
    this.fingers = null
    if (t - this.lastSeenT <= LOST_GRACE_MS) {
      // Dropout breve: mantener la pose (los trackers congelan sus valores).
      this.pose = this.lastPose
      return
    }
    this.stable.reset('idle')
    this.fingerTracker.reset()
    this.lastPose = 'idle'
    this.prevPeace = null
    this.pose = null
  }

  reset(): void {
    this.fingerTracker.reset()
    this.stable.reset('idle')
    this.prevPeace = null
    this.lastSeenT = -Infinity
    this.lastPose = 'idle'
    this.feat = null
    this.fingers = null
    this.pose = null
  }
}

export class GestureEngine {
  private left = new HandPose()
  private right = new HandPose()

  private grab = new GrabTracker()
  private pointer = new PointerTracker()
  private pinch = new PinchTracker()
  private discrete = new DiscreteTracker()
  private tap = new TapTracker()

  /** Lado que ejerce de mano de puntero ahora mismo. */
  private ptrSide: HandSide | null = null

  update(left: HandFrame | null, right: HandFrame | null, t: number): GestureOutput {
    this.left.update(left, t)
    this.right.update(right, t)

    // --- Reparto de papeles ---
    // La izquierda manda siempre que esté (o esté dentro de la gracia). Si no
    // hay izquierda, la derecha hace de puntero: con una sola mano a la vista,
    // no tener cursor es peor que no tener zoom.
    const leftPresent = this.left.pose !== null
    const rightPresent = this.right.pose !== null
    const ptrSide: HandSide | null = leftPresent ? 'left' : rightPresent ? 'right' : null

    // Cambiar de mano sin resetear arrastraría el onset del grab y los filtros
    // del puntero de una mano a la otra: salto de cursor y figura girando sola.
    if (ptrSide !== this.ptrSide) {
      this.grab.reset()
      this.pointer.reset()
      this.tap.reset()
      this.discrete.reset()
      this.ptrSide = ptrSide
    }

    const ptr = ptrSide === 'right' ? this.right : this.left
    const ptrPose = ptrSide === null ? null : ptr.pose
    const ptrFeat = ptrSide === null ? null : ptr.feat
    const ptrVisible = ptrSide === 'right' ? right !== null : left !== null

    this.grab.update(ptrPose === 'grab', ptrFeat, t)
    // El tap va ANTES del puntero: mientras está presionado el puntero entra en
    // modo fino anclado al punto de presión (cerrar la pinza mueve la punta del
    // índice, y sin esto el clic acaba fuera del botón que se estaba señalando).
    this.tap.update(ptrPose === 'point', ptrFeat, t)
    this.pointer.update(ptrPose === 'point', ptrFeat, t, this.tap.pressed)
    this.discrete.update(ptrPose, ptrVisible, t)

    // --- Zoom: solo la DERECHA y solo cuando la izquierda está manejando la
    // interfaz (ver la nota de cabecera: con una sola mano, el zoom le robaba
    // el mando al puntero).
    const zoomHand = ptrSide === 'left' ? this.right : null
    this.pinch.update(zoomHand?.fingers ?? null, zoomHand?.feat ?? null, t)

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
        vx: this.pointer.vx,
        vy: this.pointer.vy,
      },
      tap: {
        pressed: this.tap.pressed,
        down: this.tap.down,
        up: this.tap.up,
      },
      pinch: {
        active: this.pinch.active,
        zoom: this.pinch.zoom,
        paused: false,
      },
      pinkyExtended: false,
      click: this.discrete.click,
      back: this.discrete.back,
      pointerHand: ptrSide,
      debug: {
        leftDetected: left !== null,
        rightDetected: right !== null,
        leftGesture: this.left.pose ?? 'idle',
        rightGesture: this.pinch.active ? 'pinch' : (this.right.pose ?? 'idle'),
      },
    }
  }

  reset(): void {
    this.left.reset()
    this.right.reset()
    this.ptrSide = null
    this.grab.reset()
    this.pointer.reset()
    this.pinch.reset()
    this.discrete.reset()
    this.tap.reset()
  }
}
