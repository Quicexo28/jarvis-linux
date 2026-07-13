import { test, expect } from 'vitest'
import { OneEuro, wrapAngle, clamp } from './filters'

test('OneEuro: converge a un escalón', () => {
  const f = new OneEuro({ minCutoff: 1.1, beta: 0.007, dCutoff: 1.0 })
  f.filter(0, 0)
  let out = 0
  for (let i = 1; i <= 30; i++) out = f.filter(1, i * 66)
  expect(out).toBeGreaterThan(0.9)
  expect(out).toBeLessThanOrEqual(1)
})

test('OneEuro: atenúa jitter alrededor de un valor fijo', () => {
  const f = new OneEuro({ minCutoff: 1.1, beta: 0.007, dCutoff: 1.0 })
  // Señal: 0.5 ± 0.05 alternante. La salida debe quedar mucho más cerca de 0.5.
  let maxDev = 0
  for (let i = 0; i < 40; i++) {
    const noisy = 0.5 + (i % 2 === 0 ? 0.05 : -0.05)
    const out = f.filter(noisy, i * 66)
    if (i > 10) maxDev = Math.max(maxDev, Math.abs(out - 0.5))
  }
  expect(maxDev).toBeLessThan(0.03)
})

test('OneEuro: reset olvida el estado', () => {
  const f = new OneEuro({ minCutoff: 1.1, beta: 0.007, dCutoff: 1.0 })
  f.filter(100, 0)
  f.reset()
  expect(f.filter(1, 500)).toBe(1)
})

test('wrapAngle: envuelve a [-π, π]', () => {
  expect(wrapAngle(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 10)
  expect(wrapAngle(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 10)
  expect(wrapAngle(0.5)).toBeCloseTo(0.5, 10)
})

test('clamp', () => {
  expect(clamp(5, 0, 3)).toBe(3)
  expect(clamp(-1, 0, 3)).toBe(0)
  expect(clamp(2, 0, 3)).toBe(2)
})
