/** Newtonian particle dynamics with composable forces.
 *
 *  This is the "physics case" engine: projectiles with drag, springs, charges in
 *  magnetic fields, central forces, collisions — anything of the form
 *
 *      m ẍ = F(x, ẋ, t)
 *
 *  Every term is optional and they SUM, so a spec can stack gravity + drag + a
 *  free-form expression without the engine growing a special case per scenario.
 *  Expressions are mathjs strings evaluated against a reused scope object; a
 *  formula that fails to compile degrades to zero force and is reported, never
 *  throws into the render loop (same rule as the 3D spec kinds).
 */

import { create, all, type MathNode } from 'mathjs'
import { Rk4 } from './integrators'
import type { DynamicsSpec, SimCommon, SimEngine, SimFrame, DynamicsParticle, Vec3 } from './types'

const math = create(all)

export const MAX_PARTICLES = 64

/** Scope handed to every force expression. Mutated in place, never rebuilt. */
interface ForceScope {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  t: number; m: number; q: number
  r: number; speed: number
  [k: string]: number
}

type Compiled = ((scope: ForceScope) => number) | null

/** Compiles a mathjs expression to a scalar function, or null if it is empty
 *  or invalid. Constants are accepted too (a number is a valid expression). */
export function compileScalar(expr: string | number | undefined): Compiled {
  if (expr === undefined || expr === null || expr === '') return null
  if (typeof expr === 'number') return () => expr
  try {
    const node: MathNode = math.parse(expr)
    const code = node.compile()
    return (scope: ForceScope) => {
      const v = code.evaluate(scope)
      return typeof v === 'number' && isFinite(v) ? v : 0
    }
  } catch {
    return null
  }
}

/** Compiles a 3-vector that may be given as numbers or as expressions. */
export function compileVector(
  v: Vec3 | [string, string, string] | undefined,
): [Compiled, Compiled, Compiled] | null {
  if (!v) return null
  return [compileScalar(v[0]), compileScalar(v[1]), compileScalar(v[2])]
}

const evalVec = (
  c: [Compiled, Compiled, Compiled] | null, s: ForceScope, out: Vec3,
): Vec3 => {
  out[0] = c?.[0] ? c[0](s) : 0
  out[1] = c?.[1] ? c[1](s) : 0
  out[2] = c?.[2] ? c[2](s) : 0
  return out
}

export interface DynamicsBuild {
  spec: DynamicsSpec & SimCommon
  particles: DynamicsParticle[]
  dt: number
  timeScale: number
  trail: number
  viewScale: number
  title: string
  /** Expressions that failed to compile — surfaced in the HUD. */
  badExpressions: string[]
}

/* ---------------- Presets ---------------- */

interface PresetOut {
  particles: DynamicsParticle[]
  patch: Partial<DynamicsSpec>
  dt: number
  timeScale: number
  trail: number
  viewScale: number
  title: string
}

