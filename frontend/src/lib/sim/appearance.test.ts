import { describe, it, expect } from 'vitest'
import {
  TEXTURES, TEXTURE_BASE, texturePath, normalizeName, lookupAppearance,
  resolveAppearance, appearanceFor, needsOwnMesh, axisIsFlipped,
  spinSign, apparentSpinSign, spinAngle, spinSlowdown,
} from './appearance'
import type { SimBody } from './types'

const body = (over: Partial<SimBody> = {}): SimBody =>
  ({ mass: 1, position: [0, 0, 0], ...over })

describe('texturePath', () => {
  it('maps a table key to the served path', () => {
    expect(texturePath('earth')).toBe(`${TEXTURE_BASE}2k_earth_daymap.jpg`)
    expect(texturePath('saturn_ring')).toBe(`${TEXTURE_BASE}2k_saturn_ring_alpha.png`)
  })

  it('accepts the key however it was written', () => {
    expect(texturePath('EARTH')).toBe(texturePath('earth'))
    expect(texturePath(' Saturn Ring ')).toBe(texturePath('saturn_ring'))
    expect(texturePath('saturn-ring')).toBe(texturePath('saturn_ring'))
  })

  it('passes an explicit path through untouched', () => {
    expect(texturePath('/textures/mine.jpg')).toBe('/textures/mine.jpg')
    expect(texturePath('https://x.test/a.png')).toBe('https://x.test/a.png')
  })

  it('prefixes a bare file name with the textures directory', () => {
    expect(texturePath('2k_mars.jpg')).toBe(`${TEXTURE_BASE}2k_mars.jpg`)
  })

  it('degrades to undefined instead of asking for a 404', () => {
    // Una clave con errata tiene que caer al color plano: pedir el fichero
    // igualmente pintaría el cuerpo de negro, que es peor que no texturizarlo.
    expect(texturePath('plutonio')).toBeUndefined()
    expect(texturePath('')).toBeUndefined()
    expect(texturePath(undefined)).toBeUndefined()
  })
})

describe('normalizeName', () => {
  it('strips accents and case', () => {
    expect(normalizeName('Júpiter')).toBe('jupiter')
    expect(normalizeName('  TIERRA ')).toBe('tierra')
    expect(normalizeName('Ío')).toBe('io')
  })
})

describe('the table', () => {
  it('finds the same body in Spanish and in English', () => {
    expect(lookupAppearance('Tierra')).toBe(lookupAppearance('earth'))
    expect(lookupAppearance('Júpiter')).toBe(lookupAppearance('jupiter'))
    expect(lookupAppearance('Sol')).toBe(lookupAppearance('sun'))
    expect(lookupAppearance('Urano')).toBe(lookupAppearance('uranus'))
  })

  it('knows nothing about a body it has never heard of', () => {
    expect(lookupAppearance('Ío')).toBeUndefined()
    expect(lookupAppearance('')).toBeUndefined()
  })

  it('only references texture keys that exist', () => {
    // Una errata aquí no rompe nada visible: el cuerpo se queda liso y nadie
    // se entera. Por eso lo comprueba el test y no el ojo.
    for (const name of ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars',
      'jupiter', 'saturn', 'uranus', 'neptune']) {
      const row = lookupAppearance(name)!
      expect(row.texture && TEXTURES[row.texture]).toBeTruthy()
      if (row.clouds) expect(TEXTURES[row.clouds]).toBeTruthy()
      if (row.night) expect(TEXTURES[row.night]).toBeTruthy()
      if (row.rings?.texture) expect(TEXTURES[row.rings.texture]).toBeTruthy()
    }
  })

  it('carries the real physical data', () => {
    expect(lookupAppearance('Tierra')!.tilt).toBeCloseTo(23.44, 2)
    expect(lookupAppearance('Urano')!.tilt).toBeCloseTo(97.77, 2)
    expect(lookupAppearance('Venus')!.rotationPeriod).toBeCloseTo(-243.025, 3)
    const rings = lookupAppearance('Saturno')!.rings!
    expect(rings.inner).toBeLessThan(rings.outer)
    expect(rings.inner).toBeGreaterThan(1)   // los anillos no tocan el planeta
  })
})

