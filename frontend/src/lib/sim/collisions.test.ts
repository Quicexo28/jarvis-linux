/** Choques entre partículas y rozamiento.
 *
 *  Las dos aserciones que importan son leyes de conservación, no valores
 *  copiados de la salida: el momento SIEMPRE se conserva, y la energía nunca
 *  puede subir. Un solver de colisiones mal escrito falla justo ahí — las
 *  partículas se auto-aceleran y la escena acaba explotando sola.
 */

import { describe, it, expect } from 'vitest'
import { resolveCollisions, DynamicsEngine, buildDynamics } from './dynamics'

type P = { pos: [number, number, number]; vel: [number, number, number] }

function stateOf(ps: P[]): Float64Array {
  const st = new Float64Array(ps.length * 6)
  ps.forEach((p, i) => { st.set(p.pos, i * 6); st.set(p.vel, i * 6 + 3) })
  return st
}
const momentum = (st: Float64Array, m: Float64Array) => {
  const p = [0, 0, 0]
  for (let i = 0; i < m.length; i++) for (let k = 0; k < 3; k++) p[k] += m[i] * st[i * 6 + 3 + k]
  return p
}
const kinetic = (st: Float64Array, m: Float64Array) => {
  let e = 0
  for (let i = 0; i < m.length; i++) {
    e += 0.5 * m[i] * (st[i * 6 + 3] ** 2 + st[i * 6 + 4] ** 2 + st[i * 6 + 5] ** 2)
  }
  return e
}

describe('impulso de colisión', () => {
  it('choque frontal elástico de masas iguales: intercambian velocidades', () => {
    // El resultado de libro, y el más fácil de estropear con un signo.
    const st = stateOf([
      { pos: [-0.1, 0, 0], vel: [1, 0, 0] },
      { pos: [0.1, 0, 0], vel: [-1, 0, 0] },
    ])
    const m = Float64Array.from([1, 1])
    expect(resolveCollisions(st, m, [0.12, 0.12], [false, false], 1)).toBe(1)
    expect(st[3]).toBeCloseTo(-1, 10)
    expect(st[9]).toBeCloseTo(1, 10)
  })

  it('conserva el momento con masas distintas y choque oblicuo', () => {
    const st = stateOf([
      { pos: [-0.1, -0.05, 0], vel: [2, 0.5, -0.3] },
      { pos: [0.08, 0.04, 0.02], vel: [-1, 0.2, 0.7] },
    ])
    const m = Float64Array.from([3, 1])
    const p0 = momentum(st, m)
    resolveCollisions(st, m, [0.12, 0.09], [false, false], 0.6)
    momentum(st, m).forEach((v, k) => expect(v).toBeCloseTo(p0[k], 10))
  })

  it('restitución 1 conserva la energía; menor que 1 la baja, nunca la sube', () => {
    const make = () => stateOf([
      { pos: [-0.1, 0, 0], vel: [1.5, 0.3, 0] },
      { pos: [0.1, 0.02, 0], vel: [-0.7, 0, 0.2] },
    ])
    const m = Float64Array.from([2, 1])
    const elastic = make()
    const e0 = kinetic(elastic, m)
    resolveCollisions(elastic, m, [0.12, 0.12], [false, false], 1)
    expect(kinetic(elastic, m)).toBeCloseTo(e0, 10)

    for (const e of [0.9, 0.5, 0]) {
      const st = make()
      resolveCollisions(st, m, [0.12, 0.12], [false, false], e)
      expect(kinetic(st, m)).toBeLessThan(e0)
    }
  })

  it('separa el solape: tras resolver, las esferas se tocan pero no se encajan', () => {
    const st = stateOf([
      { pos: [0, 0, 0], vel: [1, 0, 0] },
      { pos: [0.05, 0, 0], vel: [-1, 0, 0] },
    ])
    const m = Float64Array.from([1, 1])
    resolveCollisions(st, m, [0.1, 0.1], [false, false], 1)
    expect(Math.hypot(st[6] - st[0], st[7] - st[1], st[8] - st[2])).toBeCloseTo(0.2, 9)
  })

  it('ignora un par que YA se está separando', () => {
    // Solapadas pero alejándose: volver a impulsarlas las pegaría, y el par
    // entraría en un zumbido contra el paso del integrador.
    const st = stateOf([
      { pos: [-0.05, 0, 0], vel: [-1, 0, 0] },
      { pos: [0.05, 0, 0], vel: [1, 0, 0] },
    ])
    const m = Float64Array.from([1, 1])
    expect(resolveCollisions(st, m, [0.1, 0.1], [false, false], 1)).toBe(0)
    expect(st[3]).toBeCloseTo(-1, 12)
  })

  it('una partícula fija tiene masa infinita: empuja y no es empujada', () => {
    const st = stateOf([
      { pos: [0, 0, 0], vel: [0, 0, 0] },
      { pos: [0.15, 0, 0], vel: [-2, 0, 0] },
    ])
    const m = Float64Array.from([1, 1])
    resolveCollisions(st, m, [0.1, 0.1], [true, false], 1)
    expect(st[3]).toBe(0)                    // la fija no se mueve
    expect(st[9]).toBeCloseTo(2, 10)         // la otra rebota entera
  })

  it('sin contacto no toca nada', () => {
    const st = stateOf([
      { pos: [-1, 0, 0], vel: [1, 0, 0] },
      { pos: [1, 0, 0], vel: [-1, 0, 0] },
    ])
    const before = Array.from(st)
    expect(resolveCollisions(st, Float64Array.from([1, 1]), [0.1, 0.1], [false, false], 1)).toBe(0)
    expect(Array.from(st)).toEqual(before)
  })

  it('el preset `collision` ya no es una caja de fantasmas', () => {
    const build = buildDynamics({ system: 'dynamics', preset: 'collision' })
    expect(build.spec.collisions).toBe(true)
    const eng = new DynamicsEngine(build)
    // Con colisiones activas ninguna pareja acaba dentro de otra.
    for (let i = 0; i < 600; i++) eng.step()
    const p = eng.frame().positions
    const n = eng.bodyCount
    let worst = Infinity
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2])
        const touch = (eng.radii[i] + eng.radii[j]) * build.viewScale
        worst = Math.min(worst, d / touch)
      }
    }
    // Se tolera un solape residual pequeño: el contacto es por proyección y se
    // resuelve DESPUÉS del paso, así que un par rapidísimo puede quedar algo
    // encajado durante un frame. Atravesarse de lado a lado, no.
    expect(worst).toBeGreaterThan(0.75)
  })
})

