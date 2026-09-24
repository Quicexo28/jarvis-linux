import { describe, it, expect } from 'vitest'
import { snapToNearestSlot, dragToRingAngle } from '../state/ringSnap'

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
