import { describe, it, expect } from 'vitest'
import { buildOde, odePreset, OdeEngine } from './ode'

const advance = (e: OdeEngine, n: number) => { for (let i = 0; i < n; i++) e.step() }

describe('presets', () => {
  it('exposes every named system with a matching var/derivative count', () => {
    for (const n of ['lorenz', 'rossler', 'van-der-pol', 'double-pendulum', 'chua']) {
      const p = odePreset(n)
      expect(p.d.length).toBe(p.vars.length)
      expect(p.init.every((row) => row.length === p.vars.length)).toBe(true)
    }
  })

  it('falls back to Lorenz for an unknown name', () => {
    expect(odePreset('nope').title).toBe(odePreset('lorenz').title)
  })
})

describe('Lorenz', () => {
  it('stays on the attractor instead of blowing up', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'lorenz' }))
    advance(e, 20000)
    const p = e.frame().positions
    for (let i = 0; i < p.length; i++) expect(Math.abs(p[i])).toBeLessThan(20)
  })

  it('separates nearby initial conditions — sensitive dependence', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'lorenz' }))
    const d0 = e.divergence()
    expect(d0).toBeCloseTo(0.001, 6)
    advance(e, 15000)   // t = 30
    expect(e.divergence()).toBeGreaterThan(1)
  })

  it('reports the divergence in the HUD', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'lorenz' }))
    advance(e, 100)
    expect(e.frame().readout!.some(([k]) => k.startsWith('Separación'))).toBe(true)
  })
})

describe('van der Pol', () => {
  it('pulls every start onto the same limit cycle', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'van-der-pol' }))
    advance(e, 20000) // t = 40, several cycles
    const amp = (i: number) => Math.abs(e.stateOf(i).x)
    // All three trajectories now live on the same closed curve, so at any
    // instant their |x| is bounded by the cycle amplitude ≈ 2.
    for (let i = 0; i < e.bodyCount; i++) expect(amp(i)).toBeLessThan(2.2)
  })
})

describe('double pendulum', () => {
  it('keeps both rods rigid — a constraint the state space enforces by design', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'double-pendulum' }))
    advance(e, 5000)
    const vs = 2.4
    for (let i = 0; i < e.bodyCount; i++) {
      const base = i * 2 * 3   // 2 chain nodes per trajectory
      const n1 = [e.chainPos[base] / vs, e.chainPos[base + 1] / vs, e.chainPos[base + 2] / vs]
      const n2 = [e.chainPos[base + 3] / vs, e.chainPos[base + 4] / vs, e.chainPos[base + 5] / vs]
      expect(Math.hypot(n1[0], n1[2])).toBeCloseTo(1, 6)
      expect(Math.hypot(n2[0] - n1[0], n2[2] - n1[2])).toBeCloseTo(1, 6)
    }
  })

  it('conserves energy well enough for a long run', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'double-pendulum' }))
    // E = KE + PE for equal unit rods/masses, g = 9.81.
    const energy = () => {
      const { th1, w1, th2, w2 } = e.stateOf(0)
      // ½m₁v₁² + ½m₂v₂², with v₂² = ω₁² + ω₂² + 2ω₁ω₂cos(θ₁−θ₂).
      const ke = 0.5 * w1 * w1 + 0.5 * (w1 * w1 + w2 * w2 + 2 * w1 * w2 * Math.cos(th1 - th2))
      const pe = -9.81 * (2 * Math.cos(th1) + Math.cos(th2))
      return ke + pe
    }
    const e0 = energy()
    advance(e, 20000) // t = 20 s
    expect(Math.abs(energy() - e0)).toBeLessThan(1e-3)
  })

  it('two starts 0.001 rad apart end up nowhere near each other', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'double-pendulum' }))
    advance(e, 20000)
    expect(e.divergence()).toBeGreaterThan(0.5)
  })
})

describe('custom systems', () => {
  it('integrates a harmonic oscillator to its analytic solution', () => {
    // ẍ = −x  ⇒  x(t) = cos t
    const e = new OdeEngine(buildOde({
      system: 'ode', vars: ['x', 'v'], d: ['v', '-x'], init: [[1, 0]],
      axes: ['x', 'v', '0'], dt: 0.001, viewScale: 1,
    }))
    advance(e, 1000)              // t = 1
    expect(e.stateOf(0).x).toBeCloseTo(Math.cos(1), 8)
    const extra = Math.round(Math.PI * 1000)
    advance(e, extra)
    // Compare at the time actually reached — rounding π to a whole number of
    // steps moves the target by 4e-4 s, which dwarfs the integration error.
    expect(e.stateOf(0).x).toBeCloseTo(Math.cos(1 + extra * 0.001), 8)
  })

  it('maps arbitrary expressions onto the drawn axes', () => {
    const e = new OdeEngine(buildOde({
      system: 'ode', vars: ['a'], d: ['1'], init: [[0]],
      axes: ['cos(a)', 'sin(a)', 'a/10'], dt: 0.01, viewScale: 1,
    }))
    advance(e, 100)   // a = 1
    const p = e.frame().positions
    expect(p[0]).toBeCloseTo(Math.cos(1), 6)
    expect(p[1]).toBeCloseTo(Math.sin(1), 6)
    expect(p[2]).toBeCloseTo(0.1, 6)
  })

  it('reports broken derivative expressions and keeps running', () => {
    const build = buildOde({ system: 'ode', vars: ['x'], d: ['sin('], init: [[1]] })
    expect(build.badExpressions.length).toBe(1)
    const e = new OdeEngine(build)
    expect(() => advance(e, 100)).not.toThrow()
    expect(e.stateOf(0).x).toBe(1)   // zero derivative → frozen, not NaN
  })

  it('caps trajectories and variables', () => {
    const build = buildOde({
      system: 'ode',
      vars: Array.from({ length: 40 }, (_, i) => `v${i}`),
      d: Array.from({ length: 40 }, () => '0'),
      init: Array.from({ length: 40 }, () => [0]),
    })
    expect(build.vars.length).toBe(12)
    expect(build.init.length).toBe(16)
  })

  it('reset restores the initial state', () => {
    const e = new OdeEngine(buildOde({ system: 'ode', preset: 'rossler' }))
    const p0 = e.frame().positions.slice()
    advance(e, 500)
    e.reset()
    expect(Array.from(e.frame().positions)).toEqual(Array.from(p0))
  })
})
