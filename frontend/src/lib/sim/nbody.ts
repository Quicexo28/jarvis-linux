/** Gravitational N-body engine, with an exact-Kepler mode alongside the
 *  integrated one.
 *
 *  Two modes because they answer different questions:
 *    · `kepler`  — every body rides its own analytic ellipse. Zero drift, jumps
 *                  to any DATE, and for the solar preset it evaluates the JPL
 *                  secular rates, so what you see is where the planets are.
 *    · `nbody`   — real mutual attraction, velocity-Verlet. Shows perturbations,
 *                  resonances, three-body chaos, Lagrange points.
 */

import {
  GM_SUN, G_AU, elementsToState, stateToElements, meanMotion, planetElements,
  centuriesSinceJ2000, orbitPolyline, period,
  type OrbitalElements, type PlanetElementRow,
} from './kepler'
import { VelocityVerlet, TrailBuffer } from './integrators'
import type { SimBody, SimEngine, SimFrame } from './types'

export const MAX_BODIES = 64

/* ---------------- Pure force / diagnostic helpers ---------------- */

/** Pairwise Newtonian acceleration with Plummer softening.
 *  `pos`/`out` are flat xyz triples; `mass[i]` matches body i.
 *
 *  Softening is not cosmetic: an unsoftened close pass produces an acceleration
 *  spike that a fixed step cannot resolve, and the pair leaves the scene at
 *  absurd speed ("slingshot of death"). ε turns the singularity into a finite
 *  well without touching the far field. */
export function gravityAccel(
  pos: Float64Array, mass: Float64Array, out: Float64Array,
  G: number, softening = 0, alive?: Uint8Array,
): void {
  const n = mass.length
  out.fill(0)
  const eps2 = softening * softening
  for (let i = 0; i < n; i++) {
    if (alive && !alive[i]) continue
    const ix = i * 3
    for (let j = i + 1; j < n; j++) {
      if (alive && !alive[j]) continue
      const jx = j * 3
      const dx = pos[jx] - pos[ix]
      const dy = pos[jx + 1] - pos[ix + 1]
      const dz = pos[jx + 2] - pos[ix + 2]
      const r2 = dx * dx + dy * dy + dz * dz + eps2
      const inv = 1 / (r2 * Math.sqrt(r2))   // 1/r³
      const gi = G * mass[j] * inv
      const gj = G * mass[i] * inv
      out[ix] += gi * dx; out[ix + 1] += gi * dy; out[ix + 2] += gi * dz
      out[jx] -= gj * dx; out[jx + 1] -= gj * dy; out[jx + 2] -= gj * dz
    }
  }
}

/** Velocidad de la luz en las unidades de trabajo (AU/día). Es la constante que
 *  convierte "newtoniano" en "relativista": todo el término 1PN de abajo es
 *  O(v²/c²), así que sin este número en las unidades correctas la corrección
 *  sale con órdenes de magnitud de diferencia y parece un bug del integrador. */
export const C_AU_DAY = 173.1446326846693

/** Corrección relativista de primer orden post-newtoniano (1PN) respecto a la
 *  masa dominante — el término de Schwarzschild en coordenadas armónicas:
 *
 *      a = (GM / c²r³) · [ (4GM/r − v²) r⃗ + 4 (r⃗·v⃗) v⃗ ]
 *
 *  Esto es lo que hace que Mercurio PRECESE. Sin él la órbita cierra exacta y
 *  el perihelio se queda clavado; con él avanza 6πGM/(c²a(1−e²)) por vuelta,
 *  que son los 43"/siglo que tiraron por tierra la gravedad newtoniana. El test
 *  comprueba ese número contra el valor observado, no contra sí mismo.
 *
 *  `center` es el índice del cuerpo dominante (el Sol). La reacción sobre él se
 *  añade con signo opuesto y escalada por la razón de masas: no es la EIH
 *  completa, pero mantiene el centro de masas quieto — sin eso el sistema
 *  entero deriva despacio y la deriva se confunde con un fallo del paso. */
