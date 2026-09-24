/** Tests de las correcciones que separan "gravedad de libro de texto" de
 *  "gravedad que se mide en el cielo".
 *
 *  Regla del archivo: cada aserción se compara contra una VERDAD INDEPENDIENTE
 *  — la forma cerrada de la teoría o el número observado —, nunca contra la
 *  salida de la propia función. Un test que compara el código consigo mismo
 *  pasa igual de verde cuando la física está mal.
 */

import { describe, it, expect } from 'vitest'
import {
  gravityAccel, relativisticAccel, oblatenessAccel,
  perihelionAdvance, nodalPrecessionRate, totalEnergy,
  C_AU_DAY, NBodyEngine, type NBodyBuild, type OblateBody,
} from './nbody'
import { GM_SUN, G_AU } from './kepler'
import { buildNBody } from './presets'

const ARCSEC_PER_RAD = 206264.806

/** Leapfrog (velocity-Verlet) mínimo: el test integra por su cuenta para medir
 *  la FUNCIÓN de fuerza, no el cableado del motor. */
function integrate(
  pos: Float64Array, vel: Float64Array, mass: Float64Array,
  dt: number, steps: number,
  accel: (p: Float64Array, v: Float64Array, out: Float64Array) => void,
): void {
  const n = mass.length * 3
  const a = new Float64Array(n)
  const aNext = new Float64Array(n)
  accel(pos, vel, a)
  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < n; k++) pos[k] += vel[k] * dt + 0.5 * a[k] * dt * dt
    accel(pos, vel, aNext)
    for (let k = 0; k < n; k++) vel[k] += 0.5 * (a[k] + aNext[k]) * dt
    a.set(aNext)
  }
}

/** Dirección del perihelio vía el vector de Laplace-Runge-Lenz:
 *  e⃗ = (v⃗ × L⃗)/GM − r̂. En Newton puro es una constante del movimiento; que
 *  GIRE es exactamente lo que significa "precesión". */
function perihelionAngle(r: number[], v: number[], GM: number): number {
  const L = [
    r[1] * v[2] - r[2] * v[1],
    r[2] * v[0] - r[0] * v[2],
    r[0] * v[1] - r[1] * v[0],
  ]
  const vxL = [
    v[1] * L[2] - v[2] * L[1],
    v[2] * L[0] - v[0] * L[2],
    v[0] * L[1] - v[1] * L[0],
  ]
  const rm = Math.hypot(r[0], r[1], r[2])
  const ex = vxL[0] / GM - r[0] / rm
  const ey = vxL[1] / GM - r[1] / rm
  return Math.atan2(ey, ex)
}

