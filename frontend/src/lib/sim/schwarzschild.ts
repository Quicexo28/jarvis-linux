/** Schwarzschild geometry: the black hole engine's physics.
 *
 *  Geometric units throughout: G = c = 1, lengths in units of M. That puts the
 *  horizon at 2, the photon sphere at 3, the ISCO at 6 and the photon capture
 *  impact parameter at 3√3 — every number on screen is then a pure ratio, which
 *  is what makes a black hole scene comparable across masses.
 *
 *  Orbits are integrated in the BINET form  d²u/dφ² + u = M/L² + 3Mu²  (u = 1/r)
 *  rather than in proper time. Two reasons: the equation is regular where the
 *  radial equation has square-root turning points that trip a naive integrator,
 *  and φ is the natural drawing parameter for a closed-ish curve. The 3Mu² term
 *  IS general relativity — drop it and you get a Newtonian ellipse that never
 *  precesses.
 */

import { Rk4 } from './integrators'

export const HORIZON = 2        // r/M
export const PHOTON_SPHERE = 3
export const ISCO = 6
/** Photon capture impact parameter b_crit = 3√3 M ≈ 5.196 M. */
export const B_CRIT = 3 * Math.sqrt(3)

/* ---------------- Timelike orbits ---------------- */

/** Specific angular momentum² of a bound orbit given semi-latus rectum p (in M)
 *  and eccentricity e — the Darwin relation L² = p²M/(p − 3M − Me²). */
export function angularMomentumSq(p: number, e: number, M = 1): number {
  const denom = p - 3 * M - M * e * e
  return denom > 0 ? (p * p * M) / denom : NaN
}

/** Specific energy² of the same orbit. E < 1 means bound. */
export function energySq(p: number, e: number, M = 1): number {
  const num = (p - 2 * M - 2 * M * e) * (p - 2 * M + 2 * M * e)
  const den = p * (p - 3 * M - M * e * e)
  return den !== 0 ? num / den : NaN
}

/** Perihelion advance per orbit, weak-field formula Δφ = 6πM/p (radians).
 *  Exact to first order in M/p; the integrator below is the ground truth. */
export function precessionPerOrbit(p: number, M = 1): number {
  return (6 * Math.PI * M) / p
}

/** Mercury's famous 43″/century, from orbital elements in SI-ish inputs.
 *  @param aMeters semi-major axis, @param e eccentricity,
 *  @param periodDays orbital period, @param gmOverC2 GM/c² of the central body (m). */
export function precessionArcsecPerCentury(
  aMeters: number, e: number, periodDays: number, gmOverC2: number,
): number {
  const p = aMeters * (1 - e * e)
  const perOrbit = (6 * Math.PI * gmOverC2) / p            // radians
  const orbitsPerCentury = (100 * 365.25) / periodDays
  return perOrbit * orbitsPerCentury * (180 / Math.PI) * 3600
}

export interface OrbitTrace {
  /** Flat xyz triples in the equatorial (xy) plane, in units of M. */
  points: Float32Array
  /** Measured advance of perihelion per radial period (rad). */
  precession: number
  /** True when the particle spiralled through the horizon. */
  captured: boolean
  rMin: number
  rMax: number
}

/** Integrates a bound (or plunging) massive-particle orbit for `turns` radial
 *  periods, starting at perihelion. */
