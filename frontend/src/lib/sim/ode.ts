/** Arbitrary dynamical systems ẋ = f(x, t), drawn as trajectories.
 *
 *  Where `dynamics` is "particles in space with forces", this is "any state
 *  space at all": Lorenz, Rössler, van der Pol, a double pendulum. The state
 *  variables need not be positions, so the drawn axes are EXPRESSIONS over the
 *  state — that is what lets the double pendulum be integrated in (θ, ω) and
 *  still be drawn as a swinging pendulum in real space.
 */

import { Rk4 } from './integrators'
import { compileScalar } from './dynamics'
import type { OdeSpec, SimCommon, SimEngine, SimFrame } from './types'

export const MAX_TRAJECTORIES = 16
export const MAX_VARS = 12

export interface OdePresetDef {
  vars: string[]
  d: string[]
  init: number[][]
  axes?: [string, string, string]
  /** Extra points per trajectory, joined by segments from the origin — rods. */
  chain?: Array<[string, string, string]>
  viewScale: number
  dt: number
  timeScale: number
  trail: number
  title: string
  colors?: string[]
}

export function odePreset(name: string): OdePresetDef {
  switch (name) {
    case 'lorenz':
      // σ=10, ρ=28, β=8/3. Three starts a thousandth apart: the trajectories
      // stay together for a while and then separate — sensitive dependence,
      // shown rather than asserted.
      return {
        vars: ['x', 'y', 'z'],
        d: ['10*(y - x)', 'x*(28 - z) - y', 'x*y - (8/3)*z'],
        init: [[1, 1, 1], [1.001, 1, 1], [0.999, 1, 1]],
        viewScale: 0.16, dt: 0.002, timeScale: 1, trail: 4000,
        title: 'Atractor de Lorenz (caos determinista)',
        colors: ['#38d5ff', '#ff5f8f', '#ffd700'],
      }

    case 'rossler':
      return {
        vars: ['x', 'y', 'z'],
        d: ['-y - z', 'x + 0.2*y', '0.2 + z*(x - 5.7)'],
        init: [[1, 1, 1]],
        viewScale: 0.3, dt: 0.004, timeScale: 1, trail: 5000,
        title: 'Atractor de Rössler',
        colors: ['#7cff6b'],
      }

    case 'van-der-pol':
      // Limit cycle: every start converges onto the same closed curve.
      return {
        vars: ['x', 'v'],
        d: ['v', '3*(1 - x^2)*v - x'],
        init: [[0.1, 0], [3.5, 2], [-3, -2]],
        axes: ['x', 'v', '0'],
        viewScale: 1.1, dt: 0.002, timeScale: 1, trail: 3000,
        title: 'Van der Pol: ciclo límite',
        colors: ['#38d5ff', '#ff5f8f', '#ffd700'],
      }

    case 'double-pendulum':
      // Equal rods and masses, g = 9.81. Integrated in (θ₁,ω₁,θ₂,ω₂) and drawn
      // in real space through `axes`/`chain`.
      return {
        vars: ['th1', 'w1', 'th2', 'w2'],
        d: [
          'w1',
          '(-9.81*3*sin(th1) - 9.81*sin(th1 - 2*th2) - 2*sin(th1 - th2)*(w2^2 + w1^2*cos(th1 - th2))) / (3 - cos(2*(th1 - th2)))',
          'w2',
          '(2*sin(th1 - th2)*(2*w1^2 + 2*9.81*cos(th1) + w2^2*cos(th1 - th2))) / (3 - cos(2*(th1 - th2)))',
        ],
        init: [
          [2.0, 0, 2.0, 0],
          [2.001, 0, 2.0, 0],
        ],
        // Drawn point = the TIP of the second rod.
        axes: ['sin(th1) + sin(th2)', '0', '-cos(th1) - cos(th2)'],
        chain: [
          ['sin(th1)', '0', '-cos(th1)'],
          ['sin(th1) + sin(th2)', '0', '-cos(th1) - cos(th2)'],
        ],
        viewScale: 2.4, dt: 0.001, timeScale: 1, trail: 2500,
        title: 'Péndulo doble (dos inicios que difieren en 0.001 rad)',
        colors: ['#38d5ff', '#ff5f8f'],
      }

    case 'chua':
      return {
        vars: ['x', 'y', 'z'],
        d: [
          '9.35*(y - x + 1.143*x - 0.5*(-0.714 - -1.143)*(abs(x + 1) - abs(x - 1)))',
          'x - y + z',
          '-14.79*y',
        ],
        init: [[0.1, 0, 0]],
        viewScale: 0.9, dt: 0.002, timeScale: 1, trail: 5000,
        title: 'Circuito de Chua',
        colors: ['#64ffda'],
      }

    default:
      return odePreset('lorenz')
  }
}