describe('rozamiento de Coulomb en el suelo', () => {
  /** Distancia recorrida, no velocidad final: con μ ≥ 0.3 la partícula acaba
   *  PARADA en los dos casos, así que la velocidad final no distingue un
   *  rozamiento fuerte de uno flojo. Lo que sí los separa es lo lejos que
   *  llegó antes de pararse, que además es la magnitud que se ve en pantalla. */
  const distance = (friction: number) => {
    const eng = new DynamicsEngine(buildDynamics({
      system: 'dynamics',
      particles: [{ position: [0, 0, 0.1], velocity: [3, 0, 0], mass: 1, radius: 0.1 }],
      gravity: 9.81, floor: 0, restitution: 0.4, friction,
    }))
    for (let i = 0; i < 2000; i++) eng.step()
    return eng.frame().positions[0] / eng.build.viewScale
  }

  it('acorta el recorrido, y más μ lo acorta más', () => {
    const libre = distance(0)
    const poco = distance(0.3)
    const mucho = distance(1.2)
    expect(poco).toBeLessThan(libre)
    expect(mucho).toBeLessThan(poco)
    expect(mucho).toBeGreaterThan(0)      // avanza algo: rozamiento, no un muro
  })

  it('nunca invierte el movimiento (el impulso está acotado por μ·|vn|)', () => {
    // Restar μ·|vn| a secas haría que una partícula casi parada saliera
    // disparada hacia atrás — energía de la nada.
    const eng = new DynamicsEngine(buildDynamics({
      system: 'dynamics',
      particles: [{ position: [0, 0, 0.1], velocity: [0.05, 0, -2], mass: 1, radius: 0.1 }],
      gravity: 9.81, floor: 0, restitution: 0.2, friction: 5,
    }))
    eng.step()
    const v = eng.frame().velocities!
    expect(v[0]).toBeGreaterThanOrEqual(0)
    expect(v[0]).toBeLessThanOrEqual(0.05 + 1e-9)
  })
})
