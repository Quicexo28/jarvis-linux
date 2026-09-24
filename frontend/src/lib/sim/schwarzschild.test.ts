import { describe, it, expect } from 'vitest'
import {
  HORIZON, PHOTON_SPHERE, ISCO, B_CRIT,
  angularMomentumSq, energySq, precessionPerOrbit, precessionArcsecPerCentury,
  traceOrbit, traceRay, deflectionAngle,
  orbitalOmega, orbitalSpeed, gravitationalRedshift, dopplerFactor,
  diskTemperature, blackbodyRGB,
  rayDeflection, buildDeflectionLut, lutDeflection, impactParameter,
  apparentAngle, shadowAngularRadius, lensSweep, deflectionTail, lensPixel,
} from './schwarzschild'

describe('geometry constants', () => {
  it('places horizon, photon sphere and ISCO at 2M, 3M, 6M', () => {
    expect(HORIZON).toBe(2)
    expect(PHOTON_SPHERE).toBe(3)
    expect(ISCO).toBe(6)
  })

  it('photon capture parameter is 3√3 M', () => {
    expect(B_CRIT).toBeCloseTo(5.196152, 6)
  })
})

describe('orbit constants of motion', () => {
  it('reduces to the Newtonian L² = pM in the weak field', () => {
    expect(angularMomentumSq(1e6, 0.2)).toBeCloseTo(1e6, -1)
  })

  it('bound orbits have E² < 1', () => {
    expect(energySq(100, 0.3)).toBeLessThan(1)
    expect(energySq(20, 0.1)).toBeLessThan(1)
  })

  it('no stable circular orbit exists below the ISCO', () => {
    // p − 3M − Me² > 0 fails as p → 3M for a circular (e = 0) orbit.
    expect(Number.isNaN(angularMomentumSq(3, 0))).toBe(true)
    expect(angularMomentumSq(6, 0)).toBeGreaterThan(0)
  })
})

describe('perihelion precession', () => {
  it('converges to 6πM/p as the field weakens, at first order in M/p', () => {
    // The integrator carries the FULL orbit equation, so it must sit slightly
    // above the first-order formula, with the excess shrinking like 1/p.
    const residual = (p: number) => {
      const measured = traceOrbit(p, 0.3, 4, 1, 20000).precession
      return (measured / precessionPerOrbit(p) - 1) * p
    }
    const r1 = residual(500), r2 = residual(2000), r3 = residual(8000)
    for (const r of [r1, r2, r3]) {
      expect(r).toBeGreaterThan(4.3)   // known 2nd-order coefficient ≈ 9/2 + e²/4
      expect(r).toBeLessThan(4.8)
    }
    // Relative error itself must actually shrink.
    expect(r3 / 8000).toBeLessThan(r1 / 500)
    expect(Math.abs(traceOrbit(8000, 0.3, 4, 1, 20000).precession / precessionPerOrbit(8000) - 1))
      .toBeLessThan(0.001)
  })

  it('precesses forward (prograde), never backward', () => {
    expect(traceOrbit(300, 0.4, 3, 1, 4000).precession).toBeGreaterThan(0)
  })

  it("reproduces Mercury's 43 arcsec per century", () => {
    const arcsec = precessionArcsecPerCentury(
      5.790905e10,   // a, metres
      0.205630,      // e
      87.9691,       // period, days
      1476.6,        // GM☉/c², metres
    )
    expect(arcsec).toBeGreaterThan(42.5)
    expect(arcsec).toBeLessThan(43.5)
  })

  it('a Newtonian-strength orbit closes: precession ≪ 2π', () => {
    const t = traceOrbit(5000, 0.2, 2, 1, 4000)
    expect(t.precession).toBeLessThan(0.01)
    expect(t.captured).toBe(false)
  })

  it('keeps r between perihelion and aphelion', () => {
    const p = 100, e = 0.4
    const t = traceOrbit(p, e, 2, 1, 2000)
    expect(t.rMin).toBeCloseTo(p / (1 + e), 0)
    expect(t.rMax).toBeCloseTo(p / (1 - e), 0)
  })

  it('a strong-field orbit precesses visibly (degrees per orbit)', () => {
    const measured = traceOrbit(20, 0.3, 3, 1, 4000).precession
    expect(measured).toBeGreaterThan(0.5) // ≳30° per orbit
  })
})