export interface OdeBuild {
  vars: string[]
  d: string[]
  init: number[][]
  axes: [string, string, string]
  chain: Array<[string, string, string]>
  viewScale: number
  dt: number
  timeScale: number
  trail: number
  title: string
  colors: string[]
  badExpressions: string[]
}

export function buildOde(spec: OdeSpec & SimCommon): OdeBuild {
  const usesCustom = !!(spec.vars?.length && spec.d?.length)
  const base = usesCustom ? null : odePreset(spec.preset ?? 'lorenz')
  const vars = (spec.vars?.length ? spec.vars : base!.vars).slice(0, MAX_VARS)
  const d = (spec.d?.length ? spec.d : base!.d).slice(0, vars.length)
  const init = (spec.init?.length ? spec.init : base!.init).slice(0, MAX_TRAJECTORIES)
  const axes = (spec.axes ?? base?.axes ?? [vars[0], vars[1] ?? '0', vars[2] ?? '0']) as [string, string, string]

  const bad: string[] = []
  d.forEach((expr, i) => { if (!compileScalar(expr)) bad.push(`d${vars[i]}/dt: ${expr}`) })
  axes.forEach((expr) => { if (!compileScalar(expr)) bad.push(`eje: ${expr}`) })

  return {
    vars, d, init, axes,
    chain: base?.chain ?? [],
    viewScale: spec.viewScale ?? base?.viewScale ?? 1,
    dt: spec.dt ?? base?.dt ?? 0.005,
    timeScale: spec.timeScale ?? base?.timeScale ?? 1,
    trail: spec.trail === false ? 0 : (spec.trail ?? base?.trail ?? 3000),
    title: base?.title ?? 'Sistema dinámico',
    colors: base?.colors ?? DEFAULT,
    badExpressions: bad,
  }
}

const DEFAULT = ['#38d5ff', '#ff5f8f', '#ffd700', '#7cff6b', '#64ffda']

interface OdeScope { t: number; [k: string]: number }

/** One RK4 integration per trajectory, all packed into a single state vector so
 *  a spec with 16 starts costs one integrator, not sixteen. */
export class OdeEngine implements SimEngine {
  readonly bodyCount: number
  readonly colors: string[]
  readonly radii: number[]
  readonly names: string[]
  readonly build: OdeBuild

  private readonly nVars: number
  private readonly state: Float64Array
  private readonly state0: Float64Array
  private readonly scenePos: Float32Array
  /** Chain node positions per trajectory (scene units), flat xyz. */
  readonly chainPos: Float32Array
  private readonly rk: Rk4
  private readonly dFns: Array<ReturnType<typeof compileScalar>>
  private readonly axisFns: Array<ReturnType<typeof compileScalar>>
  private readonly chainFns: Array<Array<ReturnType<typeof compileScalar>>>
  private readonly scope: OdeScope
  private t = 0
  private frameObj: SimFrame

