/**
 * Analytic geometry sampling — curves, function graphs, planes, vector spans.
 * Pure math (mathjs only, no Three.js/DOM) so it is testable in Node.
 * All outputs are MATH coordinates (z up); the viewer maps them to scene space.
 */

import { create, all } from 'mathjs'

const math = create(all)

/** Symbols mathjs resolves itself — not free variables of an expression. */
const KNOWN_CONSTANTS = new Set(['pi', 'PI', 'e', 'E', 'tau', 'phi', 'i', 'Infinity', 'NaN'])

/** Free variable names in a mathjs expression (function names and constants excluded). */
export function freeSymbols(expr: string): Set<string> {
  const names = new Set<string>()
  math.parse(expr).filter((node: any, path: string | null) => {
    if (node.isSymbolNode && path !== 'fn' && !KNOWN_CONSTANTS.has(node.name)) {
      names.add(node.name)
    }
    return false
  })
  return names
}

export interface CurveSpec {
  /** mathjs expressions in t */
  x: string
  y: string
  z?: string
  tRange: [number, number]
  samples?: number
}

/**
 * Sample a parametric curve, splitting into polyline segments at
 * non-finite points and at jumps (discontinuities like tan(t) asymptotes).
 * Each segment is a flat [x0,y0,z0, x1,y1,z1, ...] array with ≥ 2 points.
 */
export function sampleCurve3D(spec: CurveSpec): Float32Array[] {
  const n = Math.min(1024, Math.max(16, spec.samples ?? 240))
  const [t0, t1] = spec.tRange
  const ex = math.compile(spec.x)
  const ey = math.compile(spec.y)
  const ez = math.compile(spec.z ?? '0')

  const pts: ([number, number, number] | null)[] = []
  for (let i = 0; i <= n; i++) {
    const t = t0 + (i / n) * (t1 - t0)
    const scope = { t, x: t } // allow f(x)-style expressions too
    const px = Number(ex.evaluate(scope))
    const py = Number(ey.evaluate(scope))
    const pz = Number(ez.evaluate(scope))
    pts.push(isFinite(px) && isFinite(py) && isFinite(pz) ? [px, py, pz] : null)
  }

  // Median step between consecutive valid points → jump threshold.
  const steps: number[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    if (a && b) steps.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))
  }
  steps.sort((a, b) => a - b)
  const median = steps.length ? steps[Math.floor(steps.length / 2)] : 0
  const jumpThr = median > 0 ? median * 12 : Infinity

  const segments: Float32Array[] = []
  let current: number[] = []
  const flush = () => {
    if (current.length >= 6) segments.push(new Float32Array(current))
    current = []
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!p) { flush(); continue }
    if (current.length >= 3) {
      const dx = p[0] - current[current.length - 3]
      const dy = p[1] - current[current.length - 2]
      const dz = p[2] - current[current.length - 1]
      if (Math.hypot(dx, dy, dz) > jumpThr) flush()
    }
    current.push(p[0], p[1], p[2])
  }
  flush()
  return segments
}

/** y = f(x) as a planar curve in the z=0 plane (math coords). The evaluation
 *  scope exposes both t and x (aliased), so f may be written in x directly. */
export function sampleGraph1D(f: string, xRange: [number, number], samples?: number): Float32Array[] {
  return sampleCurve3D({ x: 't', y: f, tRange: xRange, samples })
}

export interface SampledSurface {
  /** [x,y,f(x,y)] triples, u-major */
  positions: Float32Array
  indices: Uint32Array
  segments: number
}

