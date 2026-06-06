/**
 * N-dimensional polytope generation and projection.
 * Pure math — no Three.js, no DOM. Testable in Node.
 */

export interface PolytopeGeometry {
  /** N-dimensional vertex coordinates */
  vertices: number[][]
  /** Pairs of vertex indices forming edges */
  edges: [number, number][]
  dimension: number
}

/**
 * N-dimensional hypercube (all ±1 combinations).
 * Has 2^N vertices and N * 2^(N-1) edges.
 * Cap: dimension ≤ 7 (128 vertices) for performance.
 */
export function buildHypercube(n: number): PolytopeGeometry {
  if (n < 2 || n > 7) throw new Error(`Hypercube dimension must be 2–7, got ${n}`)
  const count = 1 << n  // 2^n
  const vertices: number[][] = []
  for (let i = 0; i < count; i++) {
    const v: number[] = []
    for (let d = 0; d < n; d++) {
      v.push((i >> d) & 1 ? 1 : -1)
    }
    vertices.push(v)
  }
  const edges: [number, number][] = []
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const diff = i ^ j
      if (diff !== 0 && (diff & (diff - 1)) === 0) {  // exactly 1 bit differs
        edges.push([i, j])
      }
    }
  }
  return { vertices, edges, dimension: n }
}

/**
 * N-dimensional cross polytope (orthoplex): 2N vertices (±e_i for each axis).
 * Connected to all except its antipodal partner.
 */
export function buildCross(n: number): PolytopeGeometry {
  if (n < 2 || n > 7) throw new Error(`Cross polytope dimension must be 2–7, got ${n}`)
  const vertices: number[][] = []
  for (let d = 0; d < n; d++) {
    const pos = new Array(n).fill(0); pos[d] = 1; vertices.push(pos)
    const neg = new Array(n).fill(0); neg[d] = -1; vertices.push(neg)
  }
  const edges: [number, number][] = []
  for (let i = 0; i < 2 * n; i++) {
    for (let j = i + 1; j < 2 * n; j++) {
      if ((i ^ j) !== 1) {  // not antipodal (antipodal pairs differ in only the last bit)
        edges.push([i, j])
      }
    }
  }
  return { vertices, edges, dimension: n }
}

/**
 * Rotate vertices in the plane spanned by axes a and b by angle theta.
 * Returns new vertices — does NOT mutate input.
 */
export function rotateInPlane(vertices: number[][], a: number, b: number, theta: number): number[][] {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return vertices.map(v => {
    const r = [...v]
    r[a] = v[a] * c - v[b] * s
    r[b] = v[a] * s + v[b] * c
    return r
  })
}

/**
 * Project N-dimensional vertices to 3D via successive perspective projections.
 * Each step reduces dimensionality by 1: factor = dist / (dist - w_last); scale others.
 * Returns [x, y, z] per vertex.
 */
export function projectToR3(vertices: number[][], dist = 4): [number, number, number][] {
  let pts = vertices.map(v => [...v])
  for (let dim = pts[0].length; dim > 3; dim--) {
    pts = pts.map(v => {
      const w = v[dim - 1]
      const factor = dist / Math.max(0.001, dist - w * 0.8)
      return v.slice(0, dim - 1).map(c => c * factor)
    })
  }
  return pts.map(v => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0])
}