export function relativisticAccel(
  pos: Float64Array, vel: Float64Array, mass: Float64Array, out: Float64Array,
  G: number, center = 0, c = C_AU_DAY, alive?: Uint8Array,
): void {
  const n = mass.length
  if (n === 0 || center < 0 || center >= n) return
  if (alive && !alive[center]) return
  const GM = G * mass[center]
  const c2 = c * c
  const cx = center * 3
  for (let i = 0; i < n; i++) {
    if (i === center || (alive && !alive[i])) continue
    const ix = i * 3
    const dx = pos[ix] - pos[cx]
    const dy = pos[ix + 1] - pos[cx + 1]
    const dz = pos[ix + 2] - pos[cx + 2]
    const r2 = dx * dx + dy * dy + dz * dz
    if (r2 === 0) continue
    const r = Math.sqrt(r2)
    const vx = vel[ix] - vel[cx]
    const vy = vel[ix + 1] - vel[cx + 1]
    const vz = vel[ix + 2] - vel[cx + 2]
    const v2 = vx * vx + vy * vy + vz * vz
    const rv = dx * vx + dy * vy + dz * vz
    const k = GM / (c2 * r2 * r)
    const radial = 4 * GM / r - v2
    const ax = k * (radial * dx + 4 * rv * vx)
    const ay = k * (radial * dy + 4 * rv * vy)
    const az = k * (radial * dz + 4 * rv * vz)
    out[ix] += ax; out[ix + 1] += ay; out[ix + 2] += az
    const back = mass[i] / mass[center]
    out[cx] -= back * ax; out[cx + 1] -= back * ay; out[cx + 2] -= back * az
  }
}

/** Avance del perihelio por órbita que predice el término 1PN, en radianes.
 *  Forma cerrada — el test la usa como verdad independiente del integrador. */
export function perihelionAdvance(
  GM: number, a: number, e: number, c = C_AU_DAY,
): number {
  return (6 * Math.PI * GM) / (c * c * a * (1 - e * e))
}

/** Un cuerpo achatado y su eje de giro. `j2` es adimensional, `radius` va en
 *  las unidades de longitud del sistema (AU) y `axis` es el eje de rotación
 *  UNITARIO — que no es el z del mundo en cuanto el cuerpo tiene inclinación. */
export interface OblateBody {
  index: number
  j2: number
  radius: number
  axis: [number, number, number]
}

/** Aceleración por achatamiento (armónico zonal J2).
 *
 *  Un planeta no es una masa puntual: gira, se abulta por el ecuador, y ese
 *  bulto ADELANTA el nodo de todo lo que lo orbita. Es la diferencia entre unas
 *  lunas de Júpiter que trazan elipses congeladas y unas cuyos planos rotan de
 *  verdad (J2 de Júpiter = 0.014736, catorce veces el de la Tierra Y sobre un
 *  radio once veces mayor — el término va con J2·R², así que su efecto sobre
 *  una luna cercana es de otro orden: domina la resonancia de Laplace).
 *
 *  En el marco ECUATORIAL del cuerpo, con ẑ = eje de giro y s = (d⃗·ẑ)/r:
 *      a = −(3/2) J2 GM R²/r⁵ · [ (1 − 5s²) d⃗ + 2 s r ẑ ]
 *  que es la forma estándar escrita sin salir de coordenadas del mundo: el
 *  truco de proyectar sobre `axis` en vez de rotar el vector entero evita
 *  construir y aplicar una matriz por par de cuerpos y por paso. */
export function oblatenessAccel(
  pos: Float64Array, mass: Float64Array, out: Float64Array,
  G: number, oblate: OblateBody[], alive?: Uint8Array,
): void {
  const n = mass.length
  for (const ob of oblate) {
    const { index, j2, radius } = ob
    if (!j2 || !radius || index < 0 || index >= n) continue
    if (alive && !alive[index]) continue
    const GM = G * mass[index]
    const bx = index * 3
    const [ux, uy, uz] = ob.axis
    for (let i = 0; i < n; i++) {
      if (i === index || (alive && !alive[i])) continue
      const ix = i * 3
      const dx = pos[ix] - pos[bx]
      const dy = pos[ix + 1] - pos[bx + 1]
      const dz = pos[ix + 2] - pos[bx + 2]
      const r2 = dx * dx + dy * dy + dz * dz
      if (r2 === 0) continue
      const r = Math.sqrt(r2)
      const zc = dx * ux + dy * uy + dz * uz     // altura sobre el ecuador
      const s2 = (zc * zc) / r2
      const k = -1.5 * j2 * GM * radius * radius / (r2 * r2 * r)
      const inPlane = 1 - 5 * s2
      const along = 2 * zc
      out[ix] += k * (inPlane * dx + along * ux)
      out[ix + 1] += k * (inPlane * dy + along * uy)
      out[ix + 2] += k * (inPlane * dz + along * uz)
    }
  }
}