describe('light bending', () => {
  it('matches the exact deflection series in the impact parameter', () => {
    // δ = 4M/b + (15π/4)(M/b)² + (128/3)(M/b)³ + …
    // NOTE the expansion in b, not in the closest approach r₀ — the r₀ series
    // carries a different 2nd-order coefficient (15π/4 − 4) and disagrees here.
    const series = (b: number) =>
      4 / b + ((15 * Math.PI) / 4) / (b * b) + (128 / 3) / (b * b * b)
    for (const b of [200, 1000, 5000]) {
      // Relative, because the residual left over is the 4th-order term
      // (3465π/64)(M/b)⁴ — present in the integrator, absent from the series.
      expect(Math.abs(deflectionAngle(b) / series(b) - 1)).toBeLessThan(1e-5)
    }
  })

  it('reduces to 4M/b to leading order', () => {
    expect(deflectionAngle(1e5) * 1e5).toBeCloseTo(4, 3)
  })

  it("reproduces the Sun's 1.75 arcsec grazing deflection", () => {
    const bOverM = 6.957e8 / 1476.6   // R☉ / (GM☉/c²)
    const arcsec = deflectionAngle(bOverM) * (180 / Math.PI) * 3600
    expect(arcsec).toBeGreaterThan(1.74)
    expect(arcsec).toBeLessThan(1.76)
  })

  it('bends more as the ray passes closer', () => {
    expect(deflectionAngle(20)).toBeGreaterThan(deflectionAngle(60))
    expect(deflectionAngle(8)).toBeGreaterThan(deflectionAngle(20))
  })

  it('captures photons below b_crit and lets them out above', () => {
    expect(traceRay(B_CRIT * 0.9).captured).toBe(true)
    expect(traceRay(B_CRIT * 1.15).captured).toBe(false)
  })

  it('returns a drawable path', () => {
    const r = traceRay(10)
    expect(r.points.length % 3).toBe(0)
    expect(r.points.length).toBeGreaterThan(30)
  })
})

describe('disk kinematics', () => {
  it('orbital speed is exactly c/2 at the ISCO', () => {
    expect(orbitalSpeed(ISCO)).toBeCloseTo(0.5, 12)
  })

  it('angular velocity follows the Keplerian √(M/r³)', () => {
    expect(orbitalOmega(100)).toBeCloseTo(1e-3, 12)
  })

  it('gravitational redshift vanishes at the horizon and → 1 far away', () => {
    expect(gravitationalRedshift(HORIZON)).toBeCloseTo(0, 12)
    expect(gravitationalRedshift(1e6)).toBeCloseTo(1, 5)
  })

  it('beams the approaching side brighter than the receding one', () => {
    const approaching = dopplerFactor(10, 1)
    const receding = dopplerFactor(10, -1)
    expect(approaching).toBeGreaterThan(receding)
    // Brightness goes as g⁴, so the asymmetry is dramatic — that is the bright
    // crescent in every black hole image.
    expect((approaching / receding) ** 4).toBeGreaterThan(5)
  })

  it('transverse motion is still redshifted by gravity alone', () => {
    expect(dopplerFactor(10, 0)).toBeLessThan(1)
  })
})

describe('disk thermodynamics', () => {
  it('is zero at the inner edge and peaks just outside it', () => {
    expect(diskTemperature(ISCO)).toBe(0)
    expect(diskTemperature((49 / 36) * ISCO)).toBeCloseTo(1, 6)
  })

  it('cools outward past the peak', () => {
    expect(diskTemperature(12)).toBeGreaterThan(diskTemperature(30))
    expect(diskTemperature(30)).toBeGreaterThan(diskTemperature(60))
  })

  it('blackbody colours run red → white → blue with temperature', () => {
    const [r1, , b1] = blackbodyRGB(2000)
    const [r2, , b2] = blackbodyRGB(12000)
    expect(r1).toBeGreaterThan(b1)   // cool = red
    expect(b2).toBeGreaterThan(0.9)  // hot = blue-white
    expect(r2).toBeGreaterThan(0.5)
    for (const c of [...blackbodyRGB(500), ...blackbodyRGB(60000)]) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
  })
})

