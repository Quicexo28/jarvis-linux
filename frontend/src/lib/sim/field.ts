/** Vector fields: arrows, streamlines and tracer particles.
 *
 *  This is the "vectors" half of the physics ask. The field itself is static
 *  data (arrows on a lattice), but the TRACERS are integrated, so a dipole or a
 *  vortex is something you watch rather than something you read.
 */

import { Rk4 } from './integrators'
import { compileScalar } from './dynamics'
import type { FieldSpec, SimCommon, SimEngine, SimFrame, Vec3 } from './types'

export const MAX_ARROWS = 2200
export const MAX_TRACERS = 400

interface FieldScope {
  x: number; y: number; z: number; t: number; r: number
  [k: string]: number
}

export interface FieldSample {
  /** Arrow tail positions, flat xyz. */
  origins: Float32Array
  /** Field vector at each origin, flat xyz (unnormalized). */
  vectors: Float32Array
  /** |F| per arrow. */
  magnitudes: Float32Array
  maxMagnitude: number
}

/** Field presets — the canonical pictures from an E&M or fluids course. */
export function fieldPreset(name: string): Partial<FieldSpec> & { title: string } {
  switch (name) {
    case 'dipole':
      // Two opposite charges on the x axis: the textbook E field.
      return {
        title: 'Campo de un dipolo eléctrico',
        fx: '(x-1)/((x-1)^2+y^2+z^2)^1.5 - (x+1)/((x+1)^2+y^2+z^2)^1.5',
        fy: 'y/((x-1)^2+y^2+z^2)^1.5 - y/((x+1)^2+y^2+z^2)^1.5',
        fz: 'z/((x-1)^2+y^2+z^2)^1.5 - z/((x+1)^2+y^2+z^2)^1.5',
        extent: 4, plane: 'xy', streamlines: 24, tracers: 120,
      }
    case 'vortex':
      return {
        title: 'Vórtice (campo rotacional)',
        fx: '-y', fy: 'x', fz: '-0.15*z',
        extent: 4, tracers: 200, streamlines: 18,
      }
    case 'source':
      return {
        title: 'Fuente radial (divergencia positiva)',
        fx: 'x/(r+0.4)', fy: 'y/(r+0.4)', fz: 'z/(r+0.4)',
        extent: 4, tracers: 160, streamlines: 20,
      }
    case 'wire':
      // B around a current-carrying wire along z: circles, falling as 1/ρ.
      return {
        title: 'Campo magnético de un hilo (B ∝ 1/ρ)',
        fx: '-y/(x^2+y^2+0.05)', fy: 'x/(x^2+y^2+0.05)', fz: '0',
        extent: 4, tracers: 180, streamlines: 16,
      }
    case 'saddle':
      return {
        title: 'Punto de silla', fx: 'x', fy: '-y', fz: '0',
        extent: 4, plane: 'xy', tracers: 140, streamlines: 22,
      }
    case 'wave':
      return {
        title: 'Onda viajera (campo dependiente del tiempo)',
        fx: '0', fy: '0', fz: 'sin(x - 2*t) * exp(-0.08*(y^2))',
        extent: 5, plane: 'xy', tracers: 0,
      }
    default:
      return fieldPreset('dipole')
  }
}

export interface FieldBuild {
  fx: string; fy: string; fz: string
  extent: number
  density: number
  plane?: 'xy' | 'xz' | 'yz'
  tracers: number
  streamlines: number
  colorByMagnitude: boolean
  dt: number
  timeScale: number
  trail: number
  viewScale: number
  title: string
  timeDependent: boolean
}