/** z = f(x,y) surface over a rectangle. Non-finite values clamp to 0. */
export function sampleSurface(
  f: string,
  xRange: [number, number],
  yRange: [number, number],
  segments = 56,
): SampledSurface {
  const seg = Math.min(120, Math.max(8, segments))
  const N = seg + 1
  const expr = math.compile(f)
  const positions = new Float32Array(N * N * 3)
  for (let i = 0; i <= seg; i++) {
    const x = xRange[0] + (i / seg) * (xRange[1] - xRange[0])
    for (let j = 0; j <= seg; j++) {
      const y = yRange[0] + (j / seg) * (yRange[1] - yRange[0])
      let z = Number(expr.evaluate({ x, y }))
      if (!isFinite(z)) z = 0
      const base = (i * N + j) * 3
      positions[base] = x
      positions[base + 1] = y
      positions[base + 2] = z
    }
  }
  const indices = new Uint32Array(seg * seg * 6)
  let idx = 0
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * N + j
      const b = a + 1
      const c = (i + 1) * N + j
      const d = c + 1
      indices[idx++] = a; indices[idx++] = b; indices[idx++] = d
      indices[idx++] = a; indices[idx++] = d; indices[idx++] = c
    }
  }
  return { positions, indices, segments: seg }
}

type Vec3 = [number, number, number]

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])
const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const normalize = (v: Vec3): Vec3 => {
  const n = norm(v)
  return n < 1e-12 ? [0, 0, 1] : scale(v, 1 / n)
}

/** Orthonormal basis {u, v} of the plane with the given normal. */
export function planeBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal)
  // pick the world axis least aligned with n to seed the cross product
  const ax: Vec3 = Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2])
    ? [1, 0, 0]
    : Math.abs(n[1]) <= Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1]
  const u = normalize(cross(n, ax))
  const v = normalize(cross(n, u))
  return { u, v }
}

export interface FittedPlane {
  /** Unit normal of the plane. */
  normal: Vec3
  /** Centroid of the input points — the plane passes through it. */
  centroid: Vec3
  /** Orthonormal in-plane basis. */
  u: Vec3
  v: Vec3
  /** RMS distance of the points to the plane, in input units. 0 = exactly coplanar. */
  rms: number
}

/**
 * Least-squares plane through a point cloud.
 *
 * Uses the covariance-determinant method (no eigen solver): the largest of the
 * three axis determinants picks the best-conditioned formulation, which is what
 * keeps a nearly axis-aligned cloud from producing a garbage normal.
 *
 * Fewer than 3 points has no plane; the fallback normal is +z so callers get a
 * usable basis instead of NaN.
 */
export function bestFitPlane(points: Vec3[]): FittedPlane {
  const n = points.length
  const centroid: Vec3 = [0, 0, 0]
  for (const p of points) {
    centroid[0] += p[0]; centroid[1] += p[1]; centroid[2] += p[2]
  }
  if (n > 0) {
    centroid[0] /= n; centroid[1] /= n; centroid[2] /= n
  }

  if (n < 3) {
    const normal: Vec3 = [0, 0, 1]
    return { normal, centroid, ...planeBasis(normal), rms: 0 }
  }

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (const p of points) {
    const rx = p[0] - centroid[0]
    const ry = p[1] - centroid[1]
    const rz = p[2] - centroid[2]
    xx += rx * rx; xy += rx * ry; xz += rx * rz
    yy += ry * ry; yz += ry * rz; zz += rz * rz
  }

  const detX = yy * zz - yz * yz
  const detY = xx * zz - xz * xz
  const detZ = xx * yy - xy * xy
  const detMax = Math.max(detX, detY, detZ)

  let normal: Vec3
  if (detMax <= 0) {
    // Degenerate: all points collinear or coincident — no plane is determined.
    normal = [0, 0, 1]
  } else if (detMax === detX) {
    normal = [detX, xz * yz - xy * zz, xy * yz - xz * yy]
  } else if (detMax === detY) {
    normal = [xz * yz - xy * zz, detY, xy * xz - yz * xx]
  } else {
    normal = [xy * yz - xz * yy, xy * xz - yz * xx, detZ]
  }
  normal = normalize(normal)

  let sq = 0
  for (const p of points) {
    const d = (p[0] - centroid[0]) * normal[0]
      + (p[1] - centroid[1]) * normal[1]
      + (p[2] - centroid[2]) * normal[2]
    sq += d * d
  }

  return { normal, centroid, ...planeBasis(normal), rms: Math.sqrt(sq / n) }
}