describe('resolveAppearance', () => {
  it('dresses a body by its name alone', () => {
    const a = resolveAppearance(body({ name: 'Saturno' }))
    expect(a.texture).toBe(`${TEXTURE_BASE}2k_saturn.jpg`)
    expect(a.tilt).toBeCloseTo(26.73, 2)
    expect(a.rings?.texture).toBe(`${TEXTURE_BASE}2k_saturn_ring_alpha.png`)
    expect(a.emissive).toBe(false)
  })

  it('lets the spec override the table', () => {
    const a = resolveAppearance(body({
      name: 'Tierra', texture: 'mars', tilt: 0, rotationPeriod: 10, emissive: true,
    }))
    expect(a.texture).toBe(`${TEXTURE_BASE}2k_mars.jpg`)
    expect(a.tilt).toBe(0)
    expect(a.rotationPeriod).toBe(10)
    expect(a.emissive).toBe(true)
  })

  it('keeps an explicit zero instead of falling back to the table', () => {
    // `?? ` y no `||`: pedir "sin inclinación" es una orden, no un hueco.
    expect(resolveAppearance(body({ name: 'Tierra', tilt: 0 })).tilt).toBe(0)
    expect(resolveAppearance(body({ name: 'Tierra', rotationPeriod: 0 })).rotationPeriod).toBe(0)
  })

  it('falls back to a flat sphere for an unknown body', () => {
    const a = resolveAppearance(body({ name: 'Ío' }))
    expect(a.texture).toBeUndefined()
    expect(a.tilt).toBe(0)
    expect(a.rotationPeriod).toBe(0)
    expect(a.rings).toBeUndefined()
    expect(a.emissive).toBe(false)
    expect(needsOwnMesh(a)).toBe(false)
  })

  it('takes the name from the argument when the body has none', () => {
    expect(resolveAppearance(body(), 'Marte').texture).toBe(`${TEXTURE_BASE}2k_mars.jpg`)
    expect(resolveAppearance(undefined, 'Sol').emissive).toBe(true)
  })

  it('gives the Sun its own mesh because it is a light, not a surface', () => {
    const sun = resolveAppearance(body({ name: 'Sol' }))
    expect(sun.emissive).toBe(true)
    expect(needsOwnMesh(sun)).toBe(true)
    expect(needsOwnMesh(resolveAppearance(body({ name: 'A', emissive: true })))).toBe(true)
  })

  it('only the Earth carries clouds and a night map', () => {
    expect(resolveAppearance(body({ name: 'Tierra' })).clouds)
      .toBe(`${TEXTURE_BASE}2k_earth_clouds.jpg`)
    expect(resolveAppearance(body({ name: 'Tierra' })).night)
      .toBe(`${TEXTURE_BASE}2k_earth_nightmap.jpg`)
    expect(resolveAppearance(body({ name: 'Marte' })).clouds).toBeUndefined()
  })

  it('resolves custom rings written by hand', () => {
    const a = resolveAppearance(body({ name: 'X', rings: { inner: 2, outer: 3 } }))
    expect(a.rings).toEqual({ inner: 2, outer: 3, texture: undefined, tilt: 0 })
  })
})

describe('appearanceFor', () => {
  it('emits spec fields a preset can spread, keys and not paths', () => {
    const f = appearanceFor('Saturno')
    expect(f.texture).toBe('saturn')          // clave, la ruta la resuelve el renderer
    expect(f.rotationPeriod).toBeCloseTo(0.44401, 5)
    expect(f.rings?.inner).toBeCloseTo(1.24, 2)
    expect(resolveAppearance(body({ name: 'X', ...f })).texture)
      .toBe(`${TEXTURE_BASE}2k_saturn.jpg`)   // y el viaje de ida y vuelta cierra
  })

  it('emits nothing for a body outside the table', () => {
    expect(appearanceFor('Calisto')).toEqual({})
  })

  it('does not hand out the table row itself', () => {
    const a = appearanceFor('Saturno')
    a.rings!.inner = 99
    expect(lookupAppearance('Saturno')!.rings!.inner).toBeCloseTo(1.24, 2)
  })
})