export function dynamicsPreset(name: string): PresetOut {
  switch (name) {
    case 'projectile': {
      // Same speed, five launch angles — the 45° range maximum, made visible.
      const v0 = 20
      const angles = [20, 35, 45, 60, 75]
      const colors = ['#ff8a80', '#ffd700', '#7cff6b', '#64ffda', '#38d5ff']
      return {
        particles: angles.map((deg, i) => {
          const a = (deg * Math.PI) / 180
          return {
            name: `${deg}°`, position: [0, 0, 0.06] as Vec3,
            velocity: [v0 * Math.cos(a), 0, v0 * Math.sin(a)] as Vec3,
            mass: 1, radius: 0.06, color: colors[i],
          }
        }),
        patch: { gravity: 9.81, floor: 0, restitution: 0, stopOnFloor: true, vectors: ['velocity'] },
        dt: 0.002, timeScale: 1, trail: 900, viewScale: 0.16,
        title: 'Tiro parabólico (alcance máximo a 45°)',
      }
    }

    case 'spring': {
      return {
        particles: [
          { name: 'Libre', position: [-2, 0, 1], velocity: [0, 0, 0], mass: 1, radius: 0.12, color: '#38d5ff' },
          { name: 'Amortiguado', position: [2, 0, 1], velocity: [0, 0, 0], mass: 1, radius: 0.12, color: '#ff5f8f' },
        ],
        patch: {
          spring: { k: 8, anchor: [0, 0, 0], restLength: 0 },
          drag: 0, force: { fz: '-0.6 * vz * (x > 0 ? 1 : 0)' },
          vectors: ['velocity', 'force'],
        },
        dt: 0.002, timeScale: 1, trail: 700, viewScale: 1.4,
        title: 'Oscilador: libre vs amortiguado',
      }
    }

    case 'cyclotron': {
      // q v × B with a velocity component along B → helix. The classic picture
      // of a charged particle in a magnetic field, drawn by the actual force.
      return {
        particles: [
          { name: 'q+', position: [1.5, 0, -2], velocity: [0, 2.2, 0.7], mass: 1, charge: 1, radius: 0.1, color: '#38d5ff' },
          { name: 'q−', position: [-1.5, 0, -2], velocity: [0, 2.2, 0.7], mass: 1, charge: -1, radius: 0.1, color: '#ff5f8f' },
        ],
        patch: { bField: [0, 0, 1.5] as Vec3, vectors: ['velocity', 'force'] },
        dt: 0.004, timeScale: 1, trail: 1200, viewScale: 1.1,
        title: 'Fuerza de Lorentz: hélices de carga ±',
      }
    }

    case 'orbit': {
      // Inverse-square central force with live radius/velocity arrows.
      return {
        particles: [
          { name: 'Circular', position: [3, 0, 0], velocity: [0, 1.826, 0], mass: 1, radius: 0.1, color: '#64ffda' },
          { name: 'Elíptica', position: [3, 0, 0], velocity: [0, 2.3, 0], mass: 1, radius: 0.1, color: '#ffd700' },
          { name: 'Hiperbólica', position: [3, 0, 0], velocity: [0, 3.1, 0], mass: 1, radius: 0.1, color: '#ff5f8f' },
        ],
        patch: {
          force: {
            fx: '-10 * m * x / (r^3 + 1e-6)',
            fy: '-10 * m * y / (r^3 + 1e-6)',
            fz: '-10 * m * z / (r^3 + 1e-6)',
          },
          vectors: ['velocity', 'force'],
        },
        dt: 0.002, timeScale: 1, trail: 1500, viewScale: 1.1,
        title: 'Fuerza central 1/r²: circular, elíptica y de escape',
      }
    }

    case 'collision': {
      const rnd = mulberry32(7)
      return {
        particles: Array.from({ length: 12 }, (_, i) => ({
          name: `p${i + 1}`,
          position: [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 4 - 2] as Vec3,
          velocity: [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 2 - 1] as Vec3,
          mass: 1, radius: 0.14,
          color: `hsl(${Math.floor(rnd() * 360)}, 80%, 62%)`,
        })),
        patch: { box: [3.2, 3.2, 2.2] as Vec3, restitution: 1, collisions: true, vectors: ['velocity'] },
        dt: 0.004, timeScale: 1, trail: 200, viewScale: 1.2,
        title: 'Gas ideal: choques elásticos en una caja',
      }
    }

    default:
      return dynamicsPreset('projectile')
  }
}

/** Small deterministic PRNG — reproducible scenes matter for a physics demo. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildDynamics(spec: DynamicsSpec & SimCommon): DynamicsBuild {
  const preset = spec.preset || (spec.particles?.length ? null : 'projectile')
  const base = preset ? dynamicsPreset(preset) : null
  const merged: DynamicsSpec & SimCommon = { ...(base?.patch ?? {}), ...spec, system: 'dynamics' }
  const particles = (spec.particles?.length ? spec.particles : base!.particles).slice(0, MAX_PARTICLES)

  const bad: string[] = []
  const check = (label: string, e?: string) => { if (e && !compileScalar(e)) bad.push(`${label}: ${e}`) }
  check('fx', merged.force?.fx); check('fy', merged.force?.fy); check('fz', merged.force?.fz)

  return {
    spec: merged,
    particles,
    dt: spec.dt ?? base?.dt ?? 0.005,
    timeScale: spec.timeScale ?? base?.timeScale ?? 1,
    trail: spec.trail === false ? 0 : (spec.trail ?? base?.trail ?? 600),
    viewScale: spec.viewScale ?? base?.viewScale ?? 1,
    title: base?.title ?? 'Dinámica',
    badExpressions: bad,
  }
}

/* ---------------- Engine ---------------- */