/** Precesión nodal secular que produce J2, en radianes por unidad de tiempo.
 *  dΩ/dt = −(3/2) n J2 (R/a)² cos i / (1−e²)². Verdad independiente para el test. */
export function nodalPrecessionRate(
  n: number, j2: number, R: number, a: number, e: number, incl: number,
): number {
  const p = a * (1 - e * e)
  return -1.5 * n * j2 * (R / p) * (R / p) * Math.cos(incl)
}

/** Total mechanical energy. The conserved quantity we watch to prove the
 *  integrator is behaving — a monotone slope means the step is too big. */
export function totalEnergy(
  pos: Float64Array, vel: Float64Array, mass: Float64Array, G: number, softening = 0,
  alive?: Uint8Array,
): number {
  const n = mass.length
  let kinetic = 0
  for (let i = 0; i < n; i++) {
    if (alive && !alive[i]) continue
    const ix = i * 3
    kinetic += 0.5 * mass[i] * (vel[ix] ** 2 + vel[ix + 1] ** 2 + vel[ix + 2] ** 2)
  }
  let potential = 0
  const eps2 = softening * softening
  for (let i = 0; i < n; i++) {
    if (alive && !alive[i]) continue
    for (let j = i + 1; j < n; j++) {
      if (alive && !alive[j]) continue
      const ix = i * 3, jx = j * 3
      const r = Math.sqrt(
        (pos[jx] - pos[ix]) ** 2 + (pos[jx + 1] - pos[ix + 1]) ** 2 + (pos[jx + 2] - pos[ix + 2]) ** 2 + eps2,
      )
      potential -= (G * mass[i] * mass[j]) / r
    }
  }
  return kinetic + potential
}

/** Total linear momentum (should stay put to round-off under Verlet). */
export function totalMomentum(vel: Float64Array, mass: Float64Array): [number, number, number] {
  let px = 0, py = 0, pz = 0
  for (let i = 0; i < mass.length; i++) {
    px += mass[i] * vel[i * 3]
    py += mass[i] * vel[i * 3 + 1]
    pz += mass[i] * vel[i * 3 + 2]
  }
  return [px, py, pz]
}

/** Total angular momentum about the origin. */
export function angularMomentum(
  pos: Float64Array, vel: Float64Array, mass: Float64Array,
): [number, number, number] {
  let lx = 0, ly = 0, lz = 0
  for (let i = 0; i < mass.length; i++) {
    const k = i * 3, m = mass[i]
    lx += m * (pos[k + 1] * vel[k + 2] - pos[k + 2] * vel[k + 1])
    ly += m * (pos[k + 2] * vel[k] - pos[k] * vel[k + 2])
    lz += m * (pos[k] * vel[k + 1] - pos[k + 1] * vel[k])
  }
  return [lx, ly, lz]
}

/** Center of mass position. */
export function barycenter(pos: Float64Array, mass: Float64Array): [number, number, number] {
  let mx = 0, my = 0, mz = 0, mt = 0
  for (let i = 0; i < mass.length; i++) {
    const k = i * 3, m = mass[i]
    mx += m * pos[k]; my += m * pos[k + 1]; mz += m * pos[k + 2]; mt += m
  }
  return mt ? [mx / mt, my / mt, mz / mt] : [0, 0, 0]
}

/** Removes the net drift so the system stays centered on screen. */
export function zeroMomentum(vel: Float64Array, mass: Float64Array): void {
  const [px, py, pz] = totalMomentum(vel, mass)
  const mt = mass.reduce((a, b) => a + b, 0)
  if (!mt) return
  for (let i = 0; i < mass.length; i++) {
    vel[i * 3] -= px / mt; vel[i * 3 + 1] -= py / mt; vel[i * 3 + 2] -= pz / mt
  }
}

/* ---------------- Radial mapping ---------------- */

/** Optional distance compression for scenes spanning 0.4 → 30 AU.
 *  Linear is the honest default; `log` keeps ordering and direction but NOT
 *  ratios — the HUD says so, because a compressed plot that claims precision
 *  would be a lie. */
export type RadialMode = 'linear' | 'log'