describe('precesión relativista del perihelio (1PN)', () => {
  // Mercurio, elementos reales.
  const a = 0.38709893, e = 0.20563069
  const periodDays = 87.9691

  it('la forma cerrada da los 43 segundos de arco por siglo de Mercurio', () => {
    const perOrbit = perihelionAdvance(GM_SUN, a, e)
    const orbitsPerCentury = 36525 / periodDays
    const arcsec = perOrbit * orbitsPerCentury * ARCSEC_PER_RAD
    // El valor medido es 42.98"/siglo. Es LA comprobación del término: si el
    // factor 6π, la c² o las unidades están mal, este número se va por órdenes.
    expect(arcsec).toBeGreaterThan(42.5)
    expect(arcsec).toBeLessThan(43.5)
  })

  it('la órbita integrada precesa lo que predice la forma cerrada', () => {
    const mass = Float64Array.from([1, 1e-7])       // Sol + masa de prueba
    const GM = G_AU * (mass[0] + mass[1])
    // Arranque en el perihelio, sobre el eje x.
    const rp = a * (1 - e)
    const vp = Math.sqrt(GM * (1 + e) / (a * (1 - e)))
    const orbits = 40
    const dt = 0.02
    const steps = Math.round((orbits * periodDays) / dt)

    const run = (relativistic: boolean) => {
      const pos = Float64Array.from([0, 0, 0, rp, 0, 0])
      const vel = Float64Array.from([0, 0, 0, 0, vp, 0])
      const acc = (p: Float64Array, v: Float64Array, out: Float64Array) => {
        gravityAccel(p, mass, out, G_AU)
        if (relativistic) relativisticAccel(p, v, mass, out, G_AU, 0, C_AU_DAY)
      }
      integrate(pos, vel, mass, dt, steps, acc)
      const r = [pos[3] - pos[0], pos[4] - pos[1], pos[5] - pos[2]]
      const v = [vel[3] - vel[0], vel[4] - vel[1], vel[5] - vel[2]]
      return perihelionAngle(r, v, GM)
    }

    // Se restan las dos corridas: el error de truncamiento del integrador es
    // idéntico en ambas, así que la diferencia AÍSLA el efecto relativista.
    // Medir la corrida relativista contra cero mezclaría las dos cosas.
    let drift = run(true) - run(false)
    while (drift > Math.PI) drift -= 2 * Math.PI
    while (drift < -Math.PI) drift += 2 * Math.PI

    const expected = perihelionAdvance(GM, a, e) * orbits
    expect(drift).toBeGreaterThan(0)                       // avanza, no retrocede
    expect(drift).toBeCloseTo(expected, 6)
    expect(Math.abs(drift / expected - 1)).toBeLessThan(0.05)
  })

  it('el error del integrador NO es secular (por eso la medida se hace restando)', () => {
    // Medido aquí: a dt = 0.02 d el Verlet mueve el perihelio newtoniano unos
    // 1.5e-4 rad, o sea SIETE VECES la señal relativista de 40 órbitas (2e-5).
    // Es la razón de que el test de arriba reste dos corridas en vez de medir
    // la relativista contra cero: ese ruido es idéntico en ambas y se cancela.
    // Lo que sí se puede afirmar de Newton es que su desvío está ACOTADO —
    // el Verlet es simpléctico —, mientras que la precesión real CRECE con el
    // número de vueltas. Se comprueba justo eso: al doblar las órbitas, un
    // efecto físico doblaría; el ruido no.
    const mass = Float64Array.from([1, 1e-7])
    const GM = G_AU * (mass[0] + mass[1])
    const rp = a * (1 - e)
    const vp = Math.sqrt(GM * (1 + e) / (a * (1 - e)))
    const wobble = (orbits: number) => {
      const pos = Float64Array.from([0, 0, 0, rp, 0, 0])
      const vel = Float64Array.from([0, 0, 0, 0, vp, 0])
      integrate(pos, vel, mass, 0.02, Math.round(orbits * periodDays / 0.02),
        (p, _v, out) => gravityAccel(p, mass, out, G_AU))
      const r = [pos[3] - pos[0], pos[4] - pos[1], pos[5] - pos[2]]
      const v = [vel[3] - vel[0], vel[4] - vel[1], vel[5] - vel[2]]
      return Math.abs(perihelionAngle(r, v, GM))
    }
    const w40 = wobble(40)
    const w80 = wobble(80)
    expect(w40).toBeLessThan(1e-3)                        // acotado, no diverge
    expect(w80).toBeLessThan(2.5 * w40)                   // no crece como un efecto real
  })

  it('la corrección es diminuta comparada con Newton (es 1PN, no una fuerza nueva)', () => {
    const mass = Float64Array.from([1, 1e-7])
    const pos = Float64Array.from([0, 0, 0, 0.387, 0, 0])
    const vel = Float64Array.from([0, 0, 0, 0, 0.0299, 0])
    const newton = new Float64Array(6)
    gravityAccel(pos, mass, newton, G_AU)
    const rel = new Float64Array(6)
    relativisticAccel(pos, vel, mass, rel, G_AU, 0, C_AU_DAY)
    const ratio = Math.hypot(rel[3], rel[4], rel[5]) / Math.hypot(newton[3], newton[4], newton[5])
    expect(ratio).toBeGreaterThan(1e-9)
    expect(ratio).toBeLessThan(1e-6)
  })
})