/** Choque elástico/inelástico entre esferas, resuelto por impulso normal.
 *
 *  Modelo de contacto por PROYECCIÓN, igual que las paredes: se deja avanzar el
 *  paso y después se corrige el solape. No busca el instante exacto del choque,
 *  y a cambio es estable y barato. Para una escena didáctica es lo correcto; un
 *  solver de tiempo de colisión sería otro programa.
 *
 *  Lo que sí respeta, y es lo que se puede comprobar en un test:
 *    · momento lineal conservado SIEMPRE (el impulso es igual y opuesto),
 *    · energía conservada exactamente si `restitution` = 1, y estrictamente
 *      decreciente si es menor — nunca creciente, que es el fallo clásico de
 *      un solver mal escrito y se ve como partículas que se auto-aceleran.
 *
 *  `fixed[i]` = masa infinita: una partícula clavada empuja y no es empujada.
 *  Devuelve cuántos pares chocaron (el HUD lo enseña).
 */
export function resolveCollisions(
  state: Float64Array, mass: Float64Array, radii: number[],
  fixed: boolean[], restitution = 1,
): number {
  const n = mass.length
  let hits = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (fixed[i] && fixed[j]) continue
      const a = i * 6, b = j * 6
      let nx = state[b] - state[a]
      let ny = state[b + 1] - state[a + 1]
      let nz = state[b + 2] - state[a + 2]
      const touch = radii[i] + radii[j]
      const d2 = nx * nx + ny * ny + nz * nz
      if (d2 > touch * touch || d2 === 0) continue
      const d = Math.sqrt(d2)
      nx /= d; ny /= d; nz /= d

      const vn = (state[b + 3] - state[a + 3]) * nx
        + (state[b + 4] - state[a + 4]) * ny
        + (state[b + 5] - state[a + 5]) * nz
      // Ya se están separando: corregir aquí las pegaría de nuevo y el par
      // entraría en un zumbido perpetuo contra el paso del integrador.
      if (vn > 0) continue

      const invA = fixed[i] ? 0 : 1 / mass[i]
      const invB = fixed[j] ? 0 : 1 / mass[j]
      const invSum = invA + invB
      if (invSum === 0) continue
      const imp = -(1 + restitution) * vn / invSum
      state[a + 3] -= imp * invA * nx
      state[a + 4] -= imp * invA * ny
      state[a + 5] -= imp * invA * nz
      state[b + 3] += imp * invB * nx
      state[b + 4] += imp * invB * ny
      state[b + 5] += imp * invB * nz

      // Deshacer el solape repartido por masa inversa, o las esferas quedan
      // encajadas y vuelven a dispararse en el paso siguiente.
      const push = (touch - d) / invSum
      state[a] -= push * invA * nx
      state[a + 1] -= push * invA * ny
      state[a + 2] -= push * invA * nz
      state[b] += push * invB * nx
      state[b + 1] += push * invB * ny
      state[b + 2] += push * invB * nz
      hits++
    }
  }
  return hits
}

export class DynamicsEngine implements SimEngine {
  readonly bodyCount: number
  readonly colors: string[]
  readonly radii: number[]
  readonly names: string[]
  readonly masses: Float64Array
  readonly charges: Float64Array
  /** Which arrows the renderer should draw. */
  readonly overlays: NonNullable<DynamicsSpec['vectors']>

  private readonly state: Float64Array      // [x,y,z,vx,vy,vz] per particle
  private readonly state0: Float64Array
  private readonly scenePos: Float32Array
  private readonly sceneVel: Float32Array
  private readonly sceneAcc: Float32Array
  private readonly rk: Rk4
  private readonly scope: ForceScope
  private readonly fExpr: [Compiled, Compiled, Compiled] | null
  private readonly eField: [Compiled, Compiled, Compiled] | null
  private readonly bField: [Compiled, Compiled, Compiled] | null
  /** Public so the renderer can read vectorScale / viewScale without a copy. */
  readonly build: DynamicsBuild
  private readonly tmpE: Vec3 = [0, 0, 0]
  private readonly tmpB: Vec3 = [0, 0, 0]
  private readonly fixed: boolean[]
  /** Snapshot so a landing that pins a particle (stopOnFloor) is undone. */
  private readonly fixed0: boolean[]
  private readonly accScratch: Float64Array
  private t = 0
  private frameObj: SimFrame

  constructor(build: DynamicsBuild) {
    this.build = build
    const ps = build.particles
    const n = ps.length
    this.bodyCount = n
    this.colors = ps.map((p, i) => p.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length])
    this.radii = ps.map((p) => p.radius ?? 0.1)
    this.names = ps.map((p, i) => p.name ?? `p${i + 1}`)
    this.masses = Float64Array.from(ps.map((p) => p.mass ?? 1))
    this.charges = Float64Array.from(ps.map((p) => p.charge ?? 0))
    this.fixed = ps.map((p) => !!p.fixed)
    this.fixed0 = this.fixed.slice()
    this.overlays = build.spec.vectors ?? ['velocity']

