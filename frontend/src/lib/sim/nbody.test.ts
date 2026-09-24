import { describe, it, expect } from 'vitest'
import {
  gravityAccel, totalEnergy, totalMomentum, angularMomentum, barycenter,
  zeroMomentum, mapRadial, NBodyEngine,
} from './nbody'
import { buildNBody, buildPreset, displayRadius } from './presets'
import { G_AU, period } from './kepler'

const f64 = (a: number[]) => Float64Array.from(a)

describe('gravityAccel', () => {
  it('pulls two bodies toward each other with equal and opposite forces', () => {
    const pos = f64([0, 0, 0, 1, 0, 0])
    const mass = f64([2, 3])
    const acc = new Float64Array(6)
    gravityAccel(pos, mass, acc, 1)
    expect(acc[0]).toBeCloseTo(3, 12)   // a₁ = G·m₂/r² toward +x
    expect(acc[3]).toBeCloseTo(-2, 12)  // a₂ = G·m₁/r² toward −x
    // Momentum-conserving: m₁a₁ + m₂a₂ = 0.
    expect(mass[0] * acc[0] + mass[1] * acc[3]).toBeCloseTo(0, 12)
  })

  it('falls off as 1/r²', () => {
    const acc = new Float64Array(6)
    gravityAccel(f64([0, 0, 0, 2, 0, 0]), f64([1, 1]), acc, 1)
    expect(acc[0]).toBeCloseTo(0.25, 12)
  })

  it('softening bounds the acceleration at contact instead of diverging', () => {
    const acc = new Float64Array(6)
    gravityAccel(f64([0, 0, 0, 1e-9, 0, 0]), f64([1, 1]), acc, 1, 0.1)
    expect(Number.isFinite(acc[0])).toBe(true)
    expect(Math.abs(acc[0])).toBeLessThan(1e-6)
  })
})

describe('diagnostics', () => {
  it('computes the barycenter of a lopsided pair', () => {
    expect(barycenter(f64([0, 0, 0, 3, 0, 0]), f64([2, 1]))[0]).toBeCloseTo(1, 12)
  })

  it('zeroMomentum removes the net drift', () => {
    const vel = f64([1, 0, 0, 1, 0, 0])
    const mass = f64([1, 3])
    zeroMomentum(vel, mass)
    expect(totalMomentum(vel, mass)[0]).toBeCloseTo(0, 12)
  })

  it('a circular orbit has negative total energy', () => {
    const a = 1, GM = G_AU
    const v = Math.sqrt(GM / a)
    const e = totalEnergy(f64([0, 0, 0, a, 0, 0]), f64([0, 0, 0, 0, v, 0]), f64([1, 1e-12]), G_AU)
    expect(e).toBeLessThan(0)
  })

  it('angular momentum of a planar orbit points along z', () => {
    const L = angularMomentum(f64([1, 0, 0]), f64([0, 1, 0]), f64([1]))
    expect(L[0]).toBeCloseTo(0, 12)
    expect(L[1]).toBeCloseTo(0, 12)
    expect(L[2]).toBeCloseTo(1, 12)
  })
})

describe('mapRadial', () => {
  it('linear is the identity', () => {
    expect(mapRadial(1, 2, 3, 'linear')).toEqual([1, 2, 3])
  })

  it('log keeps direction and ordering while compressing magnitude', () => {
    const near = mapRadial(1, 0, 0, 'log', 0.6)
    const far = mapRadial(30, 0, 0, 'log', 0.6)
    expect(near[1]).toBe(0)
    expect(near[0]).toBeGreaterThan(0)
    expect(far[0]).toBeGreaterThan(near[0])
    expect(far[0] / near[0]).toBeLessThan(30)     // compressed
    const diag = mapRadial(3, 4, 0, 'log', 1)
    expect(diag[0] / diag[1]).toBeCloseTo(3 / 4, 12) // direction preserved
  })
})

describe('displayRadius', () => {
  it('orders Sun > Jupiter > Earth > Mercury while compressing the ratio', () => {
    const sun = displayRadius(696340), jup = displayRadius(69911)
    const earth = displayRadius(6371), mer = displayRadius(2439.7)
    expect(sun).toBeGreaterThan(jup)
    expect(jup).toBeGreaterThan(earth)
    expect(earth).toBeGreaterThan(mer)
    expect(sun / earth).toBeLessThan(20) // real ratio is 109
  })
})