export function buildField(spec: FieldSpec & SimCommon): FieldBuild {
  // An explicit preset always seeds the defaults; with neither preset nor fx
  // there is nothing to draw, so fall back to the dipole.
  const presetName = spec.preset ?? (spec.fx || spec.fy || spec.fz ? undefined : 'dipole')
  const base = presetName ? fieldPreset(presetName) : null
  const src = { ...(base ?? {}), ...spec }
  const fx = src.fx ?? '0', fy = src.fy ?? '0', fz = src.fz ?? '0'
  const density = Math.max(2, Math.min(12, src.density ?? 7))
  return {
    fx, fy, fz,
    extent: src.extent ?? 4,
    density,
    plane: src.plane,
    tracers: Math.min(MAX_TRACERS, src.tracers ?? 0),
    streamlines: src.streamlines ?? 0,
    colorByMagnitude: src.colorByMagnitude ?? true,
    dt: spec.dt ?? 0.01,
    timeScale: spec.timeScale ?? 1,
    trail: spec.trail === false ? 0 : (spec.trail ?? 160),
    viewScale: spec.viewScale ?? 1,
    title: base?.title ?? 'Campo vectorial',
    timeDependent: /\bt\b/.test(`${fx} ${fy} ${fz}`),
  }
}

/** Compiled field evaluator, reused by arrows, streamlines and tracers. */
export class VectorField {
  private readonly cx: ReturnType<typeof compileScalar>
  private readonly cy: ReturnType<typeof compileScalar>
  private readonly cz: ReturnType<typeof compileScalar>
  private readonly scope: FieldScope = { x: 0, y: 0, z: 0, t: 0, r: 0 }
  readonly valid: boolean

  constructor(fx: string, fy: string, fz: string) {
    this.cx = compileScalar(fx)
    this.cy = compileScalar(fy)
    this.cz = compileScalar(fz)
    this.valid = !!(this.cx || this.cy || this.cz)
  }

  at(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    const s = this.scope
    s.x = x; s.y = y; s.z = z; s.t = t; s.r = Math.hypot(x, y, z)
    out[0] = this.cx ? this.cx(s as never) : 0
    out[1] = this.cy ? this.cy(s as never) : 0
    out[2] = this.cz ? this.cz(s as never) : 0
    return out
  }
}

/** Samples the field on a lattice (or one plane slice of it). */
export function sampleField(
  field: VectorField, extent: number, density: number,
  plane: 'xy' | 'xz' | 'yz' | undefined, t: number,
): FieldSample {
  const n = Math.max(2, density)
  const layers = plane ? 1 : n
  const count = Math.min(MAX_ARROWS, n * n * layers)
  const origins = new Float32Array(count * 3)
  const vectors = new Float32Array(count * 3)
  const magnitudes = new Float32Array(count)
  const step = (2 * extent) / (n - 1)
  const tmp: Vec3 = [0, 0, 0]
  let idx = 0
  let maxMag = 0

  for (let a = 0; a < n && idx < count; a++) {
    for (let b = 0; b < n && idx < count; b++) {
      for (let c = 0; c < layers && idx < count; c++) {
        const u = -extent + a * step
        const v = -extent + b * step
        const w = plane ? 0 : -extent + c * step
        let x: number, y: number, z: number
        if (plane === 'xy') { x = u; y = v; z = 0 }
        else if (plane === 'xz') { x = u; y = 0; z = v }
        else if (plane === 'yz') { x = 0; y = u; z = v }
        else { x = u; y = v; z = w }

        field.at(x, y, z, t, tmp)
        const mag = Math.hypot(tmp[0], tmp[1], tmp[2])
        if (!isFinite(mag)) continue
        const k = idx * 3
        origins[k] = x; origins[k + 1] = y; origins[k + 2] = z
        vectors[k] = tmp[0]; vectors[k + 1] = tmp[1]; vectors[k + 2] = tmp[2]
        magnitudes[idx] = mag
        if (mag > maxMag) maxMag = mag
        idx++
      }
    }
  }

  return {
    origins: origins.subarray(0, idx * 3),
    vectors: vectors.subarray(0, idx * 3),
    magnitudes: magnitudes.subarray(0, idx),
    maxMagnitude: maxMag || 1,
  }
}

