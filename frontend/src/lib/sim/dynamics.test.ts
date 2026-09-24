import { describe, it, expect } from 'vitest'
import { buildDynamics, DynamicsEngine, compileScalar, compileVector } from './dynamics'

const run = (spec: Parameters<typeof buildDynamics>[0], steps: number) => {
  const e = new DynamicsEngine(buildDynamics(spec))
  for (let i = 0; i < steps; i++) e.step()
  return e
}

describe('expression compiling', () => {
  it('compiles numbers, constants and formulas', () => {
    expect(compileScalar('2 + 3')!({} as never)).toBe(5)
    expect(compileScalar(7)!({} as never)).toBe(7)
    expect(compileScalar('x * vy')!({ x: 3, vy: 4 } as never)).toBe(12)
  })

  it('returns null for invalid input instead of throwing', () => {
    expect(compileScalar('2 +* 3')).toBeNull()
    expect(compileScalar('')).toBeNull()
    expect(compileScalar(undefined)).toBeNull()
  })

  it('maps non-finite results to 0 so a bad formula cannot poison the state', () => {
    expect(compileScalar('1/0')!({} as never)).toBe(0)
    expect(compileScalar('sqrt(-1)')!({} as never)).toBe(0) // complex → not a number
  })

  it('compiles vectors given as numbers or as expressions', () => {
    const v = compileVector([0, 0, 1.5])!
    expect(v[2]!({} as never)).toBe(1.5)
    const e = compileVector(['y', '-x', '0'])!
    expect(e[0]!({ y: 2 } as never)).toBe(2)
  })
})

describe('projectile', () => {
  it('lands at the analytic range v²sin(2θ)/g', () => {
    const g = 9.81, v0 = 20, deg = 35
    const a = (deg * Math.PI) / 180
    const e = run({
      system: 'dynamics', gravity: g, dt: 0.0005, viewScale: 1,
      particles: [{ position: [0, 0, 0], velocity: [v0 * Math.cos(a), 0, v0 * Math.sin(a)], radius: 0 }],
    }, Math.round((2 * v0 * Math.sin(a)) / g / 0.0005))
    const x = e.frame().positions[0]
    expect(x).toBeCloseTo((v0 * v0 * Math.sin(2 * a)) / g, 1)
  })

  it('gives 45° the longest range of the preset angles', () => {
    const e = run({ system: 'dynamics', preset: 'projectile', dt: 0.001 }, 6000)
    const p = e.frame().positions
    const vs = 0.16 // preset viewScale
    const ranges = e.names.map((_, i) => p[i * 3] / vs)
    const best = ranges.indexOf(Math.max(...ranges))
    expect(e.names[best]).toBe('45°')
  })

  it('bounces off the floor and loses no height when perfectly elastic', () => {
    const e = run({
      system: 'dynamics', gravity: 9.81, floor: 0, restitution: 1, dt: 0.0005, viewScale: 1,
      particles: [{ position: [0, 0, 2], velocity: [0, 0, 0], radius: 0 }],
    }, 4000) // ≈ 2 s: down, bounce, back up
    expect(e.frame().positions[2]).toBeGreaterThan(0)
    expect(e.frame().positions[2]).toBeLessThanOrEqual(2.001)
  })
})

describe('spring', () => {
  it('oscillates with the analytic period 2π√(m/k)', () => {
    const k = 8, m = 2
    const T = 2 * Math.PI * Math.sqrt(m / k)
    const dt = 0.0005
    const e = run({
      system: 'dynamics', spring: { k, anchor: [0, 0, 0], restLength: 0 },
      dt, viewScale: 1,
      particles: [{ position: [1, 0, 0], velocity: [0, 0, 0], mass: m, radius: 0 }],
    }, Math.round(T / dt))
    expect(e.frame().positions[0]).toBeCloseTo(1, 3)
  })

  it('conserves total energy when undamped', () => {
    const k = 5
    const spec = {
      system: 'dynamics' as const, spring: { k }, dt: 0.001, viewScale: 1,
      particles: [{
        position: [1.5, 0, 0] as [number, number, number],
        velocity: [0, 0, 0] as [number, number, number],
        mass: 1, radius: 0,
      }],
    }
    const e = new DynamicsEngine(buildDynamics(spec))
    const total = () => {
      const x = e.frame().positions[0]
      return e.kineticEnergy() + 0.5 * k * x * x
    }
    const e0 = total()
    for (let i = 0; i < 20000; i++) e.step()
    expect(total()).toBeCloseTo(e0, 6)
  })

  it('damping bleeds the energy away', () => {
    const e = new DynamicsEngine(buildDynamics({
      system: 'dynamics', spring: { k: 5 }, drag: 0.5, dt: 0.001, viewScale: 1,
      particles: [{ position: [1.5, 0, 0], velocity: [0, 0, 0], radius: 0 }],
    }))
    for (let i = 0; i < 200; i++) e.step()
    const early = e.kineticEnergy()
    for (let i = 0; i < 8000; i++) e.step()
    expect(e.kineticEnergy()).toBeLessThan(early * 0.05)
  })
})

