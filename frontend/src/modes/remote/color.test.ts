import { describe, it, expect } from 'vitest'
import { pointToHs, hsToPoint, hsvToRgb, rgbToHex, hsvToHex, hexToHsv } from './color'

describe('pointToHs', () => {
  it('puts hue 0 at the top and runs clockwise, like the conic-gradient', () => {
    expect(pointToHs(0, -100, 100).h).toBeCloseTo(0)
    expect(pointToHs(100, 0, 100).h).toBeCloseTo(90)
    expect(pointToHs(0, 100, 100).h).toBeCloseTo(180)
    expect(pointToHs(-100, 0, 100).h).toBeCloseTo(270)
  })

  it('saturates from the centre outwards and clamps past the rim', () => {
    expect(pointToHs(0, 0, 100).s).toBe(0)
    expect(pointToHs(50, 0, 100).s).toBeCloseTo(0.5)
    expect(pointToHs(180, 0, 100).s).toBe(1)
  })
})

it('hsToPoint round-trips through pointToHs', () => {
  const { dx, dy } = hsToPoint(210, 0.6, 100)
  const back = pointToHs(dx, dy, 100)
  expect(back.h).toBeCloseTo(210)
  expect(back.s).toBeCloseTo(0.6)
})

describe('hsvToRgb', () => {
  it('hits the primaries', () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0])
    expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0])
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255])
  })

  it('desaturates to white and darkens to black', () => {
    expect(hsvToRgb(37, 0, 1)).toEqual([255, 255, 255])
    expect(hsvToRgb(37, 1, 0)).toEqual([0, 0, 0])
  })

  it('wraps hue instead of breaking at 360', () => {
    expect(hsvToRgb(360, 1, 1)).toEqual(hsvToRgb(0, 1, 1))
    expect(hsvToRgb(-60, 1, 1)).toEqual(hsvToRgb(300, 1, 1))
  })
})

it('rgbToHex pads and clamps', () => {
  expect(rgbToHex(255, 0, 128)).toBe('ff0080')
  expect(rgbToHex(0, 5, 300)).toBe('0005ff')
})

it('hsvToHex gives the argv rgb_ctl.py expects (no #)', () => {
  expect(hsvToHex(0, 1, 1)).toBe('ff0000')
  expect(hsvToHex(180, 1, 0.5)).toBe('008080')
})

describe('hexToHsv', () => {
  it('round-trips through hsvToHex', () => {
    for (const [h, s, v] of [[0, 1, 1], [120, 0.5, 0.8], [275, 1, 0.25]] as const) {
      const back = hexToHsv(hsvToHex(h, s, v))
      expect(back.h).toBeCloseTo(h, 0)
      expect(back.s).toBeCloseTo(s, 1)
      expect(back.v).toBeCloseTo(v, 1)
    }
  })

  it('accepts the # the state file writes and greys have no hue', () => {
    expect(hexToHsv('#FF0000')).toEqual({ h: 0, s: 1, v: 1 })
    expect(hexToHsv('808080').s).toBe(0)
  })
})
