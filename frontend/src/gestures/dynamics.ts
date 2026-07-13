// frontend/src/gestures/dynamics.ts
// Trackers de gestos progresivos y discretos. Puros y deterministas (t explícito):
// todo el suavizado/integración vive aquí, no en los consumers.
import type { FingerStates, LeftPose } from './types'
import type { HandFeatures } from './features'
import { OneEuro, wrapAngle, clamp } from './filters'
import { isDown } from './pose'
import {
  LOST_GRACE_MS,
  PINCH_ENGAGE_APERTURE, PINCH_RELEASE_APERTURE,
  PINCH_GAIN_IN, PINCH_GAIN_OUT, PINCH_ANCHOR_DEADZONE,
  ZOOM_MIN, ZOOM_MAX, POSE_STABLE_FRAMES,
  GRAB_PALM_REF, GRAB_SCALE_MIN, GRAB_SCALE_MAX,
  DISCRETE_MIN_HOLD_MS, DISCRETE_COOLDOWN_MS,
  POINTER_EXPAND,
  EURO_POINTER, EURO_WRIST, EURO_APERTURE, EURO_ANGLE, EURO_ROT,
} from './config'

type V3 = { x: number; y: number; z: number }

interface PalmBasis { u: V3; v: V3; w: V3 }

function v3dot(a: V3, b: V3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function v3cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

/**
 * Base ortonormal de la palma: u = eje de la mano, w = normal ortogonalizada
 * contra u, v = w×u. null si la mano está degenerada ese frame (normal ∥ eje).
 */
function palmBasis(axis: V3, normal: V3): PalmBasis | null {
  const d = v3dot(normal, axis)
  const wRaw = { x: normal.x - d * axis.x, y: normal.y - d * axis.y, z: normal.z - d * axis.z }
  const n = Math.sqrt(v3dot(wRaw, wRaw))
  if (n < 1e-6) return null
  const w = { x: wRaw.x / n, y: wRaw.y / n, z: wRaw.z / n }
  return { u: axis, v: v3cross(w, axis), w }
}

/**
 * Yaw/pitch de la rotación RELATIVA R = B·B0ᵀ (frame del enganche → actual),
 * Euler Y-X-Z: yaw = atan2(R02, R22), pitch = asin(−R12). Ejes desacoplados —
 * las proyecciones independientes de la primera versión mezclaban roll en el
 * yaw al combinar movimientos. Ángulos ANCLADOS al enganche (sin acumulación
 * → sin drift): misma orientación de mano = misma orientación de figura.
 */
function relativeYawPitch(b: PalmBasis, b0: PalmBasis): { yaw: number; pitch: number } {
  const r02 = b.u.x * b0.u.z + b.v.x * b0.v.z + b.w.x * b0.w.z
  const r12 = b.u.y * b0.u.z + b.v.y * b0.v.z + b.w.y * b0.w.z
  const r22 = b.u.z * b0.u.z + b.v.z * b0.v.z + b.w.z * b0.w.z
  return { yaw: Math.atan2(r02, r22), pitch: Math.asin(clamp(-r12, -1, 1)) }
}

/**
 * Grab (puño izquierdo): deltas de arrastre + roll de palma, relativos al
 * punto de enganche. Muñeca filtrada con One-Euro; deltas normalizados por el
 * tamaño de palma en imagen (misma sensibilidad cerca o lejos de la cámara).
 * Convención de pantalla: deltaX>0 = mano a la derecha, deltaY>0 = mano abajo.
 */
export class GrabTracker {
  active = false
  deltaX = 0
  deltaY = 0
  deltaAngle = 0
  rotYaw = 0
  rotPitch = 0

  private onset: { x: number; y: number } | null = null
  private onsetAngleAccum = 0
  private onsetBasis: PalmBasis | null = null
  private scale = 1
  private fx = new OneEuro(EURO_WRIST)
  private fy = new OneEuro(EURO_WRIST)
  private fa = new OneEuro(EURO_ANGLE)
  private fYaw = new OneEuro(EURO_ROT)
  private fPitch = new OneEuro(EURO_ROT)
  // Ángulo desenvuelto (acumulado): filtrar el atan2 crudo saltaría en ±π.
  private angleAccum = 0
  private prevRawAngle: number | null = null
  private lastSeenT = -Infinity

  update(posed: boolean, feat: HandFeatures | null, t: number): void {
    if (feat) this.lastSeenT = t

    if (posed && feat) {
      const x = this.fx.filter(feat.wristImage.x, t)
      const y = this.fy.filter(feat.wristImage.y, t)

      if (this.prevRawAngle === null) {
        this.angleAccum = feat.palmAngle
      } else {
        this.angleAccum += wrapAngle(feat.palmAngle - this.prevRawAngle)
      }
      this.prevRawAngle = feat.palmAngle
      const ang = this.fa.filter(this.angleAccum, t)

      const basis = palmBasis(feat.palmAxisWorld, feat.palmNormalWorld)

      if (!this.active) {
        this.active = true
        this.onset = { x, y }
        this.onsetAngleAccum = ang
        this.onsetBasis = basis
        this.deltaX = 0
        this.deltaY = 0
        this.deltaAngle = 0
        this.rotYaw = 0
        this.rotPitch = 0
        this.fYaw.reset()
        this.fPitch.reset()
        this.scale = clamp(GRAB_PALM_REF / Math.max(feat.palmImageSize, 1e-3), GRAB_SCALE_MIN, GRAB_SCALE_MAX)
        return
      }

      if (this.onset) {
        // Imagen sin espejar: mano físicamente a la derecha → x de imagen BAJA.
        this.deltaX = (this.onset.x - x) * this.scale
        this.deltaY = (y - this.onset.y) * this.scale
        // El roll percibido por el usuario es el opuesto al de la imagen (espejo).
        this.deltaAngle = -wrapAngle(ang - this.onsetAngleAccum)
        // Frame degenerado (basis null): congela yaw/pitch, el resto sigue.
        if (basis && this.onsetBasis) {
          const { yaw, pitch } = relativeYawPitch(basis, this.onsetBasis)
          // Signos validados A MANO (2026-07-05): el usuario reportó la primera
          // convención como invertida en ambos ejes. Cambiar solo con re-prueba.
          this.rotYaw = this.fYaw.filter(yaw, t)
          this.rotPitch = this.fPitch.filter(pitch, t)
        } else if (basis && !this.onsetBasis) {
          this.onsetBasis = basis
        }
      }
      return
    }

    // Mano perdida (feat null) dentro de la gracia: congelar valores, seguir activo.
    if (this.active && !feat && t - this.lastSeenT <= LOST_GRACE_MS) return

    this.release()
  }

  private release(): void {
    this.active = false
    this.deltaX = 0
    this.deltaY = 0
    this.deltaAngle = 0
    this.rotYaw = 0
    this.rotPitch = 0
    this.onset = null
    this.onsetBasis = null
    this.prevRawAngle = null
    this.angleAccum = 0
    this.fx.reset()
    this.fy.reset()
    this.fa.reset()
    this.fYaw.reset()
    this.fPitch.reset()
  }

  reset(): void {
    this.release()
    this.lastSeenT = -Infinity
  }
}

/**
 * Pinch (pulgar-índice derecho): zoom ANCLADO a la apertura.
 * Engancha al contacto (deliberado — 2 frames estables), arranca en zoom 1.0 y
 * mapea la apertura ACTUAL contra la de enganche: zoom = exp(gain·Δ). Función
 * directa y continua de la distancia pulgar-índice — misma apertura, mismo
 * zoom, sin drift ni pasos (la integración con deadband se sentía a tirones).
 * Sin saltos al entrar (el mapeo absoluto de v1 saltaba al valor de la
 * apertura inicial). Pegajoso: una vez enganchado NO se suelta por cambio de
 * pose — solo mano claramente abierta, apertura enorme o mano perdida >
 * gracia. Eso mata el "zoom que se atasca" cuando el spread cruzaba el umbral
 * de contacto de v1.
 */
export class PinchTracker {
  active = false
  zoom = 1.0

  private engageCount = 0
  private fAperture = new OneEuro(EURO_APERTURE)
  private anchorA = 0
  private lastSeenT = -Infinity

  update(fingers: FingerStates | null, feat: HandFeatures | null, t: number): void {
    if (feat) this.lastSeenT = t

    if (!this.active) {
      if (feat && fingers) {
        // Un puño también junta pulgar e índice: exigir que no estén ambos
        // totalmente contraídos distingue pinch de puño (zoom fantasma de v1).
        const fist = fingers.thumb === 'contracted' && fingers.index === 'contracted'
        const posture =
          isDown(fingers.middle) && isDown(fingers.ring) && isDown(fingers.pinky) && !fist
        if (posture && feat.aperture < PINCH_ENGAGE_APERTURE) {
          this.engageCount++
          if (this.engageCount >= POSE_STABLE_FRAMES) this.engage(feat, t)
        } else {
          this.engageCount = 0
        }
      } else {
        this.engageCount = 0
      }
      return
    }

    // Enganchado, mano perdida: congelar dentro de la gracia, soltar después.
    if (!feat) {
      if (t - this.lastSeenT > LOST_GRACE_MS) this.release()
      return
    }

    // Soltar: mano claramente abierta o apertura de sobra.
    const openHand =
      fingers !== null &&
      [fingers.index, fingers.middle, fingers.ring].filter(s => s === 'extended').length >= 3
    if (feat.aperture > PINCH_RELEASE_APERTURE || openHand) {
      this.release()
      return
    }

    const a = this.fAperture.filter(feat.aperture, t)
    let d = a - this.anchorA
    // Zona muerta C0 en el ancla: temblor alrededor del contacto no vibra el
    // zoom en 1.0, y fuera de ella el mapeo sigue continuo (sin escalón).
    d = Math.sign(d) * Math.max(0, Math.abs(d) - PINCH_ANCHOR_DEADZONE)
    const gain = d >= 0 ? PINCH_GAIN_IN : PINCH_GAIN_OUT
    this.zoom = clamp(Math.exp(gain * d), ZOOM_MIN, ZOOM_MAX)
  }

  private engage(feat: HandFeatures, t: number): void {
    this.active = true
    this.zoom = 1.0
    this.engageCount = 0
    this.fAperture.reset()
    this.anchorA = this.fAperture.filter(feat.aperture, t)
  }

  private release(): void {
    this.active = false
    this.zoom = 1.0
    this.engageCount = 0
    this.fAperture.reset()
  }

  reset(): void {
    this.release()
    this.lastSeenT = -Infinity
  }
}

/**
 * Puntero (índice izquierdo): punta filtrada con One-Euro y mapeada a pantalla
 * (espejo + expansión alrededor del centro — la mano no llega cómoda a los
 * bordes del frame de cámara).
 */
export class PointerTracker {
  active = false
  screenX = 0.5
  screenY = 0.5

  private fx = new OneEuro(EURO_POINTER)
  private fy = new OneEuro(EURO_POINTER)
  private lastSeenT = -Infinity

  update(posed: boolean, feat: HandFeatures | null, t: number): void {
    if (feat) this.lastSeenT = t

    if (posed && feat) {
      const x = this.fx.filter(feat.indexTipImage.x, t)
      const y = this.fy.filter(feat.indexTipImage.y, t)
      const sx = 1 - x // espejo: coords de pantalla
      this.screenX = clamp(0.5 + (sx - 0.5) * POINTER_EXPAND, 0, 1)
      this.screenY = clamp(0.5 + (y - 0.5) * POINTER_EXPAND, 0, 1)
      this.active = true
      return
    }

    // Dropout breve: puntero congelado en vez de desaparecer y reaparecer.
    if (this.active && !feat && t - this.lastSeenT <= LOST_GRACE_MS) return

    this.active = false
    this.fx.reset()
    this.fy.reset()
  }

  reset(): void {
    this.active = false
    this.fx.reset()
    this.fy.reset()
    this.lastSeenT = -Infinity
  }
}

/**
 * Eventos discretos: soltar peace_sep → click, soltar peace_close → back.
 * "Soltar" = transicionar a OTRA pose con la mano aún visible; perder la mano
 * cancela el episodio (pérdida de tracking ≠ intención). Cooldown anti doble
 * disparo.
 */
export class DiscreteTracker {
  click = false
  back = false

  private holdPose: 'peace_sep' | 'peace_close' | null = null
  private holdStart = 0
  private lastEmit = -Infinity

  update(pose: LeftPose | null, handPresent: boolean, t: number): void {
    this.click = false
    this.back = false

    const cur = pose === 'peace_sep' || pose === 'peace_close' ? pose : null
    if (cur === this.holdPose) return

    // Sale de un hold: emitir solo si fue release deliberado (mano visible),
    // sostenido lo suficiente y fuera del cooldown.
    if (this.holdPose !== null) {
      const held = t - this.holdStart
      if (handPresent && held >= DISCRETE_MIN_HOLD_MS && t - this.lastEmit >= DISCRETE_COOLDOWN_MS) {
        if (this.holdPose === 'peace_sep') this.click = true
        else this.back = true
        this.lastEmit = t
      }
    }

    this.holdPose = cur
    this.holdStart = t
  }

  reset(): void {
    this.click = false
    this.back = false
    this.holdPose = null
    this.holdStart = 0
    this.lastEmit = -Infinity
  }
}