describe('Lorentz force', () => {
  it('keeps the speed constant — a magnetic field does no work', () => {
    const e = new DynamicsEngine(buildDynamics({
      system: 'dynamics', bField: [0, 0, 2], dt: 0.0005, viewScale: 1,
      particles: [{ position: [1, 0, 0], velocity: [0, 3, 1], charge: 1, mass: 1, radius: 0 }],
    }))
    const speed0 = Math.hypot(...e.frame().velocities!)
    for (let i = 0; i < 20000; i++) e.step()
    expect(Math.hypot(...e.frame().velocities!)).toBeCloseTo(speed0, 6)
  })

  it('gyrates with the cyclotron radius r = mv⊥/(qB)', () => {
    const B = 2, q = 1, m = 1, vperp = 3
    const e = new DynamicsEngine(buildDynamics({
      system: 'dynamics', bField: [0, 0, B], dt: 0.0002, viewScale: 1,
      particles: [{ position: [0, 0, 0], velocity: [0, vperp, 0], charge: q, mass: m, radius: 0 }],
    }))
    let maxX = 0
    const T = (2 * Math.PI * m) / (q * B)
    for (let i = 0; i < Math.round(T / 0.0002); i++) {
      e.step()
      maxX = Math.max(maxX, Math.abs(e.frame().positions[0]))
    }
    expect(maxX).toBeCloseTo((2 * m * vperp) / (q * B), 2) // diameter
  })

  it('sends opposite charges around opposite ways', () => {
    const e = run({ system: 'dynamics', preset: 'cyclotron', dt: 0.001 }, 200)
    // They start mirrored in x; after a moment their y motion differs in sign.
    expect(Math.sign(e.frame().velocities![0])).not.toBe(Math.sign(e.frame().velocities![3]))
  })
})

describe('central force', () => {
  it('holds a circular orbit at constant radius', () => {
    const e = new DynamicsEngine(buildDynamics({
      system: 'dynamics', preset: 'orbit', dt: 0.0005,
    }))
    const vs = 1.1
    const radius = () => {
      const p = e.frame().positions
      return Math.hypot(p[0], p[1], p[2]) / vs
    }
    const r0 = radius()
    for (let i = 0; i < 20000; i++) e.step()
    expect(radius()).toBeCloseTo(r0, 2)
  })

  it('lets the hyperbolic one escape while the elliptic one stays bound', () => {
    const e = run({ system: 'dynamics', preset: 'orbit', dt: 0.001 }, 12000)
    const p = e.frame().positions
    const r = (i: number) => Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) / 1.1
    expect(r(2)).toBeGreaterThan(r(1))
    expect(r(1)).toBeGreaterThan(0)
  })
})

describe('box collisions', () => {
  it('keeps every particle inside and conserves speed when elastic', () => {
    const e = new DynamicsEngine(buildDynamics({ system: 'dynamics', preset: 'collision', dt: 0.002 }))
    const k0 = e.kineticEnergy()
    for (let i = 0; i < 5000; i++) e.step()
    const p = e.frame().positions
    for (let i = 0; i < e.bodyCount; i++) {
      expect(Math.abs(p[i * 3] / 1.2)).toBeLessThanOrEqual(3.21)
      expect(Math.abs(p[i * 3 + 2] / 1.2)).toBeLessThanOrEqual(2.21)
    }
    expect(e.kineticEnergy()).toBeCloseTo(k0, 6)
  })

  it('restitution < 1 drains energy on every bounce', () => {
    const e = new DynamicsEngine(buildDynamics({
      system: 'dynamics', preset: 'collision', restitution: 0.5, dt: 0.002,
    }))
    const k0 = e.kineticEnergy()
    for (let i = 0; i < 20000; i++) e.step()
    expect(e.kineticEnergy()).toBeLessThan(k0)
  })
})

describe('robustness', () => {
  it('reports a broken formula instead of throwing', () => {
    const build = buildDynamics({
      system: 'dynamics', force: { fx: 'sin(' }, viewScale: 1,
      particles: [{ position: [0, 0, 0] }],
    })
    expect(build.badExpressions.length).toBe(1)
    const e = new DynamicsEngine(build)
    expect(() => { for (let i = 0; i < 100; i++) e.step() }).not.toThrow()
    expect(e.frame().readout!.some(([k]) => k.startsWith('⚠'))).toBe(true)
  })

  it('honours fixed particles', () => {
    const e = run({
      system: 'dynamics', gravity: 9.81, viewScale: 1,
      particles: [{ position: [0, 0, 5], fixed: true }, { position: [1, 0, 5] }],
    }, 500)
    const p = e.frame().positions
    expect(p[2]).toBe(5)
    expect(p[5]).toBeLessThan(5)
  })

  it('reset restores the initial state', () => {
    const e = new DynamicsEngine(buildDynamics({ system: 'dynamics', preset: 'cyclotron' }))
    const p0 = e.frame().positions.slice()
    for (let i = 0; i < 500; i++) e.step()
    e.reset()
    expect(Array.from(e.frame().positions)).toEqual(Array.from(p0))
  })

  it('caps the particle count', () => {
    const build = buildDynamics({
      system: 'dynamics',
      particles: Array.from({ length: 200 }, () => ({ position: [0, 0, 0] as [number, number, number] })),
    })
    expect(build.particles.length).toBe(64)
  })
})
