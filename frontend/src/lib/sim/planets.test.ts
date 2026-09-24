import { describe, it, expect } from 'vitest'
import {
  AU_KM, PLANET_PHYSICAL, normalizeBodyName, physicalOf, spinAxis,
  oblateBodies, collisionRadii,
} from './planets'
import type { SimBody } from './types'

const body = (name: string, tilt?: number): SimBody =>
  ({ name, mass: 1, position: [0, 0, 0], tilt })

describe('tabla física', () => {
  it('los radios casan con los valores publicados', () => {
    expect(PLANET_PHYSICAL.tierra.radiusKm).toBeCloseTo(6378.137, 3)
    expect(PLANET_PHYSICAL.jupiter.radiusKm).toBe(71492)
    // La Tierra en AU: 4.26e-5. Es el número que hace que los planetas NO
    // choquen — el radio de dibujo es ~1e3 veces mayor.
    expect(PLANET_PHYSICAL.tierra.radiusKm / AU_KM).toBeCloseTo(4.2635e-5, 8)
  })

  it('el achatamiento de Júpiter domina por J2·R², no por J2 a secas', () => {
    // J2 de Júpiter es solo ~13.6 veces el de la Tierra. Lo que hace que su
    // achatamiento mande es que el término de la aceleración va con J2·R² y su
    // radio es 11 veces mayor: el producto sale ~1600 veces el terrestre.
    const j2r = PLANET_PHYSICAL.jupiter.j2 / PLANET_PHYSICAL.tierra.j2
    expect(j2r).toBeGreaterThan(13)
    expect(j2r).toBeLessThan(14.5)
    const strength = (p: { j2: number; radiusKm: number }) => p.j2 * p.radiusKm ** 2
    const ratio = strength(PLANET_PHYSICAL.jupiter) / strength(PLANET_PHYSICAL.tierra)
    expect(ratio).toBeGreaterThan(1000)
  })

  it('normaliza tildes, mayúsculas e inglés', () => {
    expect(normalizeBodyName('Júpiter')).toBe('jupiter')
    expect(normalizeBodyName('  TIERRA ')).toBe('tierra')
    expect(normalizeBodyName('Earth')).toBe('tierra')
    expect(normalizeBodyName('Ganymede')).toBe('ganimedes')
    expect(physicalOf('Earth')).toBe(PLANET_PHYSICAL.tierra)
    expect(physicalOf('Plutón')).toBeUndefined()
    expect(physicalOf(undefined)).toBeUndefined()
  })
})

describe('eje de giro', () => {
  it('sin inclinación apunta al norte y siempre es unitario', () => {
    expect(spinAxis(0)).toEqual([0, -0, 1])
    for (const t of [0, 23.44, 97.77, 177.36]) {
      const [x, y, z] = spinAxis(t)
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12)
    }
  })

  it('Urano va casi tumbado y Venus casi boca abajo', () => {
    expect(spinAxis(97.77)[2]).toBeLessThan(0)      // pasado el ecuador
    expect(Math.abs(spinAxis(97.77)[2])).toBeLessThan(0.2)
    expect(spinAxis(177.36)[2]).toBeCloseTo(-0.999, 2)
  })
})

describe('selección de cuerpos achatados', () => {
  it('descarta el Sol y conserva los que sí están achatados', () => {
    // Io entra: su J2 es 1.8e-3, porque la marea de Júpiter la deforma de
    // verdad. El Sol no: 2.2e-7 es cinco órdenes por debajo y su efecto queda
    // bajo el redondeo del paso.
    const list = oblateBodies([body('Sol'), body('Júpiter', 3.13), body('Io')])
    expect(list.map((o) => o.index)).toEqual([1, 2])
    expect(list[0].j2).toBeCloseTo(0.014736, 6)
    expect(list[0].radius).toBeCloseTo(71492 / AU_KM, 12)
  })

  it('el umbral es ajustable', () => {
    expect(oblateBodies([body('Sol')], 0).length).toBe(1)
    expect(oblateBodies([body('Sol')]).length).toBe(0)
  })

  it('ignora nombres desconocidos en vez de reventar', () => {
    expect(oblateBodies([body('Nibiru'), body('m1')])).toEqual([])
  })

  it('el eje del cuerpo achatado sale de SU inclinación', () => {
    const [o] = oblateBodies([body('Tierra', 23.44)], 1e-6)
    expect(o.axis[2]).toBeCloseTo(Math.cos(23.44 * Math.PI / 180), 12)
  })
})

describe('radios de colisión', () => {
  it('usa el radio FÍSICO, no el de dibujo', () => {
    const b: SimBody = { name: 'Tierra', mass: 1, position: [0, 0, 0], radius: 0.1 }
    const r = collisionRadii([b])!
    expect(r[0]).toBeCloseTo(6378.137 / AU_KM, 12)
    expect(r[0]).toBeLessThan(b.radius! / 1000)   // mil veces menor que el dibujo
  })

  it('sin ningún cuerpo tabulado devuelve undefined (mejor no colisionar)', () => {
    expect(collisionRadii([body('m1'), body('m2')])).toBeUndefined()
  })

  it('un cuerpo desconocido en la lista queda con radio 0 y no choca', () => {
    const r = collisionRadii([body('Tierra'), body('m2')])!
    expect(r[0]).toBeGreaterThan(0)
    expect(r[1]).toBe(0)
  })
})