/** (u, v) coordinates of a point in the plane's basis, relative to its centroid. */
export function toPlaneCoords(p: Vec3, plane: FittedPlane): [number, number] {
  const rx = p[0] - plane.centroid[0]
  const ry = p[1] - plane.centroid[1]
  const rz = p[2] - plane.centroid[2]
  return [
    rx * plane.u[0] + ry * plane.u[1] + rz * plane.u[2],
    rx * plane.v[0] + ry * plane.v[1] + rz * plane.v[2],
  ]
}

/**
 * Sort points into a non-self-intersecting ring: angular order around the
 * centroid, measured in the plane's own basis. Without this a quadrilateral
 * built from four fingertips comes out as a bow tie whenever the tips are
 * listed in anatomical rather than geometric order.
 */
export function orderOnPlane(points: Vec3[], plane: FittedPlane): Vec3[] {
  return points
    .map((p) => {
      const [pu, pv] = toPlaneCoords(p, plane)
      return { p, a: Math.atan2(pv, pu) }
    })
    .sort((l, r) => l.a - r.a)
    .map((e) => e.p)
}

/** Drop every point onto the plane along its normal — flattens a warped polygon. */
export function projectToPlane(points: Vec3[], plane: FittedPlane): Vec3[] {
  return points.map((p) => {
    const d = (p[0] - plane.centroid[0]) * plane.normal[0]
      + (p[1] - plane.centroid[1]) * plane.normal[1]
      + (p[2] - plane.centroid[2]) * plane.normal[2]
    return [
      p[0] - d * plane.normal[0],
      p[1] - d * plane.normal[1],
      p[2] - d * plane.normal[2],
    ] as Vec3
  })
}

/**
 * Grid lines of the lattice { a·v1 + b·v2 } for a,b ∈ [-extent, extent] —
 * visualizes span(v1, v2) as a ruled plane through the origin.
 * Returns flat line-segment endpoints [x0,y0,z0,x1,y1,z1, ...].
 */
export function spanLatticeLines(v1: Vec3, v2: Vec3, extent = 3, origin: Vec3 = [0, 0, 0]): Float32Array {
  const out: number[] = []
  for (let k = -extent; k <= extent; k++) {
    // lines parallel to v1 at offsets k·v2, and parallel to v2 at offsets k·v1
    const a0 = [
      origin[0] + k * v2[0] - extent * v1[0],
      origin[1] + k * v2[1] - extent * v1[1],
      origin[2] + k * v2[2] - extent * v1[2],
    ]
    const a1 = [
      origin[0] + k * v2[0] + extent * v1[0],
      origin[1] + k * v2[1] + extent * v1[1],
      origin[2] + k * v2[2] + extent * v1[2],
    ]
    const b0 = [
      origin[0] + k * v1[0] - extent * v2[0],
      origin[1] + k * v1[1] - extent * v2[1],
      origin[2] + k * v1[2] - extent * v2[2],
    ]
    const b1 = [
      origin[0] + k * v1[0] + extent * v2[0],
      origin[1] + k * v1[1] + extent * v2[1],
      origin[2] + k * v1[2] + extent * v2[2],
    ]
    out.push(...a0, ...a1, ...b0, ...b1)
  }
  return new Float32Array(out)
}

/**
 * Map n-dimensional vectors into R³ for rendering: pad with zeros when n < 3,
 * perspective-project (same scheme as polytopes) when n > 3.
 */
export function vectorsToR3(vectors: number[][]): Vec3[] {
  if (!vectors.length) return []
  const dim = Math.max(...vectors.map((v) => v.length))
  const padded = vectors.map((v) => {
    const p = new Array(Math.max(3, dim)).fill(0)
    v.forEach((c, i) => { p[i] = Number(c) || 0 })
    return p
  })
  if (dim <= 3) return padded.map((v) => [v[0], v[1], v[2]] as Vec3)
  let pts = padded
  for (let d = pts[0].length; d > 3; d--) {
    pts = pts.map((v) => {
      const w = v[d - 1]
      const factor = 4 / Math.max(0.001, 4 - w * 0.8)
      return v.slice(0, d - 1).map((c) => c * factor)
    })
  }
  return pts.map((v) => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] as Vec3)
}
