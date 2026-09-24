import { describe, it, expect } from 'vitest'
import { makeRadiusScale, R_MIN, R_MAX } from './size'
import type { GraphNode } from './types'

const node = (degree: number): GraphNode => ({
  id: `n${degree}`, label: `n${degree}`, type: 'note',
  folder: '03-Conocimiento', tags: [], degree,
})

describe('makeRadiusScale', () => {
  it('crece con el número de conexiones', () => {
    const r = makeRadiusScale([node(0), node(1), node(5), node(26)])
    expect(r(node(0))).toBeLessThan(r(node(1)))
    expect(r(node(1))).toBeLessThan(r(node(5)))
    expect(r(node(5))).toBeLessThan(r(node(26)))
  })

  it('usa el rango visual COMPLETO: el aislado en el mínimo, el hub en el máximo', () => {
    const nodes = [node(0), node(2), node(26)]
    const r = makeRadiusScale(nodes)
    expect(r(node(0))).toBeCloseTo(R_MIN, 6)
    expect(r(node(26))).toBeCloseTo(R_MAX, 6)
  })

  it('el ÁREA aparente es proporcional al grado, que es lo que el ojo compara', () => {
    const r = makeRadiusScale([node(0), node(4), node(16)])
    // Descontando el mínimo (que existe para que un nodo aislado se vea), el
    // radio va con √grado ⇒ el área va con el grado. 16 enlaces deben ocupar
    // ~4 veces el área de 4 enlaces.
    const a = (d: number) => (r(node(d)) - R_MIN) ** 2
    expect(a(16) / a(4)).toBeCloseTo(4, 5)
  })

  it('se normaliza por el grado máximo: el mismo grado da radios distintos en grafos distintos', () => {
    const pequeno = makeRadiusScale([node(0), node(4)])
    const grande = makeRadiusScale([node(0), node(4), node(100)])
    // En un grafo cuyo hub tiene 4 enlaces, un nodo de 4 ES el hub.
    expect(pequeno(node(4))).toBeCloseTo(R_MAX, 6)
    // En uno cuyo hub tiene 100, el mismo nodo es pequeño.
    expect(grande(node(4))).toBeLessThan(R_MAX * 0.5)
  })

  it('acepta el maxDegree que ya calcula el backend', () => {
    // `stats.maxDegree` del grafo real: evita recorrer los nodos otra vez.
    const r = makeRadiusScale([node(2)], 26)
    expect(r(node(26))).toBeCloseTo(R_MAX, 6)
    expect(r(node(2))).toBeLessThan(R_MAX * 0.5)
  })

  it('un grafo SIN aristas deja todos los nodos del mismo tamaño mínimo', () => {
    const r = makeRadiusScale([node(0), node(0), node(0)])
    expect(r(node(0))).toBeCloseTo(R_MIN, 6)
  })

  it('no lanza ni se sale de rango con entradas degeneradas', () => {
    const r = makeRadiusScale([])
    expect(r(node(0))).toBeCloseTo(R_MIN, 6)
    // Un grado por encima del máximo declarado (caché rancia) se recorta.
    const capped = makeRadiusScale([node(1)], 1)
    expect(capped(node(999))).toBeCloseTo(R_MAX, 6)
    // Grado negativo o ausente no produce NaN.
    const weird = makeRadiusScale([node(4)])
    expect(weird({ ...node(0), degree: -5 })).toBeCloseTo(R_MIN, 6)
    expect(Number.isFinite(weird({ ...node(0), degree: undefined as unknown as number }))).toBe(true)
  })

  it('todo radio se queda dentro de [R_MIN, R_MAX]', () => {
    const r = makeRadiusScale([node(0), node(3), node(9), node(26)], 26)
    for (const d of [0, 1, 2, 3, 9, 26, 40]) {
      expect(r(node(d))).toBeGreaterThanOrEqual(R_MIN)
      expect(r(node(d))).toBeLessThanOrEqual(R_MAX)
    }
  })
})