describe('deflection LUT (lente gravitacional del fondo)', () => {
  // Una sola tabla para todo el bloque: construirla es lo caro (~18 ms), y el
  // renderer también la construye UNA vez por escena.
  const lut = buildDeflectionLut()

  it('rayDeflection coincide con la serie exacta en el parámetro de impacto', () => {
    // Misma serie que el bloque de arriba — OJO: en b, no en r₀.
    const series = (b: number) =>
      4 / b + ((15 * Math.PI) / 4) / (b * b) + (128 / 3) / (b * b * b)
    for (const b of [200, 1000, 5000]) {
      expect(Math.abs(rayDeflection(b) / series(b) - 1)).toBeLessThan(1e-5)
    }
  })

  it('rayDeflection reproduce traceRay sin acumular la trayectoria', () => {
    for (const b of [6, 8, 15, 40]) {
      expect(rayDeflection(b)).toBeCloseTo(deflectionAngle(b), 4)
    }
  })

  it('devuelve NaN exactamente donde el fotón cae', () => {
    expect(Number.isNaN(rayDeflection(B_CRIT * 0.999))).toBe(true)
    expect(Number.isNaN(rayDeflection(B_CRIT))).toBe(true)
    expect(Number.isFinite(rayDeflection(B_CRIT * 1.001))).toBe(true)
  })

  it('sobrevive a parámetros absurdos en vez de lanzar', () => {
    // Una excepción aquí subiría por el árbol de React y dejaría la ventana en
    // BLANCO (cicatriz del repo: las specs 3D con dimensión inválida).
    for (const [b, M] of [[0, 1], [-5, 1], [NaN, 1], [10, 0], [10, -1], [Infinity, 1]]) {
      expect(() => rayDeflection(b, M)).not.toThrow()
    }
    expect(() => buildDeflectionLut(2, 1)).not.toThrow()
    expect(() => buildDeflectionLut(512, 0)).not.toThrow()
    const degenerate = buildDeflectionLut(512, 0)
    for (const v of degenerate.data) expect(Number.isFinite(v)).toBe(true)
  })

  it('la tabla no contiene un solo NaN — un agujero se vería como basura', () => {
    expect(lut.data.length).toBe(lut.size)
    for (const v of lut.data) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it('interpola la deflexión real con error muy por debajo de un píxel', () => {
    // El eje logarítmico existe justamente para esto: δ es casi una recta en él.
    let worst = 0
    for (let i = 0; i < 200; i++) {
      const eps = Math.exp(Math.log(2e-4) + (Math.log(300) - Math.log(2e-4)) * (i / 199))
      const b = B_CRIT * (1 + eps)
      worst = Math.max(worst, Math.abs(lutDeflection(lut, b) - rayDeflection(b, 1, 1e-3)))
    }
    expect(worst).toBeLessThan(1e-3)   // 0.06° — invisible
  })

  it('decrece monótonamente con b y satura, no diverge, en el anillo de fotones', () => {
    for (let i = 1; i < lut.size; i++) {
      expect(lut.data[i]).toBeLessThanOrEqual(lut.data[i - 1] + 1e-6)
    }
    // El primer punto es el límite de deflexión fuerte a ε = 1e-4:
    // δ ≈ −ln ε + ln(216(7−4√3)) − π ≈ 8.81 rad, o sea ~1.4 vueltas.
    expect(lut.data[0]).toBeGreaterThan(8)
    expect(lut.data[0]).toBeLessThan(10)
    expect(lutDeflection(lut, B_CRIT * 1.000001)).toBeCloseTo(lut.data[0], 6)
    expect(Number.isNaN(lutDeflection(lut, B_CRIT * 0.9))).toBe(true)
  })
})

describe('mapeo píxel → cielo de la lente', () => {
  const lut = buildDeflectionLut()

  it('el borde de la sombra cae EXACTAMENTE en b = 3√3 M', () => {
    // Es el número que hace que la imagen se lea como un agujero negro: la
    // sombra no mide 2M (el horizonte) sino 5.196M de parámetro de impacto.
    for (const D of [12, 25, 60, 1000]) {
      const sh = shadowAngularRadius(D)
      expect(impactParameter(sh, D)).toBeCloseTo(B_CRIT, 9)
      // Justo dentro → capturado; justo fuera → escapa.
      expect(lensPixel(Math.PI - sh * 0.999, D, lut).captured).toBe(true)
      expect(lensPixel(Math.PI - sh * 1.001, D, lut).captured).toBe(false)
    }
  })

  it('la sombra es 2.6 veces el horizonte, y se encoge con la distancia', () => {
    const D = 400
    // A gran distancia el ángulo es b/D, así que el cociente de radios
    // aparentes tiende al cociente de parámetros de impacto: 3√3/2 = 2.598.
    expect(shadowAngularRadius(D) / apparentAngle(HORIZON, D)).toBeCloseTo(B_CRIT / HORIZON, 2)
    expect(shadowAngularRadius(25)).toBeGreaterThan(shadowAngularRadius(60))
  })

  it('mirar en dirección CONTRARIA al agujero nunca es sombra', () => {
    // sin ψ es el mismo a un lado y al otro de π/2, así que un test ingenuo
    // pintaría de negro el punto del cielo OPUESTO al agujero.
    for (const chi of [0, 0.01, 0.5, Math.PI / 2 - 1e-6]) {
      expect(lensPixel(chi, 20, lut).captured).toBe(false)
    }
  })

  it('sin masa el mapa es la identidad', () => {
    for (const chi of [0.1, 1, 2, 3]) expect(lensSweep(chi, 0, 10, 0)).toBe(chi)
  })

  it('la cola de deflexión no diverge mirando al lado opuesto del agujero', () => {
    // b → 0 ahí (la línea de visión pasa POR el agujero, por detrás), y una
    // cola ∝ 1/b sin más se iría al infinito en el punto más inocente del cielo.
    for (const chi of [1e-6, 1e-3, 0.05, 0.2]) {
      const b = 25 * Math.sin(chi)
      const tail = deflectionTail(Math.cos(chi), 8.81, b)
      expect(Number.isFinite(tail)).toBe(true)
      expect(tail).toBeLessThan(0.02)
    }
    expect(deflectionTail(1, 8.81, 0)).toBe(0)
  })

  it('lejos del agujero la distorsión se desvanece', () => {
    for (const chi of [0.05, 0.5, 1]) {
      expect(Math.abs(lensPixel(chi, 1e6, lut).sweep - chi)).toBeLessThan(1e-3)
    }
  })

  it('las dos ramas (entrante y saliente) empalman sin costura en ψ = π/2', () => {
    // El factor cos²(ψ/2) existe para esto: a un lado se aplica casi toda la
    // deflexión, al otro casi nada, y en medio ambas valen δ/2.
    const D = 30
    const eps = 1e-4
    const a = lensPixel(Math.PI / 2 - eps, D, lut).sweep
    const b = lensPixel(Math.PI / 2 + eps, D, lut).sweep
    // El residuo que queda es del tamaño del propio paso de la sonda: no hay
    // escalón, sólo un codo en la derivada.
    expect(Math.abs(a - b)).toBeLessThan(4 * eps)
  })

  it('el barrido crece con χ: el mapa es invertible fuera de la sombra', () => {
    const D = 25
    const sh = shadowAngularRadius(D)
    let prev = -Infinity
    for (let i = 0; i <= 400; i++) {
      const chi = ((Math.PI - sh * 1.02) * i) / 400
      const s = lensPixel(chi, D, lut).sweep
      expect(s).toBeGreaterThan(prev)
      prev = s
    }
  })

  it('produce un anillo de Einstein: existe un radio cuya fuente está detrás', () => {
    // Δφ = π significa que la luz viene del punto del cielo EXACTAMENTE opuesto
    // al agujero — todo el azimut lo ve a la vez, y eso es el anillo.
    const D = 25
    const sh = shadowAngularRadius(D)
    let lo = 0, hi = Math.PI - sh * 1.001
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2
      if (lensPixel(mid, D, lut).sweep > Math.PI) hi = mid; else lo = mid
    }
    const psiRing = Math.PI - (lo + hi) / 2
    expect(lensPixel((lo + hi) / 2, D, lut).sweep).toBeCloseTo(Math.PI, 3)
    // Cae FUERA de la sombra y dentro del campo visual: es visible.
    expect(psiRing).toBeGreaterThan(sh)
    expect(psiRing).toBeLessThan(sh * 4)
    // Al alejarse, el anillo (∝1/√D) encoge más despacio que la sombra (∝1/D),
    // así que la separación entre ambos crece — justo lo contrario de un
    // "halo" dibujado a escala fija.
    expect(psiRing / sh).toBeLessThan(ringOverShadow(60, lut))
  })

  it('hay imágenes de orden superior antes del borde de la sombra', () => {
    // Δφ = 3π es la segunda imagen del mismo punto del cielo: el fotón da
    // media vuelta más. Sólo existe porque δ diverge al acercarse a b_crit.
    const D = 25
    const sh = shadowAngularRadius(D)
    const edge = lensPixel(Math.PI - sh * 1.0005, D, lut)
    expect(edge.captured).toBe(false)
    expect(edge.sweep).toBeGreaterThan(3 * Math.PI)
  })
})

/** Radio del anillo de Einstein en unidades del radio de la sombra, a r_obs. */
function ringOverShadow(D: number, lut: ReturnType<typeof buildDeflectionLut>): number {
  const sh = shadowAngularRadius(D)
  let lo = 0, hi = Math.PI - sh * 1.001
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2
    if (lensPixel(mid, D, lut).sweep > Math.PI) hi = mid; else lo = mid
  }
  return (Math.PI - (lo + hi) / 2) / sh
}
