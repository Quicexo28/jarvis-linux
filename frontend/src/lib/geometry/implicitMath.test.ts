import { describe, it, expect } from 'vitest'
import { marchingCubes } from './implicitMath'

describe('marchingCubes', () => {
  it('extracts a sphere isosurface with all vertices near radius', () => {
    const r = 1.5
    // f = x²+y²+z²; isosurface f = r² is a sphere of radius r.
    const f = (x: number, y: number, z: number) => x * x + y * y + z * z
    const { positions, triangleCount } = marchingCubes(f, r * r, [-3, 3], 32)

    expect(triangleCount).toBeGreaterThan(100)
    // Every vertex should sit ~r from origin (within one cell of tolerance).
    let maxErr = 0
    for (let i = 0; i < positions.length; i += 3) {
      const d = Math.hypot(positions[i], positions[i + 1], positions[i + 2])
      maxErr = Math.max(maxErr, Math.abs(d - r))
    }
    expect(maxErr).toBeLessThan(0.3)
  })

  it('returns empty mesh when isosurface is outside the box', () => {
    const f = (x: number, y: number, z: number) => x * x + y * y + z * z
    // iso = 100 → sphere radius 10, far outside [-1,1] box → no crossing
    const { triangleCount } = marchingCubes(f, 100, [-1, 1], 16)
    expect(triangleCount).toBe(0)
  })

  it('produces a finite, non-NaN mesh for a Fermi-like tight-binding field', () => {
    // FCC s-band tight-binding E(k); isosurface E = E_F is the Fermi surface.
    const E = (x: number, y: number, z: number) =>
      -(Math.cos(x) * Math.cos(y) + Math.cos(y) * Math.cos(z) + Math.cos(z) * Math.cos(x))
    const { positions, triangleCount } = marchingCubes(E, -0.5, [-Math.PI, Math.PI], 24)
    expect(triangleCount).toBeGreaterThan(0)
    for (const v of positions) expect(isFinite(v)).toBe(true)
  })

  it('caps resolution at 64', () => {
    const f = (x: number, y: number, z: number) => x * x + y * y + z * z
    // resolution 500 → capped at 64; should still run and produce a sphere.
    const { triangleCount } = marchingCubes(f, 1, [-2, 2], 500)
    expect(triangleCount).toBeGreaterThan(100)
  })

  it('replaces non-finite field values without crashing', () => {
    const f = (x: number, _y: number, _z: number) => (x === 0 ? Infinity : 1 / x)
    const { positions } = marchingCubes(f, 0.5, [-1, 1], 8)
    for (const v of positions) expect(isFinite(v)).toBe(true)
  })
})