describe('spin direction', () => {
  it('turns a full circle in exactly one period', () => {
    expect(spinAngle(0, 2)).toBe(0)
    expect(spinAngle(2, 2)).toBeCloseTo(2 * Math.PI, 10)
    expect(spinAngle(1, 2)).toBeCloseTo(Math.PI, 10)
  })

  it('reverses with a negative period', () => {
    expect(spinAngle(1, -2)).toBeCloseTo(-Math.PI, 10)
    expect(spinSign(-2)).toBe(-1)
    expect(spinSign(2)).toBe(1)
  })

  it('does not turn at all without a period', () => {
    expect(spinAngle(5, 0)).toBe(0)
    expect(spinAngle(5, NaN)).toBe(0)
    expect(spinSign(0)).toBe(0)
  })

  it('knows when the obliquity flips the axis over', () => {
    expect(axisIsFlipped(23.44)).toBe(false)
    expect(axisIsFlipped(177.36)).toBe(true)
    expect(axisIsFlipped(97.77)).toBe(true)
    expect(axisIsFlipped(-97.77)).toBe(true)   // 262.23°, sigue boca abajo
    expect(axisIsFlipped(360 + 10)).toBe(false)
  })

  it('does not count the retrograde twice', () => {
    // Venus: la NASA lo dice dos veces (periodo negativo Y oblicuidad 177°).
    // Alrededor de su propio eje —que apunta casi al sur— el giro es DIRECTO;
    // lo que se ve desde el norte de la órbita es retrógrado.
    const venus = lookupAppearance('Venus')!
    expect(spinSign(venus.rotationPeriod!, venus.tilt!)).toBe(1)
    expect(apparentSpinSign(venus.rotationPeriod!, venus.tilt!)).toBe(-1)
    expect(spinAngle(10, venus.rotationPeriod!, venus.tilt!)).toBeGreaterThan(0)
  })

  it('the apparent direction always matches the sign of the period', () => {
    for (const name of ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars',
      'jupiter', 'saturn', 'uranus', 'neptune']) {
      const row = lookupAppearance(name)!
      expect(apparentSpinSign(row.rotationPeriod!, row.tilt!))
        .toBe(Math.sign(row.rotationPeriod!))
    }
  })

  it('leaves Uranus and Venus as the only retrograde planets', () => {
    const retro = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']
      .filter((n) => apparentSpinSign(lookupAppearance(n)!.rotationPeriod!) < 0)
    expect(retro).toEqual(['venus', 'uranus'])
  })
})

describe('spinSlowdown', () => {
  it('leaves a slow system alone', () => {
    expect(spinSlowdown([27.32], 1)).toBe(1)
    expect(spinSlowdown([], 20)).toBe(1)
    expect(spinSlowdown([0, NaN], 20)).toBe(1)
  })

  it('caps the fastest body at the readable rate', () => {
    // `solar`: 20 días por segundo real ⇒ la Tierra daría 20 vueltas/s.
    const f = spinSlowdown([25.38, 0.99727, 0.41354], 20, 0.25)
    expect(20 / (0.41354 * f)).toBeCloseTo(0.25, 10)
    expect(f).toBeGreaterThan(1)
  })

  it('preserves the ratios between periods — it is ONE factor for all', () => {
    const periods = [0.41354, 0.99727, -243.025]
    const f = spinSlowdown(periods, 20)
    const scaled = periods.map((p) => p * f)
    expect(scaled[1] / scaled[0]).toBeCloseTo(periods[1] / periods[0], 10)
    expect(scaled[2] / scaled[0]).toBeCloseTo(periods[2] / periods[0], 10)
  })

  it('ignores the sign when measuring who is fastest', () => {
    expect(spinSlowdown([-0.5], 10)).toBe(spinSlowdown([0.5], 10))
  })

  it('never speeds anything up', () => {
    expect(spinSlowdown([1000], 1)).toBe(1)
    expect(spinSlowdown([1], 0)).toBe(1)
    expect(spinSlowdown([1], -5)).toBe(1)
  })
})