  constructor(build: OdeBuild) {
    this.build = build
    const nv = build.vars.length
    const traj = build.init.length
    this.nVars = nv
    this.bodyCount = traj
    this.colors = build.init.map((_, i) => build.colors[i % build.colors.length])
    this.radii = new Array(traj).fill(0.09)
    this.names = build.init.map((_, i) => `#${i + 1}`)

    this.state = new Float64Array(traj * nv)
    build.init.forEach((row, i) => {
      for (let k = 0; k < nv; k++) this.state[i * nv + k] = row[k] ?? 0
    })
    this.state0 = this.state.slice()
    this.scenePos = new Float32Array(traj * 3)
    this.chainPos = new Float32Array(traj * Math.max(1, build.chain.length) * 3)

    this.scope = { t: 0 }
    for (const v of build.vars) this.scope[v] = 0
    this.dFns = build.d.map((e) => compileScalar(e))
    this.axisFns = build.axes.map((e) => compileScalar(e))
    this.chainFns = build.chain.map((triple) => triple.map((e) => compileScalar(e)))

    this.rk = new Rk4(traj * nv, (t, y, out) => {
      for (let i = 0; i < traj; i++) {
        const base = i * nv
        this.scope.t = t
        for (let k = 0; k < nv; k++) this.scope[build.vars[k]] = y[base + k]
        for (let k = 0; k < nv; k++) {
          const fn = this.dFns[k]
          out[base + k] = fn ? fn(this.scope as never) : 0
        }
      }
    })

    this.frameObj = { t: 0, positions: this.scenePos, readout: [] }
    this.writeScene()
  }

  step(): void {
    this.t = this.rk.step(this.t, this.state, this.build.dt)
    this.writeScene()
  }

  private writeScene(): void {
    const { viewScale, vars, chain } = this.build
    const nv = this.nVars
    for (let i = 0; i < this.bodyCount; i++) {
      const base = i * nv
      this.scope.t = this.t
      for (let k = 0; k < nv; k++) this.scope[vars[k]] = this.state[base + k]
      for (let a = 0; a < 3; a++) {
        const fn = this.axisFns[a]
        const v = fn ? fn(this.scope as never) : 0
        this.scenePos[i * 3 + a] = isFinite(v) ? v * viewScale : 0
      }
      for (let c = 0; c < chain.length; c++) {
        for (let a = 0; a < 3; a++) {
          const fn = this.chainFns[c][a]
          const v = fn ? fn(this.scope as never) : 0
          this.chainPos[(i * chain.length + c) * 3 + a] = isFinite(v) ? v * viewScale : 0
        }
      }
    }
  }

  /** Current value of every state variable, for the HUD. */
  stateOf(trajectory: number): Record<string, number> {
    const out: Record<string, number> = {}
    this.build.vars.forEach((v, k) => { out[v] = this.state[trajectory * this.nVars + k] })
    return out
  }

  /** Separation between the first two trajectories — the chaos meter. */
  divergence(): number {
    if (this.bodyCount < 2) return 0
    let sum = 0
    for (let k = 0; k < this.nVars; k++) {
      sum += (this.state[k] - this.state[this.nVars + k]) ** 2
    }
    return Math.sqrt(sum)
  }

  frame(): SimFrame {
    const f = this.frameObj
    f.t = this.t
    const rows: Array<[string, string]> = [['t', this.t.toFixed(2)]]
    if (this.bodyCount > 1) {
      rows.push(['Separación 1↔2', this.divergence().toExponential(2)])
    }
    const s = this.stateOf(0)
    rows.push([this.build.vars.slice(0, 3).join(' · '),
      this.build.vars.slice(0, 3).map((v) => s[v].toFixed(2)).join(' · ')])
    if (this.build.badExpressions.length) {
      rows.push(['⚠ Expresión inválida', this.build.badExpressions.join(' · ')])
    }
    f.readout = rows
    return f
  }

  reset(): void {
    this.state.set(this.state0)
    this.t = 0
    this.writeScene()
  }
}