describe('achatamiento (J2)', () => {
  it('la regresión nodal integrada casa con la fórmula secular', () => {
    // Unidades de juguete con J2 exagerado: el efecto real de la Tierra
    // (J2 = 1.08e-3) tardaría millones de pasos en verse.
    const G = 1, M = 1, R = 0.1, j2 = 0.01
    const aOrb = 1, incl = Math.PI / 6
    const mass = Float64Array.from([M, 1e-9])
    const n = Math.sqrt(G * M / (aOrb ** 3))
    const v = Math.sqrt(G * M / aOrb)
    const pos = Float64Array.from([0, 0, 0, aOrb, 0, 0])
    const vel = Float64Array.from([0, 0, 0, 0, v * Math.cos(incl), v * Math.sin(incl)])
    const oblate: OblateBody[] = [{ index: 0, j2, radius: R, axis: [0, 0, 1] }]

    const node = () => {
      const r = [pos[3], pos[4], pos[5]], vv = [vel[3], vel[4], vel[5]]
      const L = [
        r[1] * vv[2] - r[2] * vv[1],
        r[2] * vv[0] - r[0] * vv[2],
        r[0] * vv[1] - r[1] * vv[0],
      ]
      // n⃗ = ẑ × L⃗ apunta al nodo ascendente.
      return Math.atan2(L[0], -L[1])
    }
    const start = node()
    const T = 100
    integrate(pos, vel, mass, 0.002, T / 0.002, (p, _vv, out) => {
      gravityAccel(p, mass, out, G)
      oblatenessAccel(p, mass, out, G, oblate)
    })
    let delta = node() - start
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI

    const expected = nodalPrecessionRate(n, j2, R, aOrb, 0, incl) * T
    expect(expected).toBeLessThan(0)                      // el nodo REGRESA
    expect(Math.abs(delta / expected - 1)).toBeLessThan(0.1)
  })

  it('sobre el ecuador empuja hacia dentro y sobre el polo hacia fuera', () => {
    // El bulto ecuatorial atrae DE MÁS en el plano del ecuador y DE MENOS
    // sobre el eje: es el signo que hace que el nodo regrese en vez de avanzar.
    const mass = Float64Array.from([1, 0])
    const oblate: OblateBody[] = [{ index: 0, j2: 0.01, radius: 0.1, axis: [0, 0, 1] }]
    const eq = new Float64Array(6)
    oblatenessAccel(Float64Array.from([0, 0, 0, 1, 0, 0]), mass, eq, 1, oblate)
    expect(eq[3]).toBeLessThan(0)                         // hacia el cuerpo

    const pole = new Float64Array(6)
    oblatenessAccel(Float64Array.from([0, 0, 0, 0, 0, 1]), mass, pole, 1, oblate)
    expect(pole[5]).toBeGreaterThan(0)                    // alejándose
  })

  it('el eje inclinado cambia la dirección de la fuerza', () => {
    const mass = Float64Array.from([1, 0])
    const p = Float64Array.from([0, 0, 0, 1, 0, 0])
    const recto = new Float64Array(6)
    oblatenessAccel(p, mass, recto, 1, [{ index: 0, j2: 0.01, radius: 0.1, axis: [0, 0, 1] }])
    const tumbado = new Float64Array(6)
    oblatenessAccel(p, mass, tumbado, 1, [{ index: 0, j2: 0.01, radius: 0.1, axis: [1, 0, 0] }])
    // Con el eje tumbado hacia el cuerpo de prueba, ese cuerpo pasa de estar
    // en el ecuador a estar sobre el polo: la fuerza cambia de signo.
    expect(Math.sign(recto[3])).not.toBe(Math.sign(tumbado[3]))
  })

  it('J2 = 0 no aporta nada', () => {
    const mass = Float64Array.from([1, 0])
    const out = new Float64Array(6)
    oblatenessAccel(Float64Array.from([0, 0, 0, 1, 0, 0]), mass, out, 1,
      [{ index: 0, j2: 0, radius: 0.1, axis: [0, 0, 1] }])
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe('colisiones con fusión', () => {
  function build(over: Partial<NBodyBuild> = {}): NBodyBuild {
    return {
      bodies: [
        { name: 'A', mass: 2, position: [0, 0, 0], velocity: [0, 0, 0], radius: 0.2 },
        { name: 'B', mass: 1, position: [0.5, 0, 0], velocity: [-0.4, 0, 0], radius: 0.1 },
      ],
      G: 1, mode: 'nbody', softening: 0.01, startDate: new Date('2026-01-01'),
      viewScale: 1, radial: 'linear', radialK: 0.1,
      dt: 0.005, timeScale: 1, trail: 0, showOrbits: false,
      collisionRadii: Float64Array.from([0.1, 0.05]),
      ...over,
    } as NBodyBuild
  }

  it('conserva masa y momento al fusionar', () => {
    const eng = new NBodyEngine(build())
    const massTotal = eng.masses[0] + eng.masses[1]
    for (let i = 0; i < 400; i++) eng.step()
    expect(eng.masses[0] + eng.masses[1]).toBeCloseTo(massTotal, 12)
    // Uno de los dos absorbió al otro.
    expect(Math.max(eng.masses[0], eng.masses[1])).toBeCloseTo(massTotal, 12)
    expect(Math.min(eng.masses[0], eng.masses[1])).toBe(0)
  })

  it('la energía sigue siendo un número después de fusionar', () => {
    // Un cuerpo muerto queda aparcado DENTRO del absorbente (r = 0): sin la
    // máscara de vivos, el término G·m·m/r del potencial da 0/0 = NaN y la
    // deriva del HUD queda ilegible para el resto de la sesión.
    const eng = new NBodyEngine(build())
    for (let i = 0; i < 400; i++) eng.step()
    const rows = eng.frame().readout ?? []
    const drift = rows.find(([k]) => k.startsWith('Deriva'))?.[1] ?? ''
    expect(drift).not.toContain('NaN')
    expect(rows.some(([k]) => k === 'Fusiones')).toBe(true)
  })

  it('reset deshace la fusión', () => {
    const eng = new NBodyEngine(build())
    for (let i = 0; i < 400; i++) eng.step()
    expect(Math.min(eng.masses[0], eng.masses[1])).toBe(0)
    eng.reset()
    expect(eng.masses[0]).toBeCloseTo(2, 12)
    expect(eng.masses[1]).toBeCloseTo(1, 12)
    expect(eng.frame().readout?.some(([k]) => k === 'Fusiones')).toBe(false)
  })

  it('sin collisionRadii no hay colisiones (los planetas no chocan)', () => {
    const eng = new NBodyEngine(build({ collisionRadii: undefined }))
    for (let i = 0; i < 400; i++) eng.step()
    expect(eng.masses[0]).toBeCloseTo(2, 12)
    expect(eng.masses[1]).toBeCloseTo(1, 12)
  })
})

describe('máscara de vivos', () => {
  it('un cuerpo muerto no ejerce ni recibe gravedad', () => {
    const mass = Float64Array.from([1, 1, 1])
    const pos = Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0])
    const todos = new Float64Array(9)
    gravityAccel(pos, mass, todos, 1)
    const sinTercero = new Float64Array(9)
    gravityAccel(pos, mass, sinTercero, 1, 0, Uint8Array.from([1, 1, 0]))
    expect(sinTercero[6]).toBe(0)
    expect(sinTercero[0]).not.toBeCloseTo(todos[0], 6)
  })

  it('la energía ignora a los muertos', () => {
    const mass = Float64Array.from([1, 1, 0])
    const pos = Float64Array.from([0, 0, 0, 1, 0, 0, 1, 0, 0])
    const vel = new Float64Array(9)
    const e = totalEnergy(pos, vel, mass, 1, 0, Uint8Array.from([1, 1, 0]))
    expect(Number.isFinite(e)).toBe(true)
    expect(e).toBeCloseTo(-1, 12)
  })
})

describe('dónde se encienden las correcciones', () => {
  it('los presets en unidades solares reales las traen puestas', () => {
    // `lagrange` entra aquí aunque parezca una figura abstracta: usa la masa y
    // el semieje REALES de Júpiter con G_AU, así que sus unidades son AU/día.
    for (const preset of ['solar', 'inner', 'outer', 'earth-moon', 'jupiter-moons', 'lagrange'] as const) {
      const b = buildNBody({ system: 'nbody', preset, mode: 'nbody' })
      expect(b.relativistic, preset).toBe(true)
    }
  })

  it('las coreografías en unidades abstractas NO', () => {
    // Regresión: activarlas por defecto en `figure8` rompía la cerrazón de la
    // órbita en ocho, que es una solución EXACTA de la gravedad newtoniana.
    // La c del término 1PN está en AU/día y ahí las unidades son arbitrarias.
    // `figure8` es el único preset en unidades puramente abstractas (G = 1).
    // `binary` y `lagrange` PARECEN figuras de juguete y no lo son: usan G_AU.
    const b = buildNBody({ system: 'nbody', preset: 'figure8' })
    expect(b.relativistic).toBe(false)
    expect(b.oblate).toBeUndefined()
  })

  it('el modo kepler nunca las usa (no integra fuerzas)', () => {
    const b = buildNBody({ system: 'nbody', preset: 'solar', mode: 'kepler', relativistic: true })
    expect(b.relativistic).toBe(false)
  })

  it('una orden explícita manda sobre el default', () => {
    expect(buildNBody({ system: 'nbody', preset: 'solar', relativistic: false }).relativistic).toBe(false)
    expect(buildNBody({ system: 'nbody', preset: 'figure8', relativistic: true }).relativistic).toBe(true)
  })

  it('Júpiter llega achatado y el Sol no', () => {
    const b = buildNBody({ system: 'nbody', preset: 'jupiter-moons', mode: 'nbody' })
    const names = (b.oblate ?? []).map((o) => b.bodies[o.index].name)
    expect(names).toContain('Júpiter')
    expect(names).not.toContain('Sol')
  })

  it('las colisiones están APAGADAS salvo que se pidan', () => {
    expect(buildNBody({ system: 'nbody', preset: 'solar' }).collisionRadii).toBeUndefined()
    // `mode: 'nbody'` explícito: los subconjuntos solares propagan por Kepler
    // por defecto, y ahí no hay fuerzas que evaluar ni, por tanto, choques.
    const on = buildNBody({ system: 'nbody', preset: 'inner', mode: 'nbody', collisions: true })
    expect(on.collisionRadii).toBeDefined()
    // Radios FÍSICOS, no de dibujo. El mayor es el del SOL (696 000 km =
    // 0.00465 AU); la Tierra mide 4.26e-5 AU, mil veces menos que el 0.1 con
    // el que se la pinta. Ese abismo es justo lo que impide que los planetas
    // choquen entre sí al pasar cerca en pantalla.
    const r = Array.from(on.collisionRadii!)
    expect(Math.max(...r)).toBeCloseTo(696000 / 149597870.7, 9)
    const tierra = on.bodies.findIndex((b) => b.name === 'Tierra')
    expect(r[tierra]).toBeCloseTo(6378.137 / 149597870.7, 12)
  })
})
