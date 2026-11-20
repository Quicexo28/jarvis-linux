import { describe, it, expect } from 'vitest'
import {
  snapToNearestSlot, dragToRingAngle, slotWithHysteresis, springFollow, dampFactor,
  type SpringState,
} from '../state/ringSnap'

describe('snapToNearestSlot', () => {
  it('snaps 0.3 to slot 0', () => {
    expect(snapToNearestSlot(0.3, 5)).toBe(0)
  })
  it('snaps 0.7 to slot 1', () => {
    expect(snapToNearestSlot(0.7, 5)).toBe(1)
  })
  it('snaps -0.3 to slot 0 (wraps from end)', () => {
    expect(snapToNearestSlot(-0.3, 5)).toBe(0)
  })
  it('snaps 4.6 to slot 0 (wraps)', () => {
    expect(snapToNearestSlot(4.6, 5)).toBe(0)
  })
  it('snaps 2.4 to slot 2', () => {
    expect(snapToNearestSlot(2.4, 5)).toBe(2)
  })
})

describe('dragToRingAngle', () => {
  const SENS = 4

  it('es ABSOLUTO: la misma posición de mano da siempre el mismo ángulo', () => {
    // Nada de integrar incrementos — volver al mismo sitio devuelve el carrusel
    // al mismo sitio, que es lo que hace que se sienta agarrado.
    expect(dragToRingAngle(2, 0.1, SENS)).toBe(dragToRingAngle(2, 0.1, SENS))
    expect(dragToRingAngle(2, 0, SENS)).toBe(2)
  })

  it('mano a la DERECHA arrastra los hologramas a la derecha (ángulo baja)', () => {
    expect(dragToRingAngle(3, 0.25, SENS)).toBeLessThan(3)
  })

  it('mano a la IZQUIERDA sube el ángulo', () => {
    expect(dragToRingAngle(3, -0.25, SENS)).toBeGreaterThan(3)
  })

  it('un gesto cómodo (un tercio del encuadre) mueve más de un slot', () => {
    expect(Math.abs(dragToRingAngle(0, 0.33, SENS))).toBeGreaterThan(1)
  })

  it('un movimiento LENTO sigue moviendo el anillo (la zona muerta lo anulaba)', () => {
    // 0.005 por muestra: por debajo del deadZone 0.015 que se aplicaba al
    // incremento en la versión vieja, así que el anillo no se movía nunca.
    const a = dragToRingAngle(0, 0.005, SENS)
    expect(a).not.toBe(0)
    expect(Math.abs(a)).toBeGreaterThan(0.01)
  })

  it('el snap al soltar cae en el slot que se estaba viendo', () => {
    const angle = dragToRingAngle(0, -0.26, SENS)   // ≈ 1.04 slots
    expect(snapToNearestSlot(angle, 6)).toBe(1)
  })
})

describe('slotWithHysteresis', () => {
  const N = 6
  const M = 0.12

  it('sin slot previo devuelve el más cercano', () => {
    expect(slotWithHysteresis(1.4, -1, N, M)).toBe(1)
    expect(slotWithHysteresis(1.6, -1, N, M)).toBe(2)
  })

  it('el temblor alrededor de la frontera x.5 NO alterna el slot', () => {
    // Mano quieta en 1.5 ± ruido: con Math.round a secas alternaba 1↔2.
    let slot = 1
    for (const a of [1.49, 1.51, 1.48, 1.53, 1.5, 1.52, 1.47]) {
      slot = slotWithHysteresis(a, slot, N, M)
      expect(slot).toBe(1)
    }
  })

  it('cambia al pasar la frontera por más del margen, y se queda', () => {
    expect(slotWithHysteresis(1.63, 1, N, M)).toBe(2)
    // De vuelta: desde 2 hace falta bajar de 1.38 para volver a 1.
    expect(slotWithHysteresis(1.45, 2, N, M)).toBe(2)
    expect(slotWithHysteresis(1.37, 2, N, M)).toBe(1)
  })

  it('respeta la vuelta del anillo (slot 0 ↔ slot N-1)', () => {
    expect(slotWithHysteresis(-0.55, 0, N, M)).toBe(0)       // ≈ 5.45 → sigue en 0
    expect(slotWithHysteresis(5.45, 0, N, M)).toBe(0)
    expect(slotWithHysteresis(-0.7, 0, N, M)).toBe(5)
    expect(slotWithHysteresis(5.55, 5, N, M)).toBe(5)        // frontera 5↔0, dentro del margen
    expect(slotWithHysteresis(11.55, 5, N, M)).toBe(5)       // una vuelta más
    expect(slotWithHysteresis(5.7, 5, N, M)).toBe(0)
  })

  it('un salto grande (varios slots en una muestra) no se queda pegado', () => {
    expect(slotWithHysteresis(3.1, 1, N, M)).toBe(3)
  })
})