export function mapRadial(
  x: number, y: number, z: number, mode: RadialMode, k = 1,
): [number, number, number] {
  if (mode === 'linear') return [x, y, z]
  const r = Math.hypot(x, y, z)
  if (r < 1e-12) return [0, 0, 0]
  const s = (Math.log1p(r / k) * k) / r
  return [x * s, y * s, z * s]
}

/* ---------------- Engine ---------------- */

/** How a body's position is produced each step. */
type Track =
  | { kind: 'ephemeris'; row: PlanetElementRow }
  | { kind: 'elements'; el: OrbitalElements; n: number; GM: number; center: number }
  | { kind: 'integrated' }
  | { kind: 'static' }

export interface NBodyBuild {
  bodies: SimBody[]
  G: number
  mode: 'kepler' | 'nbody'
  softening: number
  /** Days per simulation time unit is 1 — sim time IS days for orbital presets. */
  startDate: Date
  /** Rows for bodies whose full secular ephemeris is known. */
  rows?: (PlanetElementRow | undefined)[]
  viewScale: number
  radial: RadialMode
  radialK: number
  dt: number
  timeScale: number
  trail: number
  showOrbits: boolean
  title?: string

  /* --- Física opcional. Todo `undefined` = comportamiento newtoniano puro de
     siempre, así que nada de esto puede romper una simulación existente. --- */

  /** Añade el término 1PN respecto a la masa dominante: Mercurio precesa. */
  relativistic?: boolean
  /** Cuerpos achatados que ejercen J2 sobre el resto (Júpiter, la Tierra). */
  oblate?: OblateBody[]
  /** Radio de COLISIÓN por cuerpo, en unidades de simulación (AU). Es el radio
   *  FÍSICO, no el de dibujo — los cuerpos se pintan exagerados a propósito, y
   *  usar el de dibujo haría que los planetas chocaran a un cuarto de UA de
   *  distancia. `undefined` = sin colisiones. */
  collisionRadii?: Float64Array
}

export class NBodyEngine implements SimEngine {
  readonly bodyCount: number
  readonly colors: string[]
  readonly radii: number[]
  readonly names: string[]
  readonly masses: Float64Array

  private readonly pos: Float64Array      // sim units
  private readonly vel: Float64Array
  private readonly pos0: Float64Array
  private readonly vel0: Float64Array
  private readonly scenePos: Float32Array // scene units, handed to the renderer
  private readonly sceneVel: Float32Array
  private readonly tracks: Track[]
  private readonly verlet: VelocityVerlet | null
  private readonly build: NBodyBuild
  /** 1 = el cuerpo sigue existiendo. Una fusión pone a 0 al absorbido y lo
   *  aparca DENTRO del absorbente: el renderer tiene sus buffers dimensionados
   *  al número de cuerpos del arranque, así que quitar uno del array a mitad de
   *  simulación le dejaría los índices desplazados. Muerto ≠ borrado. */
  private readonly alive: Uint8Array
  private merges = 0
  private readonly masses0: Float64Array
  /** Índice del cuerpo dominante — a quién se le aplica el término 1PN. */
  private readonly centerIndex: number
  private t = 0
  private readonly energy0: number
  private energy = 0
  private frameObj: SimFrame

  constructor(build: NBodyBuild) {
    this.build = build
    const bodies = build.bodies.slice(0, MAX_BODIES)
    const n = bodies.length
    this.bodyCount = n
    this.colors = bodies.map((b, i) => b.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length])
    this.radii = bodies.map((b) => b.radius ?? 0.08)
    this.names = bodies.map((b, i) => b.name ?? `m${i + 1}`)
    this.masses = Float64Array.from(bodies.map((b) => b.mass))

    this.pos = new Float64Array(n * 3)
    this.vel = new Float64Array(n * 3)
    bodies.forEach((b, i) => {
      this.pos.set(b.position, i * 3)
      this.vel.set(b.velocity ?? [0, 0, 0], i * 3)
    })

    if (build.mode === 'nbody') {
      // Work in the barycentric frame: otherwise the whole system slides off
      // screen at the net momentum of whatever initial conditions came in.
      zeroMomentum(this.vel, this.masses)
      const bc = barycenter(this.pos, this.masses)
      for (let i = 0; i < n; i++) {
        this.pos[i * 3] -= bc[0]; this.pos[i * 3 + 1] -= bc[1]; this.pos[i * 3 + 2] -= bc[2]
      }
    }