export function traceOrbit(
  p: number, e: number, turns = 3, M = 1, stepsPerTurn = 720,
): OrbitTrace {
  const L2 = angularMomentumSq(p, e, M)
  const captured = !(L2 > 0) || !isFinite(L2)
  const u0 = (1 + e) / p            // start at perihelion r = p/(1+e)
  const state = Float64Array.from([u0, 0])

  // y = [u, du/dφ];  u'' = M/L² + 3Mu² − u
  const rk = new Rk4(2, (_φ, y, out) => {
    out[0] = y[1]
    out[1] = M / L2 + 3 * M * y[0] * y[0] - y[0]
  })

  const total = Math.max(1, Math.round(turns * stepsPerTurn))
  const dφ = (2 * Math.PI * turns) / total
  const pts = new Float32Array((total + 1) * 3)
  let φ = 0
  let rMin = Infinity, rMax = 0
  let hitHorizon = captured
  // Perihelion detection: u is maximal there, so du/dφ changes + → −.
  const perihelia: number[] = [0]
  let prevDu = 0

  for (let i = 0; i <= total; i++) {
    const u = state[0]
    const r = u > 1e-9 ? 1 / u : 1e9
    if (r <= HORIZON * M) { hitHorizon = true }
    rMin = Math.min(rMin, r); rMax = Math.max(rMax, r)
    pts[i * 3] = r * Math.cos(φ)
    pts[i * 3 + 1] = r * Math.sin(φ)
    pts[i * 3 + 2] = 0
    if (i === total || hitHorizon) {
      return {
        points: pts.slice(0, (i + 1) * 3),
        precession: perihelia.length > 1 ? perihelia[perihelia.length - 1] - perihelia[perihelia.length - 2] - 2 * Math.PI : 0,
        captured: hitHorizon, rMin, rMax,
      }
    }
    φ = rk.step(φ, state, dφ)
    if (prevDu > 0 && state[1] <= 0 && i > 2) {
      // Interpolate where du/dφ actually crossed zero. Taking the raw step
      // boundary quantizes the measured precession by dφ, which for a weak-field
      // orbit is the same size as the effect being measured.
      const frac = prevDu / (prevDu - state[1])
      perihelia.push(φ - dφ + frac * dφ)
    }
    prevDu = state[1]
  }

  return { points: pts, precession: 0, captured: hitHorizon, rMin, rMax }
}

/* ---------------- Null geodesics (light bending) ---------------- */

export interface RayTrace {
  /** Flat xyz triples, units of M. */
  points: Float32Array
  /** Total deflection from a straight line (rad). NaN when captured. */
  deflection: number
  captured: boolean
}

/** Traces a photon that comes in from infinity with impact parameter b.
 *
 *  Integrates d²u/dφ² + u = 3Mu² from u = 0 (r = ∞) with du/dφ = 1/b. Below
 *  b_crit = 3√3 M the photon spirals in and the trace stops at the horizon —
 *  that IS the black shadow you see in an image of a black hole. */
export function traceRay(
  b: number, M = 1, maxPhi = 8 * Math.PI, steps = 8000, rMaxDraw = 60,
): RayTrace {
  const state = Float64Array.from([0, 1 / b])
  const rk = new Rk4(2, (_φ, y, out) => {
    out[0] = y[1]
    out[1] = 3 * M * y[0] * y[0] - y[0]
  })
  const dφ = maxPhi / steps
  const pts: number[] = []
  let φ = 0
  let captured = false
  let escapePhi = NaN

  for (let i = 0; i < steps; i++) {
    const u = state[0]
    if (u >= 1 / (HORIZON * M)) { captured = true; break }
    if (u > 1 / rMaxDraw) {
      const r = 1 / u
      pts.push(r * Math.cos(φ), r * Math.sin(φ), 0)
    }
    const uPrev = u
    φ = rk.step(φ, state, dφ)
    if (i > 2 && state[0] <= 0) {
      // Linear interpolation of the u = 0 crossing: without it the reported
      // deflection carries the whole step size as error (dφ ≫ 4M/b for large b).
      const frac = uPrev / (uPrev - state[0])
      escapePhi = φ - dφ + frac * dφ
      break
    }
  }

  return {
    points: Float32Array.from(pts),
    deflection: captured ? NaN : escapePhi - Math.PI,
    captured,
  }
}

/** Light deflection angle for impact parameter b. Weak field → 4M/b. */
export function deflectionAngle(b: number, M = 1): number {
  return traceRay(b, M).deflection
}

/* ---------------- Accretion disk ---------------- */

/** Orbital angular velocity of a circular geodesic, dφ/dt = √(M/r³).
 *  Identical in form to Kepler's — a genuine (and surprising) exact result of
 *  Schwarzschild geometry in coordinate time. */
export function orbitalOmega(r: number, M = 1): number {
  return Math.sqrt(M / (r * r * r))
}

/** Orbital speed measured by a LOCAL static observer, in units of c.
 *  Equals exactly 0.5 c at the ISCO. */
export function orbitalSpeed(r: number, M = 1): number {
  const denom = 1 - (2 * M) / r
  return denom > 0 ? Math.sqrt(M / r) / Math.sqrt(denom) : 1
}

