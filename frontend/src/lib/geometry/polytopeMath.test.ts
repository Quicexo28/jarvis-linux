import { describe, it, expect } from 'vitest'
import { buildHypercube, buildCross, buildHypercubeFaces, rotateInPlane, projectToR3 } from './polytopeMath'

describe('buildHypercube', () => {
  it('2D square: 4 vertices, 4 edges', () => {
    const h = buildHypercube(2)
    expect(h.vertices.length).toBe(4)
    expect(h.edges.length).toBe(4)
  })
  it('3D cube: 8 vertices, 12 edges', () => {
    const h = buildHypercube(3)
    expect(h.vertices.length).toBe(8)
    expect(h.edges.length).toBe(12)
  })
  it('4D tesseract: 16 vertices, 32 edges', () => {
    const h = buildHypercube(4)
    expect(h.vertices.length).toBe(16)
    // N * 2^(N-1) = 4 * 8 = 32
    expect(h.edges.length).toBe(32)
  })
  it('all vertices have N coords all ±1', () => {
    const h = buildHypercube(4)
    for (const v of h.vertices) {
      expect(v.length).toBe(4)
      for (const c of v) expect(Math.abs(c)).toBeCloseTo(1)
    }
  })
  it('throws for dimension > 7', () => {
    expect(() => buildHypercube(8)).toThrow()
  })
})

describe('buildCross', () => {
  it('3D cross: 6 vertices, 12 edges', () => {
    const c = buildCross(3)
    expect(c.vertices.length).toBe(6)
    expect(c.edges.length).toBe(12)
  })
  it('no antipodal edges', () => {
    const c = buildCross(3)
    // Antipodal pairs: (0,1), (2,3), (4,5) — none should be edges
    const edgeSet = new Set(c.edges.map(([a, b]) => `${a}-${b}`))
    expect(edgeSet.has('0-1')).toBe(false)
    expect(edgeSet.has('2-3')).toBe(false)
  })
})

describe('buildHypercubeFaces', () => {
  it('3D cube: 6 square faces', () => {
    expect(buildHypercubeFaces(3).length).toBe(6)
  })
  it('4D tesseract: 24 square faces', () => {
    expect(buildHypercubeFaces(4).length).toBe(24)
  })
  it('5D: C(5,2) * 2^3 = 80 faces', () => {
    expect(buildHypercubeFaces(5).length).toBe(80)
  })
  it('each face is a unit square: 4 distinct vertices differing in exactly 2 axes', () => {
    const { vertices } = buildHypercube(4)
    for (const quad of buildHypercubeFaces(4)) {
      expect(new Set(quad).size).toBe(4)
      // union of differing axes across the cycle spans exactly 2 dimensions
      const varying = new Set<number>()
      for (let k = 0; k < 4; k++) {
        const a = vertices[quad[k]]
        const b = vertices[quad[(k + 1) % 4]]
        const diff = a.map((c, d) => c !== b[d] ? d : -1).filter((d) => d >= 0)
        expect(diff.length).toBe(1) // consecutive corners differ in exactly one axis (cyclic order)
        varying.add(diff[0])
      }
      expect(varying.size).toBe(2)
    }
  })
})

describe('rotateInPlane', () => {
  it('90° rotation in XY plane maps [1,0,0,0] to [0,1,0,0]', () => {
    const v = [[1, 0, 0, 0]]
    const r = rotateInPlane(v, 0, 1, Math.PI / 2)
    expect(r[0][0]).toBeCloseTo(0)
    expect(r[0][1]).toBeCloseTo(1)
    expect(r[0][2]).toBeCloseTo(0)
    expect(r[0][3]).toBeCloseTo(0)
  })
  it('does not mutate input vertices', () => {
    const v = [[1, 0, 0, 0]]
    const original = v[0].slice()
    rotateInPlane(v, 0, 1, 0.5)
    expect(v[0]).toEqual(original)
  })
  it('360° rotation returns to original', () => {
    const v = [[1, 2, 3, 4]]
    const r = rotateInPlane(v, 0, 3, 2 * Math.PI)
    expect(r[0][0]).toBeCloseTo(v[0][0])
    expect(r[0][3]).toBeCloseTo(v[0][3])
  })
})

describe('projectToR3', () => {
  it('3D vertices pass through unchanged', () => {
    const pts = [[1, 2, 3], [4, 5, 6]]
    const result = projectToR3(pts)
    expect(result[0]).toEqual([1, 2, 3])
    expect(result[1]).toEqual([4, 5, 6])
  })
  it('4D vertices project to 3D with finite values', () => {
    const { vertices } = buildHypercube(4)
    const projected = projectToR3(vertices)
    expect(projected.length).toBe(16)
    for (const p of projected) {
      expect(p.length).toBe(3)
      for (const c of p) expect(isFinite(c)).toBe(true)
    }
  })
  it('5D vertices project to 3D', () => {
    const { vertices } = buildHypercube(5)
    const projected = projectToR3(vertices)
    expect(projected.length).toBe(32)
    for (const p of projected) expect(p.length).toBe(3)
  })
})