describe('NBodyEngine — Verlet', () => {
  it('keeps energy bounded (no secular drift) over many orbits', () => {
    const engine = new NBodyEngine(buildNBody({ system: 'nbody', preset: 'binary' }))
    const build = buildNBody({ system: 'nbody', preset: 'binary' })
    const e0 = totalEnergy(
      Float64Array.from(build.bodies.flatMap((b) => b.position)),
      Float64Array.from(build.bodies.flatMap((b) => b.velocity!)),
      Float64Array.from(build.bodies.map((b) => b.mass)), build.G, build.softening,
    )
    let worst = 0
    // 20 orbits at dt = 0.25 d (P ≈ 258 d).
    for (let i = 0; i < 20 * Math.round(258 / 0.25); i++) {
      engine.step()
      if (i % 500 === 0) {
        const rows = engine.frame().readout!
        const drift = parseFloat(rows.find(([k]) => k.startsWith('Deriva'))![1])
        worst = Math.max(worst, Math.abs(drift))
      }
    }
    expect(e0).toBeLessThan(0)
    expect(worst).toBeLessThan(0.5) // percent
  })

  it('reproduces the figure-eight choreography after one period', () => {
    const build = buildNBody({ system: 'nbody', preset: 'figure8', dt: 0.0005 })
    const engine = new NBodyEngine(build)
    const start = engine.frame().positions.slice()
    const T = 6.32591398
    for (let i = 0; i < Math.round(T / 0.0005); i++) engine.step()
    const end = engine.frame().positions
    for (let i = 0; i < start.length; i++) {
      expect(end[i]).toBeCloseTo(start[i], 2)
    }
  })

  it('reset restores the initial state exactly', () => {
    const engine = new NBodyEngine(buildNBody({ system: 'nbody', preset: 'figure8' }))
    const start = engine.frame().positions.slice()
    for (let i = 0; i < 500; i++) engine.step()
    engine.reset()
    const back = engine.frame().positions
    for (let i = 0; i < start.length; i++) expect(back[i]).toBeCloseTo(start[i], 6)
  })
})

describe('NBodyEngine — Kepler mode', () => {
  it('solar preset carries the Sun plus eight planets', () => {
    const engine = new NBodyEngine(buildNBody({ system: 'nbody', preset: 'solar' }))
    expect(engine.bodyCount).toBe(9)
    expect(engine.names[0]).toBe('Sol')
    expect(engine.names).toContain('Neptuno')
  })

  it('returns Earth to the same place after one year, with no drift', () => {
    const build = buildNBody({
      system: 'nbody', preset: 'inner', startDate: '2026-01-01T00:00:00Z', dt: 1,
    })
    const engine = new NBodyEngine(build)
    const i = engine.names.indexOf('Tierra')
    const p0 = engine.frame().positions.slice(i * 3, i * 3 + 3)
    for (let k = 0; k < 365; k++) engine.step()
    const p1 = engine.frame().positions.slice(i * 3, i * 3 + 3)
    const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    // 365 d is ~0.25 d short of a sidereal year → a small but nonzero gap.
    expect(d).toBeLessThan(0.1 * build.viewScale)
  })

  it('every planet keeps a strictly increasing orbital radius ordering (outer)', () => {
    const engine = new NBodyEngine(buildNBody({ system: 'nbody', preset: 'outer' }))
    for (let k = 0; k < 200; k++) engine.step()
    const p = engine.frame().positions
    const radii = []
    for (let i = 1; i < engine.bodyCount; i++) {
      radii.push(Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]))
    }
    for (let i = 0; i < radii.length - 1; i++) expect(radii[i]).toBeLessThan(radii[i + 1])
  })

  it('draws one orbit path per orbiting body when showOrbits is on', () => {
    const engine = new NBodyEngine(buildNBody({ system: 'nbody', preset: 'inner' }))
    const paths = engine.orbitPaths()
    expect(paths.length).toBe(engine.bodyCount)
    expect(paths[0]).toBeNull()          // the Sun has no orbit
    expect(paths[1]!.points.length).toBe(201 * 3)
  })

  it('reports the simulated date in the HUD', () => {
    const engine = new NBodyEngine(buildNBody({
      system: 'nbody', preset: 'solar', startDate: '2026-08-10T00:00:00Z', dt: 1,
    }))
    for (let k = 0; k < 100; k++) engine.step()
    const date = engine.frame().readout!.find(([k]) => k === 'Fecha')![1]
    expect(date).toBe('2026-11-18')
  })
})

describe('presets', () => {
  it('Galilean moons land on their real periods', () => {
    const p = buildPreset('jupiter-moons', new Date('2026-01-01'))
    const GM = G_AU * p.bodies[0].mass
    const io = p.bodies[1], eu = p.bodies[2], ga = p.bodies[3]
    const aOf = (b: typeof io) => Math.hypot(...b.position)
    expect(period(aOf(io), GM)).toBeCloseTo(1.769, 2)
    expect(period(aOf(eu), GM)).toBeCloseTo(3.551, 2)
    expect(period(aOf(ga), GM)).toBeCloseTo(7.155, 2)
    // Laplace resonance 1:2:4.
    expect(period(aOf(eu), GM) / period(aOf(io), GM)).toBeCloseTo(2, 1)
    expect(period(aOf(ga), GM) / period(aOf(eu), GM)).toBeCloseTo(2, 1)
  })

  it('TRAPPIST-1b keeps its 1.51 d period', () => {
    const p = buildPreset('trappist', new Date())
    const GM = G_AU * p.bodies[0].mass
    expect(period(Math.hypot(...p.bodies[1].position), GM)).toBeCloseTo(1.51, 1)
  })

  it('unknown preset falls back to the solar system instead of throwing', () => {
    expect(buildPreset('nope', new Date()).bodies.length).toBe(9)
  })

  it('custom bodies bypass presets and auto-fit the view', () => {
    const build = buildNBody({
      system: 'nbody',
      bodies: [
        { name: 'a', mass: 1, position: [0, 0, 0] },
        { name: 'b', mass: 1, position: [14, 0, 0], velocity: [0, 0.004, 0] },
      ],
    })
    expect(build.bodies.length).toBe(2)
    expect(build.viewScale).toBeCloseTo(0.5, 6)
  })
})
