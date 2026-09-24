import { test, expect, beforeEach } from 'vitest'
import { GrabTracker, PinchTracker, PointerTracker, DiscreteTracker, TapTracker } from './dynamics'
import type { FingerStates } from './types'
import type { HandFeatures } from './features'

const DT = 66

function feat(v: Partial<HandFeatures> = {}): HandFeatures {
  return {
    palmSize: 0.09,
    curl: { thumb: 0.99, index: 0.95, middle: 0.95, ring: 0.95, pinky: 0.95 },
    aperture: 1.0,
    indexMiddleGap: 0.5,
    wristImage: { x: 0.5, y: 0.5 },
    indexTipImage: { x: 0.5, y: 0.3 },
    palmImageSize: 0.18,
    palmAngle: -Math.PI / 2,
    palmAxisWorld: { x: 0, y: -1, z: 0 },
    palmNormalWorld: { x: 0, y: 0, z: -1 },
    ...v,
  }
}

function fingers(v: Partial<FingerStates> = {}): FingerStates {
  return { thumb: 'extended', index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended', ...v }
}

const pinchFingers = (): FingerStates =>
  fingers({ thumb: 'half', index: 'half', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })

// ---------- GrabTracker ----------

let grab: GrabTracker
beforeEach(() => { grab = new GrabTracker() })

test('grab: mano a la derecha (x de imagen baja) → deltaX positivo', () => {
  let t = 0
  for (let i = 0; i < 3; i++) { grab.update(true, feat({ wristImage: { x: 0.5, y: 0.5 } }), t); t += DT }
  expect(grab.active).toBe(true)
  for (let i = 0; i < 12; i++) { grab.update(true, feat({ wristImage: { x: 0.38, y: 0.5 } }), t); t += DT }
  expect(grab.deltaX).toBeGreaterThan(0.06)
  expect(Math.abs(grab.deltaY)).toBeLessThan(0.02)
})

test('grab: mano hacia abajo (y de imagen sube) → deltaY positivo', () => {
  let t = 0
  for (let i = 0; i < 3; i++) { grab.update(true, feat(), t); t += DT }
  for (let i = 0; i < 12; i++) { grab.update(true, feat({ wristImage: { x: 0.5, y: 0.62 } }), t); t += DT }
  expect(grab.deltaY).toBeGreaterThan(0.06)
})

test('grab: normalización por palma — mano lejos (palma chica) amplifica', () => {
  let t = 0
  const far = { palmImageSize: 0.09 }  // mitad de GRAB_PALM_REF → escala 1.8 (clamp)
  for (let i = 0; i < 3; i++) { grab.update(true, feat({ ...far, wristImage: { x: 0.5, y: 0.5 } }), t); t += DT }
  for (let i = 0; i < 12; i++) { grab.update(true, feat({ ...far, wristImage: { x: 0.4, y: 0.5 } }), t); t += DT }
  const farDelta = grab.deltaX

  const grab2 = new GrabTracker()
  t = 0
  for (let i = 0; i < 3; i++) { grab2.update(true, feat({ wristImage: { x: 0.5, y: 0.5 } }), t); t += DT }
  for (let i = 0; i < 12; i++) { grab2.update(true, feat({ wristImage: { x: 0.4, y: 0.5 } }), t); t += DT }
  expect(farDelta).toBeGreaterThan(grab2.deltaX * 1.5)
})

test('grab: roll de palma → deltaAngle negado (espejo)', () => {
  let t = 0
  for (let i = 0; i < 3; i++) { grab.update(true, feat({ palmAngle: -Math.PI / 2 }), t); t += DT }
  for (let i = 0; i < 15; i++) { grab.update(true, feat({ palmAngle: -Math.PI / 2 + 0.4 }), t); t += DT }
  expect(grab.deltaAngle).toBeLessThan(-0.25)
})

test('grab: girar la palma (yaw) y bascular nudillos (pitch) → rotYaw/rotPitch', () => {
  let t = 0
  for (let i = 0; i < 3; i++) { grab.update(true, feat(), t); t += DT }
  expect(grab.rotYaw).toBeCloseTo(0, 5)
  // Normal gira 30° hacia +x = Ry(−0.52) sobre la base del enganche.
  // Signos de la convención validada a mano el 2026-07-05.
  const s = Math.sin(0.52), c = Math.cos(0.52)
  for (let i = 0; i < 15; i++) {
    grab.update(true, feat({ palmNormalWorld: { x: s, y: 0, z: -c } }), t); t += DT
  }
  expect(grab.rotYaw).toBeLessThan(-0.3)
  expect(Math.abs(grab.rotPitch)).toBeLessThan(0.1) // sin cross-talk yaw→pitch
  // Eje de la mano bascula 20° hacia la cámara (Rx(−0.35)): pitch cambia, yaw estable.
  const yawSettled = grab.rotYaw
  const s2 = Math.sin(0.35), c2 = Math.cos(0.35)
  for (let i = 0; i < 15; i++) {
    grab.update(true, feat({ palmNormalWorld: { x: s, y: 0, z: -c }, palmAxisWorld: { x: 0, y: -c2, z: s2 } }), t); t += DT
  }
  expect(grab.rotPitch).toBeLessThan(-0.2)
  expect(Math.abs(grab.rotYaw - yawSettled)).toBeLessThan(0.08) // sin cross-talk pitch→yaw
})

test('grab: misma orientación de mano → misma rotación (anclado, ida y vuelta sin drift)', () => {
  let t = 0
  for (let i = 0; i < 3; i++) { grab.update(true, feat(), t); t += DT }
  const s = Math.sin(0.6), c = Math.cos(0.6)
  const turned = () => feat({ palmNormalWorld: { x: s, y: 0, z: -c } })
  for (let i = 0; i < 15; i++) { grab.update(true, turned(), t); t += DT }
  const first = grab.rotYaw
  for (let i = 0; i < 15; i++) { grab.update(true, feat(), t); t += DT }
  expect(Math.abs(grab.rotYaw)).toBeLessThan(0.05) // volver al enganche ≈ 0
  for (let i = 0; i < 15; i++) { grab.update(true, turned(), t); t += DT }
  expect(Math.abs(grab.rotYaw - first)).toBeLessThan(0.03)
})

test('grab: dropout no salta el giro (ratchet); re-agarre resetea el cero', () => {
  let t = 0
  const s = Math.sin(0.6), c = Math.cos(0.6)
  const turned = () => feat({ palmNormalWorld: { x: s, y: 0, z: -c } })
  // Engancha y gira a una posición asentada.
  for (let i = 0; i < 3; i++) { grab.update(true, feat(), t); t += DT }
  for (let i = 0; i < 15; i++) { grab.update(true, turned(), t); t += DT }
  const settled = grab.rotYaw
  expect(settled).toBeLessThan(-0.3)
  // Dropout breve (mano perdida) dentro de la gracia → giro CONGELADO, sigue activo.
  grab.update(true, null, t + 30); t += 30
  expect(grab.active).toBe(true)
  // Reaparece en orientación MUY distinta (mano repuesta): NO debe sumar el hueco
  // (el modelo anclado saltaba a relative(nuevaMano, onsetViejo)).
  grab.update(true, feat({ palmNormalWorld: { x: -s, y: 0, z: -c } }), t); t += DT
  expect(Math.abs(grab.rotYaw - settled)).toBeLessThan(0.05)
  // Soltar la pose y re-enganchar: la nueva posición pasa a ser el cero.
  grab.update(false, feat(), t); t += DT
  expect(grab.active).toBe(false)
  for (let i = 0; i < 3; i++) { grab.update(true, feat(), t); t += DT }
  expect(grab.active).toBe(true)
  expect(Math.abs(grab.rotYaw)).toBeLessThan(0.05)
})

test('grab: soltar la pose limpia los deltas', () => {
  let t = 0
  for (let i = 0; i < 5; i++) { grab.update(true, feat({ wristImage: { x: 0.4, y: 0.5 } }), t); t += DT }
  grab.update(false, feat(), t)
  expect(grab.active).toBe(false)
  expect(grab.deltaX).toBe(0)
})

test('grab: dropout breve congela; dropout largo suelta', () => {
  let t = 0
  for (let i = 0; i < 5; i++) { grab.update(true, feat({ wristImage: { x: 0.4, y: 0.5 } }), t); t += DT }
  const frozen = grab.deltaX
  grab.update(true, null, t + 100)   // perdida 100 ms — dentro de la gracia
  expect(grab.active).toBe(true)
  expect(grab.deltaX).toBe(frozen)
  grab.update(true, null, t + 400)   // 400 ms — fuera de la gracia
  expect(grab.active).toBe(false)
})

// ---------- PinchTracker ----------

let pinch: PinchTracker
beforeEach(() => { pinch = new PinchTracker() })

function engagePinch(t0 = 0): number {
  let t = t0
  for (let i = 0; i < 3; i++) { pinch.update(pinchFingers(), feat({ aperture: 0.35 }), t); t += DT }
  expect(pinch.active).toBe(true)
  expect(pinch.zoom).toBe(1.0)
  return t
}

test('pinch: engancha al contacto y arranca en zoom 1.0', () => {
  engagePinch()
})

test('pinch: puño derecho NO engancha (guard anti-puño)', () => {
  const fist = fingers({ thumb: 'contracted', index: 'contracted', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  let t = 0
  for (let i = 0; i < 6; i++) { pinch.update(fist, feat({ aperture: 0.3 }), t); t += DT }
  expect(pinch.active).toBe(false)
})

test('pinch: abrir sube el zoom, cerrar lo baja (progresivo, sin saltos)', () => {
  let t = engagePinch()
  let prev = pinch.zoom
  for (let i = 1; i <= 10; i++) {
    pinch.update(pinchFingers(), feat({ aperture: 0.35 + i * 0.06 }), t)
    t += DT
    expect(pinch.zoom).toBeGreaterThanOrEqual(prev)
    prev = pinch.zoom
  }
  expect(pinch.zoom).toBeGreaterThan(1.2)
  const peak = pinch.zoom
  for (let i = 1; i <= 10; i++) {
    pinch.update(pinchFingers(), feat({ aperture: 0.95 - i * 0.06 }), t)
    t += DT
  }
  expect(pinch.zoom).toBeLessThan(peak)
})

test('pinch: temblor no mueve el zoom apreciablemente', () => {
  let t = engagePinch()
  // Asentar de verdad antes de medir: EURO_APERTURE es LENTO a propósito
  // (minCutoff bajo mata el temblor del pulgar), así que con pocos frames lo
  // que se mediría es la cola de convergencia, no el flutter.
  for (let i = 0; i < 30; i++) { pinch.update(pinchFingers(), feat({ aperture: 0.6 }), t); t += DT }
  const settled = pinch.zoom
  for (let i = 0; i < 12; i++) {
    pinch.update(pinchFingers(), feat({ aperture: 0.6 + (i % 2 === 0 ? 0.002 : -0.002) }), t)
    t += DT
  }
  // One-Euro filtra el temblor; flutter residual < 1% de zoom (imperceptible).
  expect(Math.abs(pinch.zoom - settled)).toBeLessThan(0.01)
})

test('pinch: misma apertura → mismo zoom (anclado, sin drift al ir y volver)', () => {
  let t = engagePinch()
  const hold = (a: number) => {
    for (let i = 0; i < 15; i++) { pinch.update(pinchFingers(), feat({ aperture: a }), t); t += DT }
    return pinch.zoom
  }
  const first = hold(0.9)
  hold(0.5)
  const second = hold(0.9)
  expect(first).toBeGreaterThan(1.2)
  expect(Math.abs(second - first)).toBeLessThan(0.02)
})

test('pinch: pegajoso — pose rara a mitad no lo suelta, mano abierta sí', () => {
  let t = engagePinch()
  // El medio se extiende un momento (motion blur): sigue enganchado.
  pinch.update(fingers({ thumb: 'half', index: 'half', middle: 'extended', ring: 'contracted', pinky: 'contracted' }), feat({ aperture: 0.7 }), t)
  t += DT
  expect(pinch.active).toBe(true)
  // Mano claramente abierta: suelta.
  pinch.update(fingers({}), feat({ aperture: 0.9 }), t)
  expect(pinch.active).toBe(false)
  expect(pinch.zoom).toBe(1.0)
})

test('pinch: apertura enorme suelta', () => {
  let t = engagePinch()
  pinch.update(pinchFingers(), feat({ aperture: 1.7 }), t)
  expect(pinch.active).toBe(false)
})

test('pinch: mano perdida — gracia congela, luego suelta', () => {
  const t = engagePinch()
  pinch.update(null, null, t + 100)
  expect(pinch.active).toBe(true)
  pinch.update(null, null, t + 400)
  expect(pinch.active).toBe(false)
})

// ---------- PointerTracker ----------

test('pointer: espejo + expansión alrededor del centro', () => {
  const p = new PointerTracker()
  let t = 0
  for (let i = 0; i < 20; i++) { p.update(true, feat({ indexTipImage: { x: 0.3, y: 0.5 } }), t); t += DT }
  expect(p.active).toBe(true)
  // sx = 1-0.3 = 0.7 → expandido: 0.5 + 0.2·1.45 = 0.79
  expect(p.screenX).toBeGreaterThan(0.75)
  expect(p.screenX).toBeLessThan(0.83)
  expect(p.screenY).toBeCloseTo(0.5, 1)
})

test('pointer: clamp a 0..1 en los bordes', () => {
  const p = new PointerTracker()
  let t = 0
  for (let i = 0; i < 25; i++) { p.update(true, feat({ indexTipImage: { x: 0.02, y: 0.98 } }), t); t += DT }
  expect(p.screenX).toBeLessThanOrEqual(1)
  expect(p.screenY).toBeLessThanOrEqual(1)
  expect(p.screenX).toBeGreaterThan(0.9)
})

// ---------- DiscreteTracker ----------

test('discreto: soltar peace_sep tras ≥150ms → click', () => {
  const d = new DiscreteTracker()
  d.update('peace_sep', true, 0)
  d.update('peace_sep', true, 100)
  d.update('peace_sep', true, 200)
  d.update('idle', true, 260)
  expect(d.click).toBe(true)
  expect(d.back).toBe(false)
  d.update('idle', true, 320)
  expect(d.click).toBe(false)  // pulso de un solo ciclo
})

test('discreto: soltar peace_close → back', () => {
  const d = new DiscreteTracker()
  d.update('peace_close', true, 0)
  d.update('peace_close', true, 200)
  d.update('idle', true, 260)
  expect(d.back).toBe(true)
})

test('discreto: hold corto (<150ms) no dispara', () => {
  const d = new DiscreteTracker()
  d.update('peace_sep', true, 0)
  d.update('idle', true, 100)
  expect(d.click).toBe(false)
})

test('discreto: mano perdida durante el hold cancela (tracking ≠ intención)', () => {
  const d = new DiscreteTracker()
  d.update('peace_sep', true, 0)
  d.update('peace_sep', true, 200)
  d.update(null, false, 260)
  expect(d.click).toBe(false)
})

test('discreto: cooldown bloquea el doble disparo', () => {
  const d = new DiscreteTracker()
  d.update('peace_sep', true, 0)
  d.update('peace_sep', true, 200)
  d.update('idle', true, 250)
  expect(d.click).toBe(true)
  // Segundo episodio completo pero dentro de los 400ms del primero.
  d.update('peace_sep', true, 300)
  d.update('peace_sep', true, 500)
  d.update('idle', true, 560)
  expect(d.click).toBe(false)
  // Tercero, ya fuera del cooldown.
  d.update('peace_sep', true, 700)
  d.update('peace_sep', true, 900)
  d.update('idle', true, 960)
  expect(d.click).toBe(true)
})

test('discreto: sep→close cuenta como release del sep', () => {
  const d = new DiscreteTracker()
  d.update('peace_sep', true, 0)
  d.update('peace_sep', true, 200)
  d.update('peace_close', true, 260)
  expect(d.click).toBe(true)
})

// ---------- TapTracker ----------

const TAP_DOWN = 0.30   // pulgar en contacto con el índice
const TAP_UP = 0.95     // apuntando con el pulgar recogido

test('tap: contacto → down; separar → up (semántica de ratón)', () => {
  const tap = new TapTracker()
  tap.update(true, feat({ aperture: TAP_UP }), 0)
  expect(tap.pressed).toBe(false)
  tap.update(true, feat({ aperture: TAP_DOWN }), DT)
  expect(tap.down).toBe(true)
  expect(tap.pressed).toBe(true)
  tap.update(true, feat({ aperture: TAP_DOWN }), DT * 2)
  expect(tap.down).toBe(false)   // `down` es un pulso de un ciclo
  expect(tap.pressed).toBe(true)
  tap.update(true, feat({ aperture: TAP_UP }), DT * 3)
  expect(tap.up).toBe(true)
  expect(tap.pressed).toBe(false)
})

test('tap: histéresis — apertura intermedia NO suelta', () => {
  const tap = new TapTracker()
  tap.update(true, feat({ aperture: TAP_UP }), 0)
  tap.update(true, feat({ aperture: TAP_DOWN }), DT)
  expect(tap.pressed).toBe(true)
  // Entre TAP_ENTER (0.45) y TAP_EXIT (0.62): zona muerta, sigue presionado.
  for (let i = 2; i < 8; i++) tap.update(true, feat({ aperture: 0.52 }), DT * i)
  expect(tap.pressed).toBe(true)
})

test('tap: presión de un parpadeo no cuenta como clic', () => {
  const tap = new TapTracker()
  tap.update(true, feat({ aperture: TAP_UP }), 0)
  tap.update(true, feat({ aperture: TAP_DOWN }), 50)
  expect(tap.pressed).toBe(true)
  tap.update(true, feat({ aperture: TAP_UP }), 80)  // 30 ms < TAP_MIN_PRESS_MS
  expect(tap.up).toBe(false)
  expect(tap.pressed).toBe(false)
})

test('tap: sin la pose de apuntar no dispara (un puño también junta los dedos)', () => {
  const tap = new TapTracker()
  for (let i = 0; i < 5; i++) tap.update(false, feat({ aperture: TAP_DOWN }), DT * i)
  expect(tap.pressed).toBe(false)
  expect(tap.down).toBe(false)
})

test('tap: dropout breve NO suelta el botón a mitad de arrastre', () => {
  const tap = new TapTracker()
  tap.update(true, feat({ aperture: TAP_UP }), 0)
  tap.update(true, feat({ aperture: TAP_DOWN }), DT)
  expect(tap.pressed).toBe(true)
  tap.update(true, null, DT * 2)          // mano perdida, dentro de la gracia
  expect(tap.pressed).toBe(true)
  tap.update(true, null, DT + 400)        // fuera de la gracia
  expect(tap.pressed).toBe(false)
  expect(tap.up).toBe(false)              // soltar por pérdida no es un clic
})

test('tap: cooldown bloquea el rebote inmediato', () => {
  const tap = new TapTracker()
  let t = 0
  tap.update(true, feat({ aperture: TAP_UP }), t); t += DT
  tap.update(true, feat({ aperture: TAP_DOWN }), t); t += DT * 3
  tap.update(true, feat({ aperture: TAP_UP }), t)
  expect(tap.up).toBe(true)
  const upT = t
  // Reintento dentro de TAP_COOLDOWN_MS (220 ms): ignorado.
  tap.update(true, feat({ aperture: TAP_DOWN }), upT + 100)
  expect(tap.down).toBe(false)
  // Pasado el cooldown: vuelve a enganchar.
  tap.update(true, feat({ aperture: TAP_DOWN }), upT + 300)
  expect(tap.down).toBe(true)
})

// ---------- PointerTracker: velocidad y modo fino ----------

test('puntero: publica velocidad con el signo del movimiento en pantalla', () => {
  const pt = new PointerTracker()
  let t = 0
  for (let i = 0; i < 6; i++) { pt.update(true, feat({ indexTipImage: { x: 0.5, y: 0.5 } }), t); t += DT }
  const v0 = pt.vx
  expect(Math.abs(v0)).toBeLessThan(1e-3)
  // Imagen sin espejar: x de imagen BAJA ⇒ pantalla a la DERECHA ⇒ vx > 0.
  for (let i = 0; i < 6; i++) { pt.update(true, feat({ indexTipImage: { x: 0.5 - 0.02 * i, y: 0.5 } }), t); t += DT }
  expect(pt.vx).toBeGreaterThan(0)
})

test('puntero: el modo fino recorta el movimiento anclado al punto de presión', () => {
  const move = (fine: boolean) => {
    const pt = new PointerTracker()
    let t = 0
    for (let i = 0; i < 8; i++) { pt.update(true, feat({ indexTipImage: { x: 0.5, y: 0.5 } }), t, false); t += DT }
    const x0 = pt.screenX
    for (let i = 0; i < 8; i++) { pt.update(true, feat({ indexTipImage: { x: 0.40, y: 0.5 } }), t, fine); t += DT }
    return Math.abs(pt.screenX - x0)
  }
  const normal = move(false)
  const fine = move(true)
  expect(fine).toBeGreaterThan(0)
  expect(fine).toBeLessThan(normal * 0.7)
})

test('puntero: dropout congela la posición y pone la velocidad a cero', () => {
  const pt = new PointerTracker()
  let t = 0
  for (let i = 0; i < 6; i++) { pt.update(true, feat({ indexTipImage: { x: 0.5 - 0.02 * i, y: 0.5 } }), t); t += DT }
  expect(pt.vx).not.toBe(0)
  const frozen = pt.screenX
  pt.update(true, null, t)
  expect(pt.active).toBe(true)
  expect(pt.screenX).toBe(frozen)
  expect(pt.vx).toBe(0)
})
