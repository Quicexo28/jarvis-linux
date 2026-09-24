import { describe, it, expect } from 'vitest'
import { elide, MAX_LABEL_CHARS } from './label'

describe('elide', () => {
  it('deja intacta una etiqueta que ya cabe', () => {
    expect(elide('Fisica')).toBe('Fisica')
    expect(elide('Tiempo-de-Vuelo')).toBe('Tiempo-de-Vuelo')
  })

  it('nunca devuelve más caracteres que el tope', () => {
    const long = 'datos-tiempo-vuelo-masa3-harina'
    expect(elide(long).length).toBeLessThanOrEqual(MAX_LABEL_CHARS)
    expect(elide(long, 10).length).toBeLessThanOrEqual(10)
  })

  it('DISTINGUE las cuatro notas reales que solo difieren en el sufijo', () => {
    // Este es el caso que motivó la función: cortando por la derecha las cuatro
    // salían como "datos-tiempo-vuelo-mas…".
    const reales = [
      'datos-tiempo-vuelo-masa1-oasis',
      'datos-tiempo-vuelo-masa2-oasis',
      'datos-tiempo-vuelo-masa3-harina',
      'datos-tiempo-vuelo-masa3-oasis',
    ]
    const cortadas = reales.map((r) => elide(r))
    expect(new Set(cortadas).size).toBe(4)
  })

  it('conserva la cola, que es donde vive lo que distingue', () => {
    expect(elide('datos-tiempo-vuelo-masa3-harina')).toMatch(/harina$/)
    expect(elide('datos-tiempo-vuelo-masa1-oasis')).toMatch(/oasis$/)
  })

  it('conserva también algo de cabeza, para saber de qué familia es', () => {
    expect(elide('datos-tiempo-vuelo-masa1-oasis')).toMatch(/^datos/)
  })

  it('mete el carácter elidido en medio, no al final', () => {
    const out = elide('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(out).toContain('…')
    expect(out.endsWith('…')).toBe(false)
  })

  it('aguanta los casos degenerados sin lanzar', () => {
    expect(elide('')).toBe('')
    expect(elide('abc', 1)).toBe('…')
    expect(elide('abc', 0)).toBe('…')
    expect(elide('abcdef', 2)).toHaveLength(2)
  })
})