/** Integral curve of the field through a seed point — a streamline.
 *  Arc-length normalized so the step is geometric, not magnitude-dependent
 *  (otherwise a strong region eats the whole budget in three steps). */
export function streamline(
  field: VectorField, seed: Vec3, steps = 220, h = 0.06, t = 0, extent = Infinity,
): Float32Array {
  const pts = new Float32Array((steps + 1) * 3)
  const state = Float64Array.from(seed)
  const v: Vec3 = [0, 0, 0]
  let dead = false
  // Arc-length parameterized ODE ẋ = F/|F|, integrated with RK4. Euler here
  // looks fine on a straight field and silently spirals OUTWARD on a closed
  // one — a vortex streamline would not close.
  const rk = new Rk4(3, (tt, y, out) => {
    field.at(y[0], y[1], y[2], tt, v)
    const mag = Math.hypot(v[0], v[1], v[2])
    if (!isFinite(mag) || mag < 1e-12) { out[0] = out[1] = out[2] = 0; dead = true; return }
    out[0] = v[0] / mag; out[1] = v[1] / mag; out[2] = v[2] / mag
  })
  let n = 0
  for (let i = 0; i <= steps; i++) {
    pts[n * 3] = state[0]; pts[n * 3 + 1] = state[1]; pts[n * 3 + 2] = state[2]
    n++
    dead = false
    rk.step(t, state, h)
    if (dead) break
    if (Math.abs(state[0]) > extent * 1.6 || Math.abs(state[1]) > extent * 1.6 || Math.abs(state[2]) > extent * 1.6) break
  }
  return pts.subarray(0, n * 3)
}

/** Tracers advected by the field: ẋ = F(x, t). */
export class FieldEngine implements SimEngine {
  readonly bodyCount: number
  readonly colors: string[]
  readonly radii: number[]
  readonly names: string[]
  readonly field: VectorField
  readonly build: FieldBuild

  private readonly state: Float64Array
  private readonly state0: Float64Array
  private readonly scenePos: Float32Array
  private readonly sceneVel: Float32Array
  private readonly rk: Rk4
  private readonly tmp: Vec3 = [0, 0, 0]
  private t = 0
  private frameObj: SimFrame

  constructor(build: FieldBuild) {
    this.build = build
    this.field = new VectorField(build.fx, build.fy, build.fz)
    const n = build.tracers
    this.bodyCount = n
    this.colors = new Array(n).fill('#64ffda')
    this.radii = new Array(n).fill(0.045)
    this.names = Array.from({ length: n }, (_, i) => `t${i + 1}`)

    this.state = new Float64Array(n * 3)
    const rnd = seeded(1337)
    for (let i = 0; i < n; i++) {
      const e = build.extent * 0.92
      this.state[i * 3] = (rnd() * 2 - 1) * e
      this.state[i * 3 + 1] = (rnd() * 2 - 1) * e
      this.state[i * 3 + 2] = build.plane ? 0 : (rnd() * 2 - 1) * e
    }
    this.state0 = this.state.slice()
    this.scenePos = new Float32Array(n * 3)
    this.sceneVel = new Float32Array(n * 3)

    this.rk = new Rk4(n * 3, (t, y, out) => {
      for (let i = 0; i < n; i++) {
        const k = i * 3
        this.field.at(y[k], y[k + 1], y[k + 2], t, this.tmp)
        // Cap the advection speed: a 1/r² field near its singularity would
        // otherwise fling every tracer out of the box in a single step.
        const mag = Math.hypot(this.tmp[0], this.tmp[1], this.tmp[2])
        const s = mag > 8 ? 8 / mag : 1
        out[k] = this.tmp[0] * s
        out[k + 1] = this.tmp[1] * s
        out[k + 2] = this.tmp[2] * s
      }
    })
    this.frameObj = { t: 0, positions: this.scenePos, velocities: this.sceneVel, readout: [] }
    this.writeScene()
  }

