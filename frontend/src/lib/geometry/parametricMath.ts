import { create, all } from 'mathjs'

const math = create(all)

export interface ParametricSpec {
  /** mathjs expression for x(u, v) */
  x: string
  /** mathjs expression for y(u, v) */
  y: string
  /** mathjs expression for z(u, v) */
  z: string
  uRange: [number, number]
  vRange: [number, number]
  /** Grid resolution per axis. Capped at 120 for performance. Default 64. */
  segments?: number
  title?: string
  color?: string
}

export interface EvaluatedSurface {
  /** Flat Float32Array: [x0,y0,z0, x1,y1,z1, ...] in u-major order (u outer, v inner) */
  positions: Float32Array
  /** Triangle indices for indexed geometry */
  indices: Uint32Array
  /** Actual segments used */
  segments: number
}

/**
 * Evaluate a parametric surface using mathjs expressions.
 * NaN and Infinity values are replaced with 0 (malformed formulas degrade gracefully).
 */
export function evaluateParametricSurface(spec: ParametricSpec): EvaluatedSurface {
  const seg = Math.min(120, spec.segments ?? 64)
  const [uMin, uMax] = spec.uRange
  const [vMin, vMax] = spec.vRange
  const N = seg + 1

  // Compile expressions once for performance (parse tree reused across all (u,v) evaluations)
  const exprX = math.compile(spec.x)
  const exprY = math.compile(spec.y)
  const exprZ = math.compile(spec.z)

  const positions = new Float32Array(N * N * 3)

  for (let i = 0; i <= seg; i++) {
    const u = uMin + (i / seg) * (uMax - uMin)
    for (let j = 0; j <= seg; j++) {
      const v = vMin + (j / seg) * (vMax - vMin)
      const scope = { u, v }
      let px = exprX.evaluate(scope) as number
      let py = exprY.evaluate(scope) as number
      let pz = exprZ.evaluate(scope) as number
      if (!isFinite(px)) px = 0
      if (!isFinite(py)) py = 0
      if (!isFinite(pz)) pz = 0
      const base = (i * N + j) * 3
      positions[base]     = px
      positions[base + 1] = py
      positions[base + 2] = pz
    }
  }

  // Two triangles per quad: (a,b,d) and (a,d,c)
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
