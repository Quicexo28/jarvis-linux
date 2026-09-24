/** Two-body (Keplerian) orbital mechanics.
 *
 *  Working units everywhere in this file: AU, days, solar masses. That makes
 *  G = k² with k the Gaussian gravitational constant, and keeps every planetary
 *  number O(1) — no float cancellation on close-in bodies like Mercury.
 *
 *  Why analytic Kepler and not "just integrate it": an ellipse propagated from
 *  elements never drifts, so the viewer can jump to an arbitrary DATE and show
 *  where the planets actually are, and can run for an hour without Mercury
 *  spiralling. Mutual perturbations are the `nbody` mode's job.
 */

/** G in AU³ / (M☉ · day²). */
export const G_AU = 2.959122082855911e-4
/** Standard gravitational parameter of the Sun, same units. */
export const GM_SUN = G_AU

export const DEG = Math.PI / 180

export interface OrbitalElements {
  /** Semi-major axis (AU). */
  a: number
  /** Eccentricity. */
  e: number
  /** Inclination (rad). */
  i: number
  /** Longitude of the ascending node Ω (rad). */
  node: number
  /** Argument of perihelion ω (rad). */
  peri: number
  /** Mean anomaly M at the epoch (rad). */
  M: number
}

/** Wrap to (-π, π]. */
export function wrapPi(x: number): number {
  let v = (x + Math.PI) % (2 * Math.PI)
  if (v < 0) v += 2 * Math.PI
  return v - Math.PI
}

/** Solves M = E − e·sin E for the eccentric anomaly.
 *
 *  Newton with the standard E₀ = M + e·sin M seed. Converges in ≲5 iterations up
 *  to e ≈ 0.9; the iteration cap is a safety net, not the expected exit. */
export function solveKepler(M: number, e: number, tol = 1e-12, maxIter = 60): number {
  const m = wrapPi(M)
  let E = e < 0.8 ? m + e * Math.sin(m) : Math.PI * Math.sign(m || 1)
  for (let k = 0; k < maxIter; k++) {
    const f = E - e * Math.sin(E) - m
    const fp = 1 - e * Math.cos(E)
    const d = f / fp
    E -= d
    if (Math.abs(d) < tol) break
  }
  return E
}

/** Orbital period (days) for a semi-major axis and gravitational parameter. */
export function period(a: number, GM = GM_SUN): number {
  return 2 * Math.PI * Math.sqrt((a * a * a) / GM)
}

/** Mean motion (rad/day). */
export function meanMotion(a: number, GM = GM_SUN): number {
  return Math.sqrt(GM / (a * a * a))
}

export interface StateVector {
  position: [number, number, number]
  velocity: [number, number, number]
}

/** Elements → heliocentric state vector, in the ecliptic frame (z = north). */
export function elementsToState(el: OrbitalElements, GM = GM_SUN): StateVector {
  const { a, e, i, node, peri } = el
  const E = solveKepler(el.M, e)
  const cosE = Math.cos(E), sinE = Math.sin(E)
  const b = a * Math.sqrt(Math.max(0, 1 - e * e))

  // Perifocal plane.
  const xp = a * (cosE - e)
  const yp = b * sinE
  // Ė from differentiating Kepler's equation.
  const Edot = meanMotion(a, GM) / (1 - e * cosE)
  const vxp = -a * sinE * Edot
  const vyp = b * cosE * Edot

  const cw = Math.cos(peri), sw = Math.sin(peri)
  const cO = Math.cos(node), sO = Math.sin(node)
  const ci = Math.cos(i), si = Math.sin(i)

  // Rotation R_z(Ω)·R_x(i)·R_z(ω) applied to the perifocal coordinates.
  const m11 = cw * cO - sw * sO * ci
  const m12 = -sw * cO - cw * sO * ci
  const m21 = cw * sO + sw * cO * ci
  const m22 = -sw * sO + cw * cO * ci
  const m31 = sw * si
  const m32 = cw * si

  return {
    position: [m11 * xp + m12 * yp, m21 * xp + m22 * yp, m31 * xp + m32 * yp],
    velocity: [m11 * vxp + m12 * vyp, m21 * vxp + m22 * vyp, m31 * vxp + m32 * vyp],
  }
}

/** State vector → osculating elements. Used for the HUD and for drawing the
 *  instantaneous ellipse of a body that is actually being N-body integrated. */