  step(): void {
    if (this.bodyCount) this.t = this.rk.step(this.t, this.state, this.build.dt)
    else this.t += this.build.dt
    this.recycle()
    this.writeScene()
  }

  /** Tracers that leave the box are respawned, so the picture never empties. */
  private recycle(): void {
    const lim = this.build.extent * 1.25
    const rnd = Math.random
    for (let i = 0; i < this.bodyCount; i++) {
      const k = i * 3
      if (Math.abs(this.state[k]) > lim || Math.abs(this.state[k + 1]) > lim || Math.abs(this.state[k + 2]) > lim) {
        const e = this.build.extent * 0.9
        this.state[k] = (rnd() * 2 - 1) * e
        this.state[k + 1] = (rnd() * 2 - 1) * e
        this.state[k + 2] = this.build.plane ? 0 : (rnd() * 2 - 1) * e
      }
    }
  }

  private writeScene(): void {
    const vs = this.build.viewScale
    for (let i = 0; i < this.bodyCount; i++) {
      const k = i * 3
      this.scenePos[k] = this.state[k] * vs
      this.scenePos[k + 1] = this.state[k + 1] * vs
      this.scenePos[k + 2] = this.state[k + 2] * vs
      this.field.at(this.state[k], this.state[k + 1], this.state[k + 2], this.t, this.tmp)
      this.sceneVel[k] = this.tmp[0]
      this.sceneVel[k + 1] = this.tmp[1]
      this.sceneVel[k + 2] = this.tmp[2]
    }
  }

  /** Arrows for the current time (recomputed only when the field moves). */
  sample(): FieldSample {
    return sampleField(this.field, this.build.extent, this.build.density, this.build.plane, this.t)
  }

  /** |F| en cada vértice de una línea de campo.
   *
   *  Es lo que permite COLOREARLA: una línea de campo de color plano dice por
   *  dónde va el campo pero no cuánto vale, y en un dipolo el contraste entre
   *  el centro y el borde son dos órdenes de magnitud. Se devuelve el valor
   *  CRUDO y el renderer lo normaliza contra `sample().maxMagnitude`, para que
   *  la rampa de color viva en un solo sitio y todas las líneas compartan
   *  escala — normalizar cada línea por su propio máximo haría que la más
   *  débil se pintara igual de intensa que la más fuerte.
   *
   *  Se evalúa en t = 0, igual que la geometría de la línea: son estáticas por
   *  construcción (una foto del campo), así que seguir el tiempo aquí pintaría
   *  magnitudes de un instante distinto al del trazado. */
  streamlineMagnitudes(points: Float32Array): Float32Array {
    const n = Math.floor(points.length / 3)
    const out = new Float32Array(n)
    const v: Vec3 = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      this.field.at(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], 0, v)
      out[i] = Math.hypot(v[0], v[1], v[2])
    }
    return out
  }

  streamlines(): Float32Array[] {
    const out: Float32Array[] = []
    const count = this.build.streamlines
    if (!count) return out
    const rnd = seeded(99)
    for (let i = 0; i < count; i++) {
      const e = this.build.extent * 0.85
      const seed: Vec3 = [
        (rnd() * 2 - 1) * e,
        (rnd() * 2 - 1) * e,
        this.build.plane ? 0 : (rnd() * 2 - 1) * e,
      ]
      out.push(streamline(this.field, seed, 220, this.build.extent / 60, this.t, this.build.extent))
    }
    return out
  }

  frame(): SimFrame {
    const f = this.frameObj
    f.t = this.t
    f.readout = [
      ['t', this.t.toFixed(2)],
      ['Campo', `(${this.build.fx}, ${this.build.fy}, ${this.build.fz})`],
      ['Trazadores', String(this.bodyCount)],
    ]
    if (!this.field.valid) f.readout.push(['⚠', 'Campo inválido'])
    return f
  }

  reset(): void {
    this.state.set(this.state0)
    this.t = 0
    this.writeScene()
  }
}

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