/** Gravitational redshift factor √(1 − 2M/r) for a static emitter. */
export function gravitationalRedshift(r: number, M = 1): number {
  return Math.sqrt(Math.max(0, 1 - (2 * M) / r))
}

/** Combined redshift/beaming factor g = ν_obs/ν_emit for a disk element.
 *  @param cosAngle component of the element's motion toward the observer
 *                  (+1 = straight at you). Observed brightness ∝ g⁴. */
export function dopplerFactor(r: number, cosAngle: number, M = 1): number {
  const v = Math.min(0.999999, orbitalSpeed(r, M))
  const gamma = 1 / Math.sqrt(1 - v * v)
  return gravitationalRedshift(r, M) / (gamma * (1 - v * cosAngle))
}

/** Shakura–Sunyaev thin-disk temperature profile, normalized to peak 1.
 *  T ∝ [r⁻³(1 − √(r_in/r))]^{1/4} — zero at the inner edge, peaks just outside. */
export function diskTemperature(r: number, rIn = ISCO): number {
  if (r <= rIn) return 0
  const raw = Math.pow((1 - Math.sqrt(rIn / r)) / (r * r * r), 0.25)
  // Peak of the profile is at r = (49/36)·r_in.
  const rPeak = (49 / 36) * rIn
  const peak = Math.pow((1 - Math.sqrt(rIn / rPeak)) / (rPeak * rPeak * rPeak), 0.25)
  return raw / peak
}

/** Blackbody colour (sRGB 0–1) for a temperature in Kelvin.
 *  Tanner Helland's fit — cheap, and accurate enough that 3000 K reads orange
 *  and 12000 K reads blue-white, which is the whole point of a disk gradient. */
export function blackbodyRGB(kelvin: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100
  let r: number, g: number, b: number
  if (t <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(t) - 161.1195681661
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592)
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  }
  if (t >= 66) b = 255
  else if (t <= 19) b = 0
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307
  const c = (x: number) => Math.min(1, Math.max(0, x / 255))
  return [c(r), c(g), c(b)]
}

/* ---------------- Lente gravitacional del fondo ---------------- */

/** Deflexión de un rayo nulo SIN acumular la trayectoria.
 *
 *  Misma ecuación y mismo integrador que `traceRay` — lo único que cambia es
 *  que no construye el array de puntos y que el barrido es ADAPTATIVO en vez de
 *  un `maxPhi` fijo: un rayo lejano escapa en poco más de π, mientras que uno
 *  rozando b_crit da varias vueltas. Es lo que hace viable construir la LUT de
 *  la lente (cientos de rayos) en unos pocos milisegundos.
 *
 *  Devuelve NaN si el fotón cae (b ≤ 3√3 M) — ESO es la sombra. */
export function rayDeflection(
  b: number, M = 1, dPhi = 6e-3, phiCap = 24 * Math.PI,
): number {
  if (!(b > B_CRIT * M) || !isFinite(b) || !(M > 0)) return NaN
  const state = Float64Array.from([0, 1 / b])
  const rk = new Rk4(2, (_φ, y, out) => {
    out[0] = y[1]
    out[1] = 3 * M * y[0] * y[0] - y[0]
  })
  const uHor = 1 / (HORIZON * M)
  let φ = 0
  while (φ < phiCap) {
    const uPrev = state[0]
    if (uPrev >= uHor) return NaN
    φ = rk.step(φ, state, dPhi)
    if (φ > 2 * dPhi && state[0] <= 0) {
      // Misma interpolación del cruce u = 0 que traceRay: sin ella el paso
      // entero se cuela como error, y para b grande dφ ≫ 4M/b.
      const frac = uPrev / (uPrev - state[0])
      return φ - dPhi + frac * dPhi - Math.PI
    }
  }
  return NaN
}

/** Tabla de deflexión δ(b), muestreada para que el shader la lea en O(1).
 *
 *  El eje NO es b ni 1/b, sino ln(b/b_crit − 1). Motivo: en el límite de
 *  deflexión fuerte δ ≈ −ln(b/b_crit − 1) + ln(216(7−4√3)) − π, o sea que en
 *  ESTE eje la función es casi una recta, y la interpolación lineal del shader
 *  es entonces casi exacta en toda la zona interesante. Muestrear en b gastaría
 *  la tabla entera en la parte plana y dejaría el anillo de fotones con cuatro
 *  puntos. */