export function stateToElements(
  position: readonly number[], velocity: readonly number[], GM = GM_SUN,
): OrbitalElements {
  const [x, y, z] = position
  const [vx, vy, vz] = velocity
  const r = Math.hypot(x, y, z)
  const v2 = vx * vx + vy * vy + vz * vz

  // Specific angular momentum h = r × v.
  const hx = y * vz - z * vy
  const hy = z * vx - x * vz
  const hz = x * vy - y * vx
  const h = Math.hypot(hx, hy, hz)

  const a = 1 / (2 / r - v2 / GM)

  // Eccentricity vector e = (v×h)/μ − r̂.
  const ex = (vy * hz - vz * hy) / GM - x / r
  const ey = (vz * hx - vx * hz) / GM - y / r
  const ez = (vx * hy - vy * hx) / GM - z / r
  const e = Math.hypot(ex, ey, ez)

  const i = Math.acos(Math.min(1, Math.max(-1, hz / h)))

  // Node vector n = ẑ × h.
  const nx = -hy, ny = hx
  const nMag = Math.hypot(nx, ny)
  let node = nMag > 1e-12 ? Math.atan2(ny, nx) : 0

  let peri = 0
  if (nMag > 1e-12 && e > 1e-12) {
    peri = Math.acos(Math.min(1, Math.max(-1, (nx * ex + ny * ey) / (nMag * e))))
    if (ez < 0) peri = 2 * Math.PI - peri
  } else if (e > 1e-12) {
    // Equatorial orbit: measure the perihelion straight from the x axis.
    peri = Math.atan2(ey, ex)
    node = 0
  }

  // True anomaly → eccentric → mean.
  let nu = 0
  if (e > 1e-12) {
    nu = Math.acos(Math.min(1, Math.max(-1, (ex * x + ey * y + ez * z) / (e * r))))
    if (x * vx + y * vy + z * vz < 0) nu = 2 * Math.PI - nu
  } else {
    nu = Math.atan2(y, x) - node - peri
  }
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2))
  const M = wrapPi(E - e * Math.sin(E))

  return { a, e, i, node: wrapPi(node), peri: wrapPi(peri), M }
}

/** Samples one full revolution as a closed polyline (scene-ready xyz triples). */
export function orbitPolyline(el: OrbitalElements, samples = 256, GM = GM_SUN): Float32Array {
  const out = new Float32Array((samples + 1) * 3)
  for (let k = 0; k <= samples; k++) {
    const M = (k / samples) * 2 * Math.PI
    const p = elementsToState({ ...el, M }, GM).position
    out[k * 3] = p[0]; out[k * 3 + 1] = p[1]; out[k * 3 + 2] = p[2]
  }
  return out
}

/* ---------------- Dates ---------------- */

export const J2000_JD = 2451545.0

/** Julian Date from a JS Date (UTC). Good to well under a second, which is
 *  ~1000× finer than the elements below deserve. */
export function julianDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}

/** Julian centuries since J2000 — the argument the secular rates expect. */
export function centuriesSinceJ2000(date: Date): number {
  return (julianDate(date) - J2000_JD) / 36525
}

/* ---------------- Planetary elements (JPL / Standish) ---------------- */

/** Keplerian elements and their per-century rates, valid 1800–2050.
 *  Order: a(AU), e, I(deg), L(deg), ϖ(deg), Ω(deg) — L is the MEAN LONGITUDE and
 *  ϖ the LONGITUDE OF PERIHELION, so ω = ϖ − Ω and M = L − ϖ. */
export interface PlanetElementRow {
  name: string
  /** Mass in solar masses. */
  mass: number
  /** Equatorial radius, km — HUD only. */
  radiusKm: number
  color: string
  el: [number, number, number, number, number, number]
  rate: [number, number, number, number, number, number]
}

export const PLANETS: PlanetElementRow[] = [
  {
    name: 'Mercurio', mass: 1.6601e-7, radiusKm: 2439.7, color: '#b8b0a4',
    el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  {
    name: 'Venus', mass: 2.4478e-6, radiusKm: 6051.8, color: '#e8cda2',
    el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  },
  {
    name: 'Tierra', mass: 3.0404e-6, radiusKm: 6371.0, color: '#4b93d1',
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  },
  {
    name: 'Marte', mass: 3.2272e-7, radiusKm: 3389.5, color: '#c1440e',
    el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  {
    name: 'Júpiter', mass: 9.5479e-4, radiusKm: 69911, color: '#d8a46b',
    el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  {
    name: 'Saturno', mass: 2.8588e-4, radiusKm: 58232, color: '#e3d3a0',
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
  {
    name: 'Urano', mass: 4.3662e-5, radiusKm: 25362, color: '#a3e0e8',
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  },
  {
    name: 'Neptuno', mass: 5.1514e-5, radiusKm: 24622, color: '#4166f5',
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  },
]

/** Elements of one planet at a given epoch (T = Julian centuries since J2000). */
export function planetElements(row: PlanetElementRow, T: number): OrbitalElements {
  const a = row.el[0] + row.rate[0] * T
  const e = row.el[1] + row.rate[1] * T
  const i = (row.el[2] + row.rate[2] * T) * DEG
  const L = (row.el[3] + row.rate[3] * T) * DEG
  const varpi = (row.el[4] + row.rate[4] * T) * DEG
  const node = (row.el[5] + row.rate[5] * T) * DEG
  return { a, e, i, node, peri: wrapPi(varpi - node), M: wrapPi(L - varpi) }
}

/** Heliocentric state of one planet at a date. */
export function planetState(row: PlanetElementRow, date: Date): StateVector {
  return elementsToState(planetElements(row, centuriesSinceJ2000(date)), GM_SUN)
}
