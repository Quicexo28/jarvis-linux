import { describe, it, expect } from 'vitest'
import { evaluateParametricSurface, type ParametricSpec } from './parametricMath'

const TORUS: ParametricSpec = {
  x: 'cos(u) * (2 + cos(v))',
  y: 'sin(u) * (2 + cos(v))',
  z: 'sin(v)',
  uRange: [0, 2 * Math.PI],
  vRange: [0, 2 * Math.PI],
  segments: 8,
}

describe('evaluateParametricSurface', () => {
  it('produces correct vertex count', () => {
    const result = evaluateParametricSurface(TORUS)
    const N = 8 + 1  // segments + 1 = 9 grid points per axis
    expect(result.positions.length).toBe(N * N * 3)
  })

  it('produces correct triangle index count', () => {
    const result = evaluateParametricSurface(TORUS)
    // segments * segments * 2 triangles * 3 indices
    expect(result.indices.length).toBe(8 * 8 * 6)
  })

  it('torus center ring (v=0) has z≈0', () => {
    const result = evaluateParametricSurface({
      ...TORUS,
      vRange: [0, 0],   // v=0 → z=sin(0)=0
      segments: 4,
    })
    for (let i = 2; i < result.positions.length; i += 3) {
      expect(Math.abs(result.positions[i])).toBeLessThan(1e-10)
    }
  })

  it('handles NaN/Infinity gracefully (replaces with 0)', () => {
    const result = evaluateParametricSurface({
      x: '1/u',   // 1/0 = Infinity at u=0
      y: '0',
      z: '0',
      uRange: [0, 1],
      vRange: [0, 1],
      segments: 2,
    })
    for (const v of result.positions) {
      expect(isFinite(v)).toBe(true)
    }
  })

  it('flat plane (x=u, y=v, z=0) has correct xy and z=0', () => {
    const result = evaluateParametricSurface({
      x: 'u', y: 'v', z: '0',
      uRange: [0, 1], vRange: [0, 1],
      segments: 2,
    })
    // First vertex: u=0,v=0 → (0,0,0)
    expect(result.positions[0]).toBeCloseTo(0)  // x
    expect(result.positions[1]).toBeCloseTo(0)  // y
    expect(result.positions[2]).toBeCloseTo(0)  // z
    // All z values = 0
    for (let i = 2; i < result.positions.length; i += 3) {
      expect(Math.abs(result.positions[i])).toBeLessThan(1e-10)
    }
  })

  it('defaults to 64 segments when not specified', () => {
    const result = evaluateParametricSurface({ ...TORUS, segments: undefined })
    const N = 65
    expect(result.positions.length).toBe(N * N * 3)
  })
})
