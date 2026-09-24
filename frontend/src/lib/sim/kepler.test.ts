import { describe, it, expect } from 'vitest'
import {
  solveKepler, period, elementsToState, stateToElements, orbitPolyline,
  planetElements, planetState, centuriesSinceJ2000, julianDate,
  PLANETS, GM_SUN, J2000_JD, wrapPi, DEG,
} from './kepler'

const findPlanet = (name: string) => PLANETS.find((p) => p.name === name)!

describe('solveKepler', () => {
  it('inverts Kepler equation for a range of eccentricities', () => {
    for (const e of [0, 0.05, 0.2, 0.6, 0.9]) {
      for (let k = 0; k < 12; k++) {
        const M = -Math.PI + (k / 11) * 2 * Math.PI
        const E = solveKepler(M, e)
        expect(E - e * Math.sin(E)).toBeCloseTo(wrapPi(M), 9)
      }
    }
  })

  it('is exact for a circle', () => {
    expect(solveKepler(1.234, 0)).toBeCloseTo(1.234, 12)
  })
})

describe('period', () => {
  it('gives the sidereal year for a = 1 AU', () => {
    expect(period(1, GM_SUN)).toBeCloseTo(365.2569, 3)
  })

  it('obeys Kepler III: T² ∝ a³', () => {
    const t1 = period(1), t4 = period(4)
    expect(t4 / t1).toBeCloseTo(8, 9) // 4^{3/2}
  })

  it('matches the known periods of Mars and Jupiter', () => {
    expect(period(findPlanet('Marte').el[0])).toBeCloseTo(686.98, 0)
    expect(period(findPlanet('Júpiter').el[0])).toBeCloseTo(4332.6, -1)
  })
})

describe('elements ↔ state', () => {
  it('round-trips an inclined eccentric orbit', () => {
    const el = { a: 2.3, e: 0.42, i: 0.31, node: 1.1, peri: -0.7, M: 0.9 }
    const s = elementsToState(el)
    const back = stateToElements(s.position, s.velocity)
    expect(back.a).toBeCloseTo(el.a, 9)
    expect(back.e).toBeCloseTo(el.e, 9)
    expect(back.i).toBeCloseTo(el.i, 9)
    expect(back.node).toBeCloseTo(el.node, 9)
    expect(back.peri).toBeCloseTo(el.peri, 9)
    expect(back.M).toBeCloseTo(el.M, 9)
  })

  it('puts perihelion at a(1−e) and aphelion at a(1+e)', () => {
    const base = { a: 1.5, e: 0.3, i: 0, node: 0, peri: 0 }
    const rp = elementsToState({ ...base, M: 0 }).position
    const ra = elementsToState({ ...base, M: Math.PI }).position
    expect(Math.hypot(...rp)).toBeCloseTo(1.5 * 0.7, 9)
    expect(Math.hypot(...ra)).toBeCloseTo(1.5 * 1.3, 9)
  })

  it('conserves the vis-viva energy along the orbit', () => {
    const el = { a: 3, e: 0.5, i: 0.2, node: 0.4, peri: 0.8, M: 0 }
    const energyAt = (M: number) => {
      const { position, velocity } = elementsToState({ ...el, M })
      const r = Math.hypot(...position)
      const v2 = velocity[0] ** 2 + velocity[1] ** 2 + velocity[2] ** 2
      return v2 / 2 - GM_SUN / r
    }
    const e0 = energyAt(0)
    for (const M of [0.7, 1.9, 3.0, 4.4, 5.9]) {
      expect(energyAt(M)).toBeCloseTo(e0, 12)
    }
  })

  it('circular orbit keeps a constant radius and speed', () => {
    const el = { a: 1, e: 0, i: 0, node: 0, peri: 0, M: 0 }
    for (const M of [0, 1, 2, 3, 4, 5]) {
      const { position, velocity } = elementsToState({ ...el, M })
      expect(Math.hypot(...position)).toBeCloseTo(1, 12)
      expect(Math.hypot(...velocity)).toBeCloseTo(Math.sqrt(GM_SUN), 12)
    }
  })
})

describe('orbitPolyline', () => {
  it('closes the loop', () => {
    const el = { a: 1.2, e: 0.25, i: 0.1, node: 0.3, peri: 0.2, M: 0 }
    const p = orbitPolyline(el, 64)
    expect(p.length).toBe(65 * 3)
    expect(p[0]).toBeCloseTo(p[64 * 3], 9)
    expect(p[1]).toBeCloseTo(p[64 * 3 + 1], 9)
  })
})

describe('dates', () => {
  it('J2000 is 2000-01-01T12:00Z', () => {
    expect(julianDate(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(J2000_JD, 6)
    expect(centuriesSinceJ2000(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(0, 9)
  })

  it('one Julian century later reads 1.0', () => {
    expect(centuriesSinceJ2000(new Date('2100-01-01T12:00:00Z'))).toBeCloseTo(1, 3)
  })
})

describe('planet ephemeris', () => {
  it('Earth sits ~1 AU from the Sun and near perihelion in early January', () => {
    const earth = findPlanet('Tierra')
    const r = Math.hypot(...planetState(earth, new Date('2000-01-01T12:00:00Z')).position)
    expect(r).toBeGreaterThan(0.980)
    expect(r).toBeLessThan(0.986)
  })

  it("Earth's mean longitude at J2000 matches the tabulated L₀", () => {
    const earth = findPlanet('Tierra')
    const el = planetElements(earth, 0)
    const L = wrapPi(el.M + el.peri + el.node) / DEG
    expect(L).toBeCloseTo(100.46457166, 6)
  })

  it('every planet stays inside its own [perihelion, aphelion] shell', () => {
    const date = new Date('2026-08-10T00:00:00Z')
    for (const p of PLANETS) {
      const el = planetElements(p, centuriesSinceJ2000(date))
      const r = Math.hypot(...planetState(p, date).position)
      expect(r).toBeGreaterThanOrEqual(el.a * (1 - el.e) - 1e-9)
      expect(r).toBeLessThanOrEqual(el.a * (1 + el.e) + 1e-9)
    }
  })

  it('planets are ordered by distance as expected on a given date', () => {
    const date = new Date('2026-08-10T00:00:00Z')
    const radii = PLANETS.map((p) => Math.hypot(...planetState(p, date).position))
    // Only the giants are guaranteed non-overlapping shells.
    for (let i = 4; i < radii.length - 1; i++) {
      expect(radii[i]).toBeLessThan(radii[i + 1])
    }
  })

  it('advances Mercury by one full revolution in its own period', () => {
    const mercury = findPlanet('Mercurio')
    const t0 = new Date('2026-01-01T00:00:00Z')
    const T = period(mercury.el[0])
    const t1 = new Date(t0.getTime() + T * 86400000)
    const p0 = planetState(mercury, t0).position
    const p1 = planetState(mercury, t1).position
    // Same point to well under a planetary radius on this scale.
    expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])).toBeLessThan(2e-3)
  })
})
