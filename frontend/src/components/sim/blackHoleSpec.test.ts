/** Robustez del spec del agujero negro.
 *
 *  Quien escribe estos specs es un modelo de lenguaje. `"9"` en vez de `9`, o
 *  un array serializado en JSON, no son casos exóticos: son lo que pasa en
 *  cuanto algo serializa por el camino. Y el modo de fallo era silencioso de la
 *  peor manera — el renderer llamaba `.map` sobre una cadena, `Model3DViewer`
 *  descartaba la figura por su error boundary, y en pantalla quedaba un
 *  agujero negro VACÍO cuya única explicación estaba en journald.
 *
 *  Regla: `buildBlackHole` no puede devolver NUNCA algo que el renderer no
 *  sepa dibujar, pase lo que pase por su entrada.
 */

import { describe, it, expect } from 'vitest'
import { buildBlackHole } from './BlackHoleView'

const build = (spec: unknown) => buildBlackHole(spec as never)

describe('rays', () => {
  it('un número pide esa cantidad de rayos', () => {
    expect(build({ system: 'blackhole', rays: 5 }).rays).toHaveLength(5)
  })

  it('una CADENA numérica también — es el caso que rompía la vista', () => {
    expect(build({ system: 'blackhole', rays: '9' }).rays).toHaveLength(9)
  })

  it('una lista explícita se respeta, venga como array o como JSON', () => {
    expect(build({ system: 'blackhole', rays: [6, 8, 10] }).rays).toEqual([6, 8, 10])
    expect(build({ system: 'blackhole', rays: '[6,8,10]' }).rays).toEqual([6, 8, 10])
  })

  it('lo que no es ni lista ni número cae al default', () => {
    for (const bad of [undefined, null, 'abc', '', {}, true, NaN]) {
      const r = build({ system: 'blackhole', rays: bad }).rays
      expect(Array.isArray(r), String(bad)).toBe(true)
      expect(r.length, String(bad)).toBeGreaterThan(0)
      expect(r.every((b) => Number.isFinite(b) && b > 0), String(bad)).toBe(true)
    }
  })

  it('una LISTA se respeta aunque quede vacía — así se apagan los rayos', () => {
    // `rays: []` tiene que significar NINGUNO. Sustituirlo por el default
    // haría imposible mirar la lente sin rayos por encima, que es justo lo que
    // hace falta para comprobarla.
    expect(build({ system: 'blackhole', rays: [] }).rays).toEqual([])
    expect(build({ system: 'blackhole', rays: ['x'] }).rays).toEqual([])
    expect(build({ system: 'blackhole', rays: [-1, 0, 7] }).rays).toEqual([7])
    expect(build({ system: 'blackhole', rays: 0 }).rays).toEqual([])
  })

  it('una petición absurda se acota en vez de colgar el hilo', () => {
    expect(build({ system: 'blackhole', rays: 100000 }).rays.length).toBeLessThanOrEqual(64)
  })
})

describe('orbits', () => {
  it('acepta array y JSON, y normaliza los números', () => {
    expect(build({ system: 'blackhole', orbits: [{ p: 14, e: 0.35 }] }).orbits)
      .toEqual([{ p: 14, e: 0.35, color: undefined, label: undefined }])
    expect(build({ system: 'blackhole', orbits: '[{"p":14,"e":0.35}]' }).orbits[0].p).toBe(14)
    expect(build({ system: 'blackhole', orbits: [{ p: '12', e: '0.2' }] }).orbits[0])
      .toMatchObject({ p: 12, e: 0.2 })
  })

  it('descarta entradas imposibles en vez de dibujar una rosetta de NaN', () => {
    // p por debajo del horizonte no es una órbita; sin `p` tampoco.
    const b = build({ system: 'blackhole', orbits: [{ p: 1 }, { e: 0.5 }, { p: 20 }] })
    expect(b.orbits).toHaveLength(1)
    expect(b.orbits[0].p).toBe(20)
  })

  it('una excentricidad fuera de rango se acota (e ≥ 1 no es una elipse)', () => {
    expect(build({ system: 'blackhole', orbits: [{ p: 20, e: 5 }] }).orbits[0].e).toBeLessThan(1)
    expect(build({ system: 'blackhole', orbits: [{ p: 20, e: -3 }] }).orbits[0].e).toBe(0)
  })

  it('sin lista reconocible vuelve al par por defecto', () => {
    for (const bad of [undefined, null, 'abc', 42, {}]) {
      expect(build({ system: 'blackhole', orbits: bad }).orbits.length, String(bad))
        .toBeGreaterThan(0)
    }
  })

  it('una lista vacía significa NINGUNA órbita', () => {
    expect(build({ system: 'blackhole', orbits: [] }).orbits).toEqual([])
    expect(build({ system: 'blackhole', orbits: [{}] }).orbits).toEqual([])
  })
})

describe('el resto del spec', () => {
  it('masa, disco y escalas admiten cadenas', () => {
    const b = build({ system: 'blackhole', mass: '2', disk: ['8', '30'], viewScale: '4' })
    expect(b.M).toBe(2)
    expect(b.rOut).toBe(30)
    expect(b.viewScale).toBe(4)
  })

  it('disk:false apaga el disco y sigue dando radios utilizables', () => {
    const b = build({ system: 'blackhole', disk: false })
    expect(b.particles).toBe(0)
    expect(Number.isFinite(b.rIn) && Number.isFinite(b.rOut)).toBe(true)
  })

  it('ningún campo del build sale NaN, entre lo que entre', () => {
    // El cheque de red: un NaN aquí no lanza, simplemente dibuja la nada.
    const b = build({ system: 'blackhole', mass: 'x', disk: 'x', viewScale: {}, timeScale: [] })
    for (const k of ['M', 'rIn', 'rOut', 'particles', 'viewScale', 'timeScale'] as const) {
      expect(Number.isFinite(b[k]), k).toBe(true)
    }
  })
})

describe('interruptores booleanos', () => {
  it('apagan tanto con booleano como con la CADENA "false"', () => {
    // Este era el fallo: `spec.disk === false` comparado en estricto contra la
    // cadena "false" da falso, así que el disco seguía dibujándose después de
    // pedir que se apagara — y sin ningún error que lo delatara.
    for (const off of [false, 'false', 0, '0'] as unknown[]) {
      expect(build({ system: 'blackhole', disk: off }).particles, String(off)).toBe(0)
      expect(build({ system: 'blackhole', markers: off }).markers, String(off)).toBe(false)
      expect(build({ system: 'blackhole', lensing: off }).lensing, String(off)).toBe(false)
    }
  })

  it('ausente o ilegible = encendido, que es el default declarado', () => {
    for (const v of [undefined, null, 'quizá', {}] as unknown[]) {
      expect(build({ system: 'blackhole', markers: v }).markers, String(v)).toBe(true)
    }
  })

  it('una masa nula apaga la lente sola (no hay nada que doblar)', () => {
    expect(build({ system: 'blackhole', mass: 0 }).lensing).toBe(false)
    expect(build({ system: 'blackhole', mass: -3 }).lensing).toBe(false)
    expect(build({ system: 'blackhole', mass: '2' }).lensing).toBe(true)
  })
})
