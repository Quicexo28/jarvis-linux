import { test, expect } from 'vitest'
import { magnetize, distanceToRect, closestPointInRect, type TargetRect } from './hitTest'

const rect = (id: string, left: number, top: number, width: number, height: number): TargetRect =>
  ({ id, left, top, width, height })

// Botón típico del HUD: ancho, bajito. Es el caso que hace falta imantar.
const btn = rect('btn', 100, 100, 120, 30)

test('distancia: dentro del rect es 0', () => {
  expect(distanceToRect(btn, 150, 110)).toBe(0)
})

test('distancia: por fuera mide al borde, no al centro', () => {
  expect(distanceToRect(btn, 150, 90)).toBeCloseTo(10)
  expect(distanceToRect(btn, 90, 110)).toBeCloseTo(10)
})

test('dentro del rect el punto NO se mueve', () => {
  const m = magnetize(150, 110, [btn])
  expect(m.id).toBe('btn')
  expect(m.inside).toBe(true)
  expect(m.x).toBe(150)
  expect(m.y).toBe(110)
})

test('cerca del rect: engancha y el punto cae DENTRO (el evento debe acertar)', () => {
  const m = magnetize(150, 80, [btn]) // 20 px por encima
  expect(m.id).toBe('btn')
  expect(m.inside).toBe(false)
  expect(m.x).toBeGreaterThanOrEqual(btn.left)
  expect(m.x).toBeLessThanOrEqual(btn.left + btn.width)
  expect(m.y).toBeGreaterThan(btn.top)
  expect(m.y).toBeLessThan(btn.top + btn.height)
})

test('lejos del rect: no engancha nada', () => {
  const m = magnetize(150, -100, [btn])
  expect(m.id).toBeNull()
  expect(m.x).toBe(150)
  expect(m.y).toBe(-100)
})

test('varios rects anidados: gana el de MENOR área (el botón, no el panel)', () => {
  const panel = rect('panel', 50, 50, 400, 300)
  const m = magnetize(150, 110, [panel, btn])
  expect(m.id).toBe('btn')
})

test('histéresis: el objetivo pegajoso conserva la plaza entre dos botones', () => {
  const a = rect('a', 100, 100, 80, 30)
  const b = rect('b', 100, 150, 80, 30)
  // Punto equidistante-ish, más cerca de b pero dentro del radio pegajoso de a.
  const withoutSticky = magnetize(140, 143, [a, b])
  expect(withoutSticky.id).toBe('b')
  const withSticky = magnetize(140, 143, [a, b], 'a')
  expect(withSticky.id).toBe('a')
})

test('pegajoso no gana si el cursor está DENTRO de otro objetivo', () => {
  const a = rect('a', 100, 100, 80, 30)
  const b = rect('b', 100, 140, 80, 30)
  const m = magnetize(140, 150, [a, b], 'a')
  expect(m.id).toBe('b')
  expect(m.inside).toBe(true)
})

test('closestPointInRect mete el punto hacia dentro con el inset', () => {
  const p = closestPointInRect(btn, 0, 110, 4)
  expect(p.x).toBe(104)
  expect(p.y).toBe(110)
})

test('inset no puede cruzar el centro de un rect fino', () => {
  const thin = rect('thin', 0, 0, 100, 4)
  const p = closestPointInRect(thin, 50, -50, 10)
  expect(p.y).toBe(2)
})

test('sin objetivos devuelve el punto tal cual', () => {
  const m = magnetize(10, 20, [])
  expect(m).toEqual({ id: null, x: 10, y: 20, inside: false })
})
