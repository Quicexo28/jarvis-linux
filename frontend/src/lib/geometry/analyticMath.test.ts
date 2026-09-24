import { describe, it, expect } from 'vitest'
import {
  freeSymbols, sampleCurve3D, sampleGraph1D, sampleSurface,
  planeBasis, spanLatticeLines, vectorsToR3,
  bestFitPlane, orderOnPlane, projectToPlane, toPlaneCoords,
} from './analyticMath'

describe('freeSymbols', () => {
  it('finds variables but not function names or constants', () => {
    const s = freeSymbols('sin(x) * cos(y) + pi')
    expect(s.has('x')).toBe(true)
    expect(s.has('y')).toBe(true)
    expect(s.has('sin')).toBe(false)
    expect(s.has('pi')).toBe(false)
  })
  it('single-variable expression has no y', () => {
    expect(freeSymbols('x^2 + sqrt(x)').has('y')).toBe(false)
  })
})

describe('sampleCurve3D', () => {
  it('continuous curve yields a single segment with all samples', () => {
    const segs = sampleCurve3D({ x: 'cos(t)', y: 'sin(t)', z: 't/5', tRange: [0, 6.28], samples: 100 })
    expect(segs.length).toBe(1)
    expect(segs[0].length).toBe(101 * 3)
  })
  it('splits at asymptotes (tan)', () => {
    const segs = sampleCurve3D({ x: 't', y: 'tan(t)', tRange: [-3, 3], samples: 200 })
    expect(segs.length).toBeGreaterThanOrEqual(2)
    for (const seg of segs) {
      for (const v of seg) expect(isFinite(v)).toBe(true)
    }
  })
  it('drops non-finite points (log of negatives)', () => {
    const segs = sampleGraph1D('log(x)', [-2, 2], 100)
    expect(segs.length).toBeGreaterThanOrEqual(1)
    for (const seg of segs) {
      for (let i = 0; i < seg.length; i += 3) expect(seg[i]).toBeGreaterThan(0)
    }
  })
})

describe('sampleGraph1D', () => {
  it('evaluates f written in x, on the z=0 plane', () => {
    const segs = sampleGraph1D('x^2', [-2, 2], 16)
    expect(segs.length).toBe(1)
    const seg = segs[0]
    // first sample x=-2 → y=4, z=0
    expect(seg[0]).toBeCloseTo(-2)
    expect(seg[1]).toBeCloseTo(4)
    expect(seg[2]).toBeCloseTo(0)
    // midpoint (sample 8 of 16) x=0 → y=0
    expect(seg[8 * 3]).toBeCloseTo(0)
    expect(seg[8 * 3 + 1]).toBeCloseTo(0)
  })
})

describe('sampleSurface', () => {
  it('grid sizes and triangle indices match the segment count', () => {
    const { positions, indices, segments } = sampleSurface('x*y', [-1, 1], [-1, 1], 8)
    const N = segments + 1
    expect(positions.length).toBe(N * N * 3)
    expect(indices.length).toBe(segments * segments * 6)
  })
  it('z equals f(x,y) at grid corners', () => {
    const { positions } = sampleSurface('x + 2*y', [0, 1], [0, 1], 2)
    // first vertex: x=0, y=0 → z=0; last vertex: x=1, y=1 → z=3
    expect(positions[2]).toBeCloseTo(0)
    const last = positions.length - 3
    expect(positions[last]).toBeCloseTo(1)
    expect(positions[last + 1]).toBeCloseTo(1)
    expect(positions[last + 2]).toBeCloseTo(3)
  })
  it('clamps non-finite values to 0', () => {
    const { positions } = sampleSurface('1/(x*y)', [-1, 1], [-1, 1], 2)
    for (const v of positions) expect(isFinite(v)).toBe(true)
  })
})

describe('planeBasis', () => {
  it('returns an orthonormal basis perpendicular to the normal', () => {
    for (const n of [[0, 0, 1], [1, 1, 1], [2, -3, 0.5]] as [number, number, number][]) {
      const { u, v } = planeBasis(n)
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      const len = (a: number[]) => Math.hypot(a[0], a[1], a[2])
      expect(len(u)).toBeCloseTo(1)
      expect(len(v)).toBeCloseTo(1)
      expect(dot(u, v)).toBeCloseTo(0)
      expect(dot(u, n)).toBeCloseTo(0)
      expect(dot(v, n)).toBeCloseTo(0)
    }
  })
})

describe('spanLatticeLines', () => {
  it('emits 2 lines per lattice offset', () => {
    const flat = spanLatticeLines([1, 0, 0], [0, 1, 0], 2)
    // offsets -2..2 → 5 values × 2 directions × 2 endpoints × 3 coords
    expect(flat.length).toBe(5 * 2 * 2 * 3)
  })
  it('lattice points lie in the span plane (z=0 for xy vectors)', () => {
    const flat = spanLatticeLines([1, 0, 0], [0, 1, 0], 2)
    for (let i = 2; i < flat.length; i += 3) expect(flat[i]).toBeCloseTo(0)
  })
})