export interface DeflectionLut {
  /** δ en radianes, `size` muestras equiespaciadas en el eje logarítmico. */
  data: Float32Array
  size: number
  /** ln(ε) de la primera y la última muestra, ε = b/b_crit − 1. */
  logMin: number
  logMax: number
  /** b de la última muestra, en unidades de M. */
  bMax: number
  M: number
}

/** Construye la tabla. `epsMin` acota cuánto nos acercamos a b_crit: por debajo
 *  de él δ diverge logarítmicamente, pero ese anillo es de anchura relativa
 *  1e-4 del radio de la sombra — sub-píxel — así que el shader satura ahí sin
 *  que se note. */
export function buildDeflectionLut(
  size = 512, M = 1, epsMin = 1e-4, bMax = 2000, dPhi = 6e-3,
): DeflectionLut {
  // Saneado por delante: una masa 0/negativa o un bMax por debajo de b_crit
  // salen del cálculo como Infinity·0 = NaN, y un NaN en la tabla se ve como un
  // anillo de basura en pantalla. Masa nula = sin agujero = sin deflexión.
  const n = Math.max(2, Math.round(size))
  const mass = isFinite(M) && M > 0 ? M : 0
  const bc = B_CRIT * mass
  const eps0 = isFinite(epsMin) && epsMin > 0 ? epsMin : 1e-4
  const eps1 = mass > 0 && isFinite(bMax) ? Math.max(eps0 * 10, bMax / bc - 1) : eps0 * 10
  const logMin = Math.log(eps0)
  const logMax = Math.log(eps1)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const eps = Math.exp(logMin + ((logMax - logMin) * i) / (n - 1))
    const δ = rayDeflection(bc * (1 + eps), mass, dPhi)
    // Un NaN aquí sólo puede venir de un rayo que no cerró dentro de phiCap.
    // Cae al límite de deflexión fuerte antes que envenenar la textura: una
    // muestra rota se vería como un anillo de basura, no como un fallo.
    const strong = Math.max(0, -Math.log(eps) + 2.7433 - Math.PI)
    data[i] = isFinite(δ) ? δ : (isFinite(strong) ? strong : 0)
  }
  return { data, size: n, logMin, logMax, bMax, M: mass }
}

/** Lectura de la tabla con interpolación lineal. Es la REFERENCIA en CPU de lo
 *  que hace el fragment shader; si uno cambia, el otro también. */
export function lutDeflection(lut: DeflectionLut, b: number): number {
  const bc = B_CRIT * lut.M
  const eps = b / bc - 1
  if (!(eps > 0)) return NaN                       // capturado
  const span = lut.logMax - lut.logMin
  const x = span > 0 ? (Math.log(eps) - lut.logMin) / span : 0
  const f = Math.min(1, Math.max(0, x)) * (lut.size - 1)
  const i = Math.min(lut.size - 2, Math.floor(f))
  const t = f - i
  return lut.data[i] * (1 - t) + lut.data[i + 1] * t
}

/** Parámetro de impacto del rayo que un observador ESTÁTICO en r_obs ve llegar
 *  formando un ángulo ψ con la dirección al agujero: sin ψ = (b/r)√(1 − 2M/r).
 *  Es exacta, y es la que fija el tamaño angular de la sombra. */
export function impactParameter(psi: number, rObs: number, M = 1): number {
  const f = 1 - (2 * M) / rObs
  if (!(f > 0)) return NaN                         // observador dentro del horizonte
  return (rObs * Math.sin(psi)) / Math.sqrt(f)
}

/** Inversa de la anterior: radio angular aparente de un parámetro de impacto b.
 *  NaN si b no cabe en el cielo de ese observador (sin ψ > 1). */
export function apparentAngle(b: number, rObs: number, M = 1): number {
  const f = 1 - (2 * M) / rObs
  if (!(f > 0)) return NaN
  const s = (b * Math.sqrt(f)) / rObs
  return s <= 1 ? Math.asin(s) : NaN
}

/** Radio angular de la SOMBRA vista desde r_obs. Es `apparentAngle(3√3 M)`:
 *  la sombra no es el horizonte (2M) sino el disco de parámetros de impacto
 *  capturados, 2.6 veces más ancho. */
export function shadowAngularRadius(rObs: number, M = 1): number {
  return apparentAngle(B_CRIT * M, rObs, M)
}