    this.state = new Float64Array(n * 6)
    ps.forEach((p, i) => {
      this.state.set(p.position, i * 6)
      this.state.set(p.velocity ?? [0, 0, 0], i * 6 + 3)
    })
    this.state0 = this.state.slice()
    this.accScratch = new Float64Array(n * 6)

    this.scenePos = new Float32Array(n * 3)
    this.sceneVel = new Float32Array(n * 3)
    this.sceneAcc = new Float32Array(n * 3)

    this.scope = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, m: 1, q: 0, r: 0, speed: 0 }
    this.fExpr = compileVector([
      build.spec.force?.fx ?? '0', build.spec.force?.fy ?? '0', build.spec.force?.fz ?? '0',
    ] as [string, string, string])
    this.eField = compileVector(build.spec.eField)
    this.bField = compileVector(build.spec.bField)

    this.rk = new Rk4(n * 6, (t, y, out) => this.derivative(t, y, out))
    this.frameObj = {
      t: 0, positions: this.scenePos, velocities: this.sceneVel,
      accelerations: this.sceneAcc, readout: [],
    }
    this.writeScene()
  }

  /** ẏ = [v, F/m] for every particle. */
  private derivative(t: number, y: Float64Array, out: Float64Array): void {
    const { spec } = this.build
    const n = this.bodyCount
    const s = this.scope
    const g = spec.gravity ?? 0
    const drag = spec.drag ?? 0
    const dragQ = spec.dragQuadratic ?? 0
    const spring = spec.spring
    const mutual = spec.mutualGravity ?? 0

    for (let i = 0; i < n; i++) {
      const k = i * 6
      const x = y[k], yy = y[k + 1], z = y[k + 2]
      const vx = y[k + 3], vy = y[k + 4], vz = y[k + 5]

      out[k] = vx; out[k + 1] = vy; out[k + 2] = vz
      if (this.fixed[i]) { out[k + 3] = out[k + 4] = out[k + 5] = 0; continue }

      const m = this.masses[i] || 1
      const q = this.charges[i]
      s.x = x; s.y = yy; s.z = z
      s.vx = vx; s.vy = vy; s.vz = vz
      s.t = t; s.m = m; s.q = q
      s.r = Math.hypot(x, yy, z)
      s.speed = Math.hypot(vx, vy, vz)

      let fx = 0, fy = 0, fz = 0

      if (this.fExpr) {
        fx += this.fExpr[0] ? this.fExpr[0](s) : 0
        fy += this.fExpr[1] ? this.fExpr[1](s) : 0
        fz += this.fExpr[2] ? this.fExpr[2](s) : 0
      }
      if (g) fz -= m * g
      if (drag) { fx -= drag * vx; fy -= drag * vy; fz -= drag * vz }
      if (dragQ && s.speed > 0) {
        const c = dragQ * s.speed
        fx -= c * vx; fy -= c * vy; fz -= c * vz
      }
      if (spring) {
        const a = spring.anchor ?? [0, 0, 0]
        const dx = x - a[0], dy = yy - a[1], dz = z - a[2]
        const len = Math.hypot(dx, dy, dz)
        const rest = spring.restLength ?? 0
        if (len > 1e-9) {
          const f = -spring.k * (len - rest) / len
          fx += f * dx; fy += f * dy; fz += f * dz
        }
      }
      if (q && (this.eField || this.bField)) {
        const E = this.eField ? evalVec(this.eField, s, this.tmpE) : ZERO
        const B = this.bField ? evalVec(this.bField, s, this.tmpB) : ZERO
        // F = q(E + v × B)
        fx += q * (E[0] + vy * B[2] - vz * B[1])
        fy += q * (E[1] + vz * B[0] - vx * B[2])
        fz += q * (E[2] + vx * B[1] - vy * B[0])
      }
      if (mutual) {
        for (let j = 0; j < n; j++) {
          if (j === i) continue
          const jk = j * 6
          const dx = y[jk] - x, dy = y[jk + 1] - yy, dz = y[jk + 2] - z
          const r2 = dx * dx + dy * dy + dz * dz + 1e-6
          const inv = (mutual * m * this.masses[j]) / (r2 * Math.sqrt(r2))
          fx += inv * dx; fy += inv * dy; fz += inv * dz
        }
      }

      out[k + 3] = fx / m
      out[k + 4] = fy / m
      out[k + 5] = fz / m
    }
  }

  step(): void {
    this.t = this.rk.step(this.t, this.state, this.build.dt)
    if (this.build.spec.collisions) {
      resolveCollisions(this.state, this.masses, this.radii, this.fixed,
        this.build.spec.restitution ?? 1)
    }
    this.applyBounds()
    this.writeScene()
  }

  /** Reflective walls. Applied after the step (a "projection" contact model):
   *  cheap, stable, and exact for the elastic case, which is what a teaching
   *  scene needs — a true impulse solver would need collision-time search. */
  private applyBounds(): void {
    const { floor, box, restitution = 1, stopOnFloor, friction = 0 } = this.build.spec
    const n = this.bodyCount
    for (let i = 0; i < n; i++) {
      const k = i * 6
      const rad = this.radii[i]
      if (floor !== undefined && this.state[k + 2] - rad < floor) {
        this.state[k + 2] = floor + rad
        // Rozamiento de Coulomb: el impulso tangencial está ACOTADO por μ·|vn|,
        // nunca invierte el movimiento. Restar μ·|vn| a secas haría que una
        // partícula casi parada saliera rebotando hacia atrás.
        if (friction > 0 && this.state[k + 5] < 0) {
          const budget = friction * Math.abs(this.state[k + 5])
          const vt = Math.hypot(this.state[k + 3], this.state[k + 4])
          if (vt > 0) {
            const scale = Math.max(0, 1 - budget / vt)
            this.state[k + 3] *= scale
            this.state[k + 4] *= scale
          }
        }
        // Only a DESCENDING particle has landed. Without the sign guard a
        // projectile launched from ground level is pinned on its first step,
        // because its centre still sits inside the floor by one radius.
        if (stopOnFloor && this.state[k + 5] <= 0) {
          this.state[k + 3] = this.state[k + 4] = this.state[k + 5] = 0
          this.fixed[i] = true
        } else if (this.state[k + 5] < 0) {
          this.state[k + 5] *= -restitution
        }
      }
      if (box) {
        for (let a = 0; a < 3; a++) {
          const lim = box[a] - rad
          if (this.state[k + a] > lim) {
            this.state[k + a] = lim
            if (this.state[k + 3 + a] > 0) this.state[k + 3 + a] *= -restitution
          } else if (this.state[k + a] < -lim) {
            this.state[k + a] = -lim
            if (this.state[k + 3 + a] < 0) this.state[k + 3 + a] *= -restitution
          }
        }
      }
    }
  }

  private writeScene(): void {
    const vs = this.build.viewScale
    // Reused scratch: this runs every step, and a fresh array per step is
    // exactly the per-frame garbage that shows up as jank on the target box.
    const acc = this.accScratch
    this.derivative(this.t, this.state, acc)
    for (let i = 0; i < this.bodyCount; i++) {
      const k = i * 6, s3 = i * 3
      this.scenePos[s3] = this.state[k] * vs
      this.scenePos[s3 + 1] = this.state[k + 1] * vs
      this.scenePos[s3 + 2] = this.state[k + 2] * vs
      this.sceneVel[s3] = this.state[k + 3]
      this.sceneVel[s3 + 1] = this.state[k + 4]
      this.sceneVel[s3 + 2] = this.state[k + 5]
      this.sceneAcc[s3] = acc[k + 3]
      this.sceneAcc[s3 + 1] = acc[k + 4]
      this.sceneAcc[s3 + 2] = acc[k + 5]
    }
  }

  /** Kinetic energy — the readout that makes a damped oscillator legible. */
  kineticEnergy(): number {
    let e = 0
    for (let i = 0; i < this.bodyCount; i++) {
      const k = i * 6
      e += 0.5 * this.masses[i] * (this.state[k + 3] ** 2 + this.state[k + 4] ** 2 + this.state[k + 5] ** 2)
    }
    return e
  }

  frame(): SimFrame {
    const f = this.frameObj
    f.t = this.t
    const rows: Array<[string, string]> = [
      ['t', `${this.t.toFixed(2)} s`],
      ['E cinética', this.kineticEnergy().toFixed(3)],
    ]
    if (this.build.badExpressions.length) {
      rows.push(['⚠ Expresión inválida', this.build.badExpressions.join(' · ')])
    }
    f.readout = rows
    return f
  }

  reset(): void {
    this.state.set(this.state0)
    this.fixed0.forEach((v, i) => { this.fixed[i] = v })
    this.t = 0
    this.writeScene()
  }
}

const ZERO: Vec3 = [0, 0, 0]

const FALLBACK_COLORS = ['#38d5ff', '#ff5f8f', '#7cff6b', '#ffd700', '#64ffda', '#c8f4ff']
