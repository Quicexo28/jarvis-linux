import { describe, it, expect } from 'vitest'
import { applyEMA, applyDeadZone, applyNonLinear } from './gestureRotationHelpers'

describe('applyEMA', () => {
  it('moves toward target by alpha fraction', () => {
    expect(applyEMA(0, 1, 0.5)).toBeCloseTo(0.5)
    expect(applyEMA(0.5, 1, 0.5)).toBeCloseTo(0.75)
  })
  it('reaches target instantly when alpha=1', () => {
    expect(applyEMA(0, 1, 1)).toBe(1)
  })
  it('stays put when alpha=0', () => {
    expect(applyEMA(0.5, 1, 0)).toBe(0.5)
  })
  it('works with negative values', () => {
    expect(applyEMA(-0.5, -1, 0.5)).toBeCloseTo(-0.75)
  })
})

describe('applyDeadZone', () => {
  it('returns 0 for values below threshold', () => {
    expect(applyDeadZone(0.01, 0.02)).toBe(0)
    expect(applyDeadZone(-0.01, 0.02)).toBe(0)
  })
  it('subtracts threshold from magnitude when above threshold', () => {
    expect(applyDeadZone(0.05, 0.02)).toBeCloseTo(0.03)
    expect(applyDeadZone(-0.05, 0.02)).toBeCloseTo(-0.03)
  })
  it('returns 0 exactly at threshold', () => {
    expect(applyDeadZone(0.02, 0.02)).toBe(0)
  })
  it('passes value through when threshold is 0', () => {
    expect(applyDeadZone(0.05, 0)).toBe(0.05)
  })
})

describe('applyNonLinear', () => {
  it('preserves sign of negative input', () => {
    expect(applyNonLinear(-0.5, 1.5)).toBeCloseTo(-Math.pow(0.5, 1.5))
  })
  it('returns 0 for 0 input', () => {
    expect(applyNonLinear(0, 1.5)).toBe(0)
  })
  it('compresses small values relative to large (exponent > 1)', () => {
    const small = Math.abs(applyNonLinear(0.1, 2))
    const large = Math.abs(applyNonLinear(0.9, 2))
    expect(small / large).toBeLessThan(0.1 / 0.9)
  })
  it('is linear when exponent=1', () => {
    expect(applyNonLinear(0.5, 1)).toBeCloseTo(0.5)
    expect(applyNonLinear(-0.3, 1)).toBeCloseTo(-0.3)
  })
})