    this.pos0 = this.pos.slice()
    this.vel0 = this.vel.slice()
    this.masses0 = this.masses.slice()
    this.scenePos = new Float32Array(n * 3)
    this.sceneVel = new Float32Array(n * 3)

    this.tracks = bodies.map((b, i) => this.makeTrack(b, i, bodies))
    this.alive = new Uint8Array(n).fill(1)
    let heaviest = 0
    for (let i = 1; i < n; i++) if (this.masses[i] > this.masses[heaviest]) heaviest = i
    this.centerIndex = heaviest

    this.verlet = build.mode === 'nbody'
      ? new VelocityVerlet(n * 3, (p, out) => this.accel(p, out))
      : null

    this.energy0 = build.mode === 'nbody'
      ? totalEnergy(this.pos, this.vel, this.masses, build.G, build.softening, this.alive)
      : 0
    this.energy = this.energy0
    this.frameObj = { t: 0, positions: this.scenePos, velocities: this.sceneVel, readout: [] }
    this.writeScene()
  }

  private makeTrack(body: SimBody, i: number, bodies: SimBody[]): Track {
    const { mode, rows, G } = this.build
    // In nbody mode every body feels gravity — `fixed` is a kepler-mode concept
    // (the central star), because pinning a mass inside Verlet breaks momentum
    // conservation and the diagnostics that depend on it.
    if (mode === 'nbody') return { kind: 'integrated' }
    if (body.fixed) return { kind: 'static' }
    const row = rows?.[i]
    if (row) return { kind: 'ephemeris', row }
    // Fall back to osculating elements about the most massive body.
    let center = 0, best = -Infinity
    bodies.forEach((b, j) => { if (j !== i && b.mass > best) { best = b.mass; center = j } })
    const rel = [0, 1, 2].map((k) => this.pos[i * 3 + k] - this.pos[center * 3 + k])
    const relV = [0, 1, 2].map((k) => this.vel[i * 3 + k] - this.vel[center * 3 + k])
    const GM = G * (bodies[center].mass + body.mass)
    const el = stateToElements(rel, relV, GM)
    return { kind: 'elements', el, n: meanMotion(el.a, GM), GM, center }
  }

  /** Aceleración total: Newton + las correcciones que el spec haya pedido.
   *
   *  OJO con el término 1PN: depende de la VELOCIDAD, y `VelocityVerlet` solo
   *  entrega posiciones a su campo de aceleración (es lo que lo hace
   *  simpléctico). Se lee por tanto `this.vel`, que durante la evaluación va
   *  medio paso desfasada. Es deliberado y es inofensivo: la corrección entera
   *  vale O(v²/c²) ≈ 1e-8 del término newtoniano, así que el error que
   *  introduce ese desfase queda muy por debajo del error de truncamiento del
   *  propio paso. Lo que NO sería inofensivo es perder el carácter simpléctico
   *  del Verlet metiendo un integrador dependiente de la velocidad: la órbita
   *  empezaría a espiralar, que es justo lo que este motor evita. */
  private accel(p: Float64Array, out: Float64Array): void {
    const { G, softening, relativistic, oblate } = this.build
    gravityAccel(p, this.masses, out, G, softening, this.alive)
    if (relativistic) {
      relativisticAccel(p, this.vel, this.masses, out, G, this.centerIndex, C_AU_DAY, this.alive)
    }
    if (oblate && oblate.length) {
      oblatenessAccel(p, this.masses, out, G, oblate, this.alive)
    }
  }

  /** Fusión inelástica perfecta: dos cuerpos que se tocan se convierten en uno.
   *  Se conservan masa y momento (el absorbente hereda el centro de masas y la
   *  velocidad del par), que es exactamente lo que se puede comprobar en un
   *  test — y lo que un choque de verdad hace con el momento angular de giro no
   *  se modela aquí, porque este motor no tiene cuerpos rígidos.
   *
   *  El umbral es la suma de radios FÍSICOS. Sin `collisionRadii` no hay
   *  colisiones: en el sistema solar los planetas no chocan, y un umbral
   *  inventado los haría chocar. */
  private resolveCollisions(): void {
    const radii = this.build.collisionRadii
    if (!radii) return
    const n = this.bodyCount
    for (let i = 0; i < n; i++) {
      if (!this.alive[i]) continue
      for (let j = i + 1; j < n; j++) {
        if (!this.alive[j]) continue
        const ix = i * 3, jx = j * 3
        const dx = this.pos[jx] - this.pos[ix]
        const dy = this.pos[jx + 1] - this.pos[ix + 1]
        const dz = this.pos[jx + 2] - this.pos[ix + 2]
        const touch = (radii[i] ?? 0) + (radii[j] ?? 0)
        if (touch <= 0) continue
        if (dx * dx + dy * dy + dz * dz > touch * touch) continue

        // El más masivo sobrevive; el otro pasa a ser pasajero suyo.
        const [keep, gone] = this.masses[i] >= this.masses[j] ? [i, j] : [j, i]
        const mk = this.masses[keep], mg = this.masses[gone]
        const total = mk + mg
        const kx = keep * 3, gx = gone * 3
        for (let k = 0; k < 3; k++) {
          this.pos[kx + k] = (mk * this.pos[kx + k] + mg * this.pos[gx + k]) / total
          this.vel[kx + k] = (mk * this.vel[kx + k] + mg * this.vel[gx + k]) / total
        }
        this.masses[keep] = total
        this.masses[gone] = 0
        this.alive[gone] = 0
        this.merges++
        // El muerto viaja pegado al absorbente: queda dentro de su esfera de
        // dibujo, así que desaparece de la vista sin tocar los buffers.
        for (let k = 0; k < 3; k++) {
          this.pos[gx + k] = this.pos[kx + k]
          this.vel[gx + k] = this.vel[kx + k]
        }
        this.verlet?.invalidate()
      }
    }
  }

  step(): void {
    const { mode, dt } = this.build
    if (mode === 'nbody' && this.verlet) {
      this.t = this.verlet.step(this.t, this.pos, this.vel, dt)
      this.resolveCollisions()
      // Los pasajeros siguen al absorbente aunque el integrador los moviera.
      if (this.merges > 0) this.parkDead()
    } else {
      this.t += dt
      this.propagateKepler()
    }
    this.writeScene()
  }

  private parkDead(): void {
    for (let i = 0; i < this.bodyCount; i++) {
      if (this.alive[i]) continue
      let host = this.centerIndex
      let best = Infinity
      for (let j = 0; j < this.bodyCount; j++) {
        if (!this.alive[j]) continue
        const dx = this.pos[j * 3] - this.pos[i * 3]
        const dy = this.pos[j * 3 + 1] - this.pos[i * 3 + 1]
        const dz = this.pos[j * 3 + 2] - this.pos[i * 3 + 2]
        const d = dx * dx + dy * dy + dz * dz
        if (d < best) { best = d; host = j }
      }
      for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] = this.pos[host * 3 + k]
        this.vel[i * 3 + k] = this.vel[host * 3 + k]
      }
    }
  }

  private propagateKepler(): void {
    const date = new Date(this.build.startDate.getTime() + this.t * 86400000)
    for (let i = 0; i < this.bodyCount; i++) {
      const tr = this.tracks[i]
      if (tr.kind === 'ephemeris') {
        const el = planetElements(tr.row, centuriesSinceJ2000(date))
        const s = elementsToState(el, GM_SUN)
        this.pos.set(s.position, i * 3)
        this.vel.set(s.velocity, i * 3)
      } else if (tr.kind === 'elements') {
        const s = elementsToState({ ...tr.el, M: tr.el.M + tr.n * this.t }, tr.GM)
        const c = tr.center * 3
        for (let k = 0; k < 3; k++) {
          this.pos[i * 3 + k] = this.pos[c + k] + s.position[k]
          this.vel[i * 3 + k] = this.vel[c + k] + s.velocity[k]
        }
      }
    }
  }

  private writeScene(): void {
    const { viewScale, radial, radialK } = this.build
    for (let i = 0; i < this.bodyCount; i++) {
      const k = i * 3
      const [x, y, z] = mapRadial(this.pos[k], this.pos[k + 1], this.pos[k + 2], radial, radialK)
      this.scenePos[k] = x * viewScale
      this.scenePos[k + 1] = y * viewScale
      this.scenePos[k + 2] = z * viewScale
      this.sceneVel[k] = this.vel[k]
      this.sceneVel[k + 1] = this.vel[k + 1]
      this.sceneVel[k + 2] = this.vel[k + 2]
    }
  }

  frame(): SimFrame {
    const f = this.frameObj
    f.t = this.t
    const date = new Date(this.build.startDate.getTime() + this.t * 86400000)
    const rows: Array<[string, string]> = [
      ['Fecha', date.toISOString().slice(0, 10)],
      ['t', `${this.t.toFixed(1)} d (${(this.t / 365.25).toFixed(2)} a)`],
    ]
    if (this.build.mode === 'nbody') {
      this.energy = totalEnergy(this.pos, this.vel, this.masses, this.build.G, this.build.softening, this.alive)
      const drift = this.energy0 !== 0 ? Math.abs((this.energy - this.energy0) / this.energy0) : 0
      rows.push(['Deriva de energía', `${(drift * 100).toExponential(2)} %`])
      rows.push(['Integrador', `Verlet · dt=${this.build.dt} d`])
      if (this.build.relativistic) rows.push(['Relatividad', '1PN (precesión real)'])
      if (this.build.oblate?.length) rows.push(['Achatamiento', `J2 · ${this.build.oblate.length} cuerpo(s)`])
      if (this.merges > 0) rows.push(['Fusiones', `${this.merges}`])
    } else {
      rows.push(['Modo', 'Kepler analítico (sin deriva)'])
    }
    if (this.build.radial === 'log') rows.push(['Radios', 'comprimidos (log)'])
    f.readout = rows
    return f
  }

  /** Static ellipse per body, in scene units, for the orbit overlay. */
  orbitPaths(): Array<{ points: Float32Array; color: string } | null> {
    if (!this.build.showOrbits) return this.tracks.map(() => null)
    const { viewScale, radial, radialK } = this.build
    return this.tracks.map((tr, i) => {
      let raw: Float32Array | null = null
      let centerIdx = 0
      if (tr.kind === 'ephemeris') {
        raw = orbitPolyline(planetElements(tr.row, centuriesSinceJ2000(this.build.startDate)), 200, GM_SUN)
      } else if (tr.kind === 'elements') {
        raw = orbitPolyline(tr.el, 200, tr.GM)
        centerIdx = tr.center
      } else if (tr.kind === 'integrated') {
        // Osculating ellipse around the dominant mass, recomputed on demand.
        let c = 0, best = -Infinity
        for (let j = 0; j < this.bodyCount; j++) {
          if (j !== i && this.masses[j] > best) { best = this.masses[j]; c = j }
        }
        if (best <= 0 || c === i) return null
        const rel = [0, 1, 2].map((k) => this.pos[i * 3 + k] - this.pos[c * 3 + k])
        const relV = [0, 1, 2].map((k) => this.vel[i * 3 + k] - this.vel[c * 3 + k])
        const GM = this.build.G * (this.masses[c] + this.masses[i])
        const el = stateToElements(rel, relV, GM)
        if (!(el.a > 0) || el.e >= 1) return null
        raw = orbitPolyline(el, 200, GM)
        centerIdx = c
      }
      if (!raw) return null
      const out = new Float32Array(raw.length)
      for (let k = 0; k < raw.length; k += 3) {
        const [x, y, z] = mapRadial(
          raw[k] + this.pos[centerIdx * 3],
          raw[k + 1] + this.pos[centerIdx * 3 + 1],
          raw[k + 2] + this.pos[centerIdx * 3 + 2],
          radial, radialK,
        )
        out[k] = x * viewScale; out[k + 1] = y * viewScale; out[k + 2] = z * viewScale
      }
      return { points: out, color: this.colors[i] }
    })
  }

  /** Orbital period per body in days (for HUD / trail sizing). */
  periods(): number[] {
    return this.tracks.map((tr) => {
      if (tr.kind === 'ephemeris') return period(tr.row.el[0], GM_SUN)
      if (tr.kind === 'elements') return period(tr.el.a, tr.GM)
      return 0
    })
  }

  reset(): void {
    this.pos.set(this.pos0)
    this.vel.set(this.vel0)
    this.masses.set(this.masses0)
    this.alive.fill(1)
    this.merges = 0
    this.t = 0
    this.verlet?.invalidate()
    this.writeScene()
  }
}

export const DEFAULT_COLORS = [
  '#ffd700', '#4b93d1', '#ff8a80', '#64ffda', '#d8a46b',
  '#c8f4ff', '#e3d3a0', '#a3e0e8', '#ff5f8f', '#7cff6b',
]

/** Convenience re-export so callers don't need two imports for AU units. */
export { G_AU, GM_SUN, TrailBuffer }
