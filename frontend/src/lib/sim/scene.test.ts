import { describe, it, expect } from 'vitest'
import { resolveSceneLook, SELF_LIT_SYSTEMS, type SceneLookSpec } from './scene'

const abstract = (kind: string): SceneLookSpec => ({ kind })
const sim = (extra: Partial<SceneLookSpec> = {}): SceneLookSpec =>
  ({ kind: 'simulation', system: 'nbody', ...extra })

describe('resolveSceneLook', () => {
  it('deja el look holográfico cuando no hay nada', () => {
    expect(resolveSceneLook([])).toEqual({ realistic: false, starfield: false, keyLight: false })
    expect(resolveSceneLook(null)).toEqual({ realistic: false, starfield: false, keyLight: false })
    expect(resolveSceneLook(undefined)).toEqual({ realistic: false, starfield: false, keyLight: false })
  })

  it('deja el look holográfico para TODAS las figuras abstractas', () => {
    // La regresión que más importa: ninguna de estas puede cambiar de aspecto.
    const kinds = ['parametric', 'polytope', 'implicit', 'primitive', 'curve',
      'graph', 'vectors', 'plane', 'line', 'polygon']
    for (const k of kinds) {
      expect(resolveSceneLook([abstract(k)]).realistic, k).toBe(false)
    }
    expect(resolveSceneLook(kinds.map(abstract)).realistic).toBe(false)
  })

  it('una simulación sin más pide look realista (realistic default true)', () => {
    expect(resolveSceneLook([sim()])).toEqual({ realistic: true, starfield: true, keyLight: false })
  })

  it('realistic:false devuelve la simulación al modo esquemático', () => {
    expect(resolveSceneLook([sim({ realistic: false })]).realistic).toBe(false)
  })

  it('starfield se puede apagar sin salir del modo realista', () => {
    const look = resolveSceneLook([sim({ starfield: false })])
    expect(look.realistic).toBe(true)
    expect(look.starfield).toBe(false)
  })

  it('starfield:true no enciende el modo realista por su cuenta', () => {
    // El fondo es consecuencia del look, no al revés.
    expect(resolveSceneLook([sim({ realistic: false, starfield: true })]).realistic).toBe(false)
    expect(resolveSceneLook([sim({ realistic: false, starfield: true })]).starfield).toBe(false)
  })

  it('con varias sims basta una que quiera estrellas', () => {
    const look = resolveSceneLook([sim({ starfield: false }), sim({ starfield: true })])
    expect(look.starfield).toBe(true)
  })

  it('una sim realista mezclada con figuras abstractas gana', () => {
    expect(resolveSceneLook([abstract('parametric'), sim(), abstract('curve')]).realistic).toBe(true)
  })

  it('una sim NO realista no arrastra a la escena aunque haya figuras', () => {
    expect(resolveSceneLook([abstract('graph'), sim({ realistic: false })]).realistic).toBe(false)
  })

  it('nbody y blackhole traen su luz: nada de relleno', () => {
    expect(resolveSceneLook([sim({ system: 'nbody' })]).keyLight).toBe(false)
    expect(resolveSceneLook([sim({ system: 'blackhole' })]).keyLight).toBe(false)
    expect([...SELF_LIT_SYSTEMS].sort()).toEqual(['blackhole', 'nbody'])
  })

  it('dynamics/field/ode piden luz de relleno o sus cuerpos salen negros', () => {
    for (const system of ['dynamics', 'field', 'ode']) {
      expect(resolveSceneLook([sim({ system })]).keyLight, system).toBe(true)
    }
  })

  it('una sola sim con estrella basta para no poner relleno', () => {
    expect(resolveSceneLook([sim({ system: 'ode' }), sim({ system: 'nbody' })]).keyLight).toBe(false)
  })

  it('una sim NO realista con estrella no cuenta como fuente de luz', () => {
    // Su pointLight se monta igual, pero el modo lo pide la OTRA: si esa otra
    // es un ode, sigue necesitando relleno... y aquí la escena ni es realista.
    const look = resolveSceneLook([sim({ system: 'nbody', realistic: false })])
    expect(look).toEqual({ realistic: false, starfield: false, keyLight: false })
  })

  it('fuera del modo realista keyLight es SIEMPRE false', () => {
    expect(resolveSceneLook([abstract('primitive')]).keyLight).toBe(false)
  })

  it('un system desconocido se trata como no auto-iluminado', () => {
    expect(resolveSceneLook([sim({ system: 'warp' })]).keyLight).toBe(true)
    expect(resolveSceneLook([sim({ system: undefined })]).keyLight).toBe(true)
  })
})