describe('vectorsToR3', () => {
  it('pads 2D vectors with z=0', () => {
    expect(vectorsToR3([[3, 4]])[0]).toEqual([3, 4, 0])
  })
  it('passes 3D vectors through', () => {
    expect(vectorsToR3([[1, 2, 3]])[0]).toEqual([1, 2, 3])
  })
  it('projects 5D vectors to finite 3D points', () => {
    const out = vectorsToR3([[1, 2, 3, 4, 5], [0, 0, 0, 0, 1]])
    expect(out.length).toBe(2)
    for (const p of out) {
      expect(p.length).toBe(3)
      for (const c of p) expect(isFinite(c)).toBe(true)
    }
  })
})

describe('bestFitPlane', () => {
  const rand = (seed: number) => {
    let x = seed
    return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5 }
  }

  it('recovers the plane of coplanar points exactly', () => {
    const pts: [number, number, number][] = [[1, 2, 5], [-3, 4, 5], [0, -2, 5], [4, 1, 5]]
    const plane = bestFitPlane(pts)
    expect(Math.abs(plane.normal[2])).toBeCloseTo(1, 9)
    expect(plane.rms).toBeCloseTo(0, 9)
    expect(plane.centroid[2]).toBeCloseTo(5, 9)
  })

  it('handles a tilted plane the axis-aligned formulation would botch', () => {
    // z = x + y — cada determinante por separado está mal condicionado.
    const pts: [number, number, number][] = [[0, 0, 0], [1, 0, 1], [0, 1, 1], [2, 1, 3], [-1, 2, 1]]
    const plane = bestFitPlane(pts)
    const n = plane.normal
    // Normal ∝ (1, 1, -1)/√3
    expect(Math.abs(n[0])).toBeCloseTo(1 / Math.sqrt(3), 6)
    expect(Math.abs(n[1])).toBeCloseTo(1 / Math.sqrt(3), 6)
    expect(Math.abs(n[2])).toBeCloseTo(1 / Math.sqrt(3), 6)
    expect(plane.rms).toBeCloseTo(0, 6)
  })

  it('is robust to noise off the plane', () => {
    const r = rand(7)
    const pts: [number, number, number][] = []
    for (let i = 0; i < 40; i++) pts.push([r() * 10, r() * 10, r() * 0.02])
    const plane = bestFitPlane(pts)
    expect(Math.abs(plane.normal[2])).toBeGreaterThan(0.99)
    expect(plane.rms).toBeLessThan(0.02)
  })

  it('degenerates safely with fewer than three points', () => {
    const plane = bestFitPlane([[0, 0, 0], [1, 1, 1]])
    expect(plane.normal.every(Number.isFinite)).toBe(true)
    expect(plane.u.every(Number.isFinite)).toBe(true)
    expect(plane.rms).toBe(0)
  })

  it('the basis is orthonormal and spans the plane', () => {
    const plane = bestFitPlane([[0, 0, 0], [1, 0, 1], [0, 1, 1]])
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    expect(dot(plane.u, plane.v)).toBeCloseTo(0, 9)
    expect(dot(plane.u, plane.normal)).toBeCloseTo(0, 9)
    expect(dot(plane.u, plane.u)).toBeCloseTo(1, 9)
  })
})

describe('orderOnPlane', () => {
  it('turns a bow tie into a simple ring', () => {
    // Orden anatómico de cuatro puntas: dos diagonales cruzadas.
    const bowtie: [number, number, number][] = [[0, 0, 0], [1, 0, 1], [1, 0, 0], [0, 0, 1]]
    const plane = bestFitPlane(bowtie)
    const ring = orderOnPlane(bowtie, plane)
    // Recorriendo el anillo ordenado, el ángulo alrededor del centroide crece.
    const angles = ring.map((p) => {
      const [u, v] = toPlaneCoords(p, plane)
      return Math.atan2(v, u)
    })
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1])
    // Y los lados pasan a ser todos iguales (el cuadrado real).
    const side = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    for (let i = 0; i < 4; i++) {
      expect(side(ring[i], ring[(i + 1) % 4])).toBeCloseTo(1, 9)
    }
  })
})

describe('projectToPlane', () => {
  it('flattens a warped quad onto its best-fit plane', () => {
    const warped: [number, number, number][] = [[0, 0, 0.1], [2, 0, -0.1], [2, 2, 0.1], [0, 2, -0.1]]
    const plane = bestFitPlane(warped)
    const flat = projectToPlane(warped, plane)
    const after = bestFitPlane(flat)
    expect(after.rms).toBeCloseTo(0, 9)
    // Y no se mueven en el plano: el centroide se conserva.
    expect(after.centroid[0]).toBeCloseTo(plane.centroid[0], 9)
    expect(after.centroid[1]).toBeCloseTo(plane.centroid[1], 9)
  })
})