/** Cola de deflexión: la parte que al fotón le QUEDA por acumular entre el
 *  observador y el infinito, para un píxel cuyo rayo forma un ángulo χ con la
 *  dirección agujero→cámara.
 *
 *  Hace falta porque δ(b) es la deflexión ∞→∞ y aquí el observador está a
 *  distancia FINITA: recoge el fotón antes de que termine de doblarse. En campo
 *  débil esa cola vale (2M/b)(1 − |cos χ|), y cuando el observador está
 *  justamente en el periastro (|cos χ| = 0) vale δ/2 EXACTAMENTE. El
 *  coeficiente interpola entre esos dos valores con |cos χ|, que es lo que
 *  hace que las dos ramas —rayo entrante y rayo saliente— empalmen sin escalón
 *  y que ninguna diverja cuando b → 0. */
export function deflectionTail(
  cosChi: number, delta: number, b: number, M = 1,
): number {
  if (!(b > 0) || !isFinite(delta)) return 0
  const c = Math.min(1, Math.abs(cosChi))
  const k = c * ((2 * M) / b) + (1 - c) * delta * 0.5
  return (1 - c) * k
}

/** Azimut total Δφ que barre el rayo trazado HACIA ATRÁS desde la cámara hasta
 *  el infinito, para un píxel a ángulo χ de la dirección agujero→cámara
 *  (χ = 0 mira al lado opuesto del agujero, χ = π lo mira a él).
 *
 *  Δφ = χ + δ_efectiva, y δ_efectiva depende de hacia dónde va el rayo:
 *   · saliente (cos χ ≥ 0): sólo acumula la cola — nunca se acerca al agujero.
 *   · entrante (cos χ < 0): acumula la deflexión completa MENOS esa cola.
 *
 *  Con δ = 0 devuelve χ, o sea la identidad: sin masa no hay distorsión, y el
 *  fondo se ve exactamente igual que sin la lente. */
export function lensSweep(chi: number, delta: number, b: number, M = 1): number {
  const cosChi = Math.cos(chi)
  const tail = deflectionTail(cosChi, delta, b, M)
  return chi + (cosChi >= 0 ? tail : Math.max(0, delta - tail))
}

export interface LensPixel {
  /** Parámetro de impacto del rayo de ese píxel, en unidades de M. */
  b: number
  /** El rayo cae al agujero: el píxel es sombra. */
  captured: boolean
  /** Δφ barrido hasta el infinito. NaN si está capturado. */
  sweep: number
}

/** Mapeo completo píxel → cielo, en CPU. Es el espejo del fragment shader de
 *  `BlackHoleLens` en todo el dominio físico (r_obs > 2M), y existe para poder
 *  verificar EN NODE que el borde de la sombra cae en b = 3√3 M y que lejos del
 *  agujero el mapa es la identidad. Si esto y el shader divergen, el shader
 *  está mal.
 *
 *  Única diferencia, y es deliberada: con la cámara dentro del horizonte aquí
 *  se devuelve `captured` (no hay rayo que trazar) mientras que el shader apaga
 *  la lente y deja el cielo sin tocar — una pantalla entera en negro parecería
 *  un cuelgue del visor. */
export function lensPixel(
  chi: number, rObs: number, lut: DeflectionLut, M = 1,
): LensPixel {
  const psi = Math.PI - chi                        // ángulo desde el agujero
  const b = impactParameter(psi, rObs, M)
  // Sólo un rayo que apunta HACIA el agujero (χ > π/2) puede caer en él.
  const ingoing = chi > Math.PI / 2
  if (!isFinite(b) || (ingoing && b <= B_CRIT * M)) {
    return { b, captured: true, sweep: NaN }
  }
  // Fuera de la sombra b > b_crit SIEMPRE en la rama entrante, así que la tabla
  // es válida ahí. En la rama saliente b puede ser cualquier cosa (mirar justo
  // al lado opuesto del agujero da b → 0), y por eso la cola pesa el valor
  // saturado de la tabla con (1 − |cos χ|)², que ahí vale prácticamente cero.
  const raw = lutDeflection(lut, b)
  const delta = isFinite(raw) ? Math.max(0, raw) : lut.data[0]
  return { b, captured: false, sweep: lensSweep(chi, delta, b, M) }
}