describe('springFollow', () => {
  const OMEGA = 40

  function run(dt: number, ms: number, target: number): SpringState {
    const s: SpringState = { x: 0, v: 0 }
    for (let t = 0; t < ms; t += dt * 1000) springFollow(s, target, OMEGA, dt)
    return s
  }

  it('NO se pasa del objetivo con frames largos (el lerp k·6 viejo sí)', () => {
    // Regresión del temblor: 60 ms por frame es normal con la inferencia en el
    // main thread. El lerp viejo daba factor 6·(1−0.005^0.06) ≈ 1.6 → sobreimpulso.
    const oldFactor = 6 * (1 - Math.pow(0.005, 0.06))
    expect(oldFactor).toBeGreaterThan(1)
    for (const dt of [1 / 60, 0.035, 0.06, 0.1, 0.25]) {
      const s: SpringState = { x: 0, v: 0 }
      let max = 0
      for (let i = 0; i < 200; i++) {
        springFollow(s, 1, OMEGA, dt)
        max = Math.max(max, s.x)
      }
      expect(max).toBeLessThanOrEqual(1 + 1e-9)
      expect(s.x).toBeCloseTo(1, 6)
    }
  })

  it('es independiente del frame rate (integración exacta)', () => {
    const a = run(1 / 60, 100, 1)
    const b = run(1 / 30, 100, 1)
    // Mismo instante (100 ms) con distinto paso → mismo estado.
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.v).toBeCloseTo(b.v, 6)
  })

  it('un objetivo a escalones (~25 Hz) da movimiento sin retrocesos', () => {
    // El pipeline publica a escalones; el anillo debe avanzar siempre hacia
    // delante, sin pararse en seco ni volver atrás entre muestras.
    const s: SpringState = { x: 0, v: 0 }
    let target = 0
    let prev = 0
    for (let frame = 0; frame < 120; frame++) {
      if (frame % 3 === 0) target += 0.1                  // muestra nueva cada ~50 ms
      springFollow(s, target, OMEGA, 1 / 60)
      expect(s.x).toBeGreaterThanOrEqual(prev - 1e-12)
      if (frame > 10) expect(s.v).toBeGreaterThan(0)     // nunca se detiene a mitad
      prev = s.x
    }
  })

  it('retardo en movimiento constante ≈ 2/ω', () => {
    const s: SpringState = { x: 0, v: 0 }
    const v = 2 // rad/s
    const dt = 1 / 120
    let t = 0
    for (let i = 0; i < 240; i++) { t += dt; springFollow(s, v * t, OMEGA, dt) }
    // El objetivo se mantiene durante el paso con el valor de su FINAL, lo que
    // adelanta dt/2: el retardo continuo 2/ω queda en 2/ω − dt/2.
    expect((v * t - s.x) / v).toBeCloseTo(2 / OMEGA - dt / 2, 4)
  })
})

describe('dampFactor', () => {
  it('nunca pasa de 1 aunque el frame sea larguísimo', () => {
    expect(dampFactor(42.5, 0.5)).toBeLessThanOrEqual(1)
    expect(dampFactor(42.5, 5)).toBeLessThanOrEqual(1)
  })
  it('dos frames de 16 ms = uno de 32 ms', () => {
    const one = dampFactor(42.5, 0.032)
    const two = 1 - (1 - dampFactor(42.5, 0.016)) ** 2
    expect(two).toBeCloseTo(one, 10)
  })
  it('a 60 fps iguala el k·6 anterior (≈0.507)', () => {
    expect(dampFactor(42.5, 1 / 60)).toBeCloseTo(6 * (1 - Math.pow(0.005, 1 / 60)), 2)
  })
})
