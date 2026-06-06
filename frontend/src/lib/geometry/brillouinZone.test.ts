import { describe, it, expect } from 'vitest'
import { brillouinZonePlanes, type PlaneData } from './brillouinZone'

// Inside test: point p is inside when every plane satisfies normal·p + constant >= 0.
function inside(planes: PlaneData[], p: [number, number, number]): boolean {
  return planes.every(({ normal, constant }) =>
    normal[0] * p[0] + normal[1] * p[1] + normal[2] * p[2] + constant >= -1e-9)
}

describe('brillouinZonePlanes', () => {
  it('sc has 6 faces (cube)', () => {
    expect(brillouinZonePlanes('sc', 1).length).toBe(6)
  })

  it('fcc has 14 faces (truncated octahedron)', () => {
    expect(brillouinZonePlanes('fcc', 1).length).toBe(14)
  })

  it('bcc has 12 faces (rhombic dodecahedron)', () => {
    expect(brillouinZonePlanes('bcc', 1).length).toBe(12)
  })

  it('fcc: origin is inside, far corner is outside', () => {
    const planes = brillouinZonePlanes('fcc', Math.PI)
    expect(inside(planes, [0, 0, 0])).toBe(true)
    // (π,π,π) violates the {111} plane x+y+z <= 1.5π (3π > 1.5π)
    expect(inside(planes, [Math.PI, Math.PI, Math.PI])).toBe(false)
  })

  it('fcc: {100} face point at (scale,0,0) is on the boundary (inside)', () => {
    const planes = brillouinZonePlanes('fcc', 2)
    expect(inside(planes, [2, 0, 0])).toBe(true)
    expect(inside(planes, [2.01, 0, 0])).toBe(false)
  })
})
