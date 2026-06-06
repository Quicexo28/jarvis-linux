import { test, expect } from 'vitest'
import { extractFeatures } from './features'
import type { Vec3 } from './types'

// Helper: create a landmark array of 21 points
function makeLandmarks(overrides: Partial<Record<number, Vec3>> = {}): Vec3[] {
  const base: Vec3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }))
  // Default: wrist at origin, middle_MCP at (0, 0.1, 0) → palmSize = 0.1
  base[0] = { x: 0, y: 0, z: 0 }
  base[9] = { x: 0, y: 0.1, z: 0 }
  for (const [idx, val] of Object.entries(overrides)) {
    if (val) base[Number(idx)] = val
  }
  return base
}

test('palmSize is distance between wrist[0] and middle_MCP[9]', () => {
  const landmarks = makeLandmarks({
    0: { x: 0, y: 0, z: 0 },
    9: { x: 0.03, y: 0.04, z: 0 },
  })
  const features = extractFeatures(landmarks)
  expect(features.palmSize).toBeCloseTo(0.05, 5)
})

test('curl ratio is 1.0 for a fully extended finger', () => {
  // Index: MCP[5], PIP[6], DIP[7], TIP[8] in a straight line
  const landmarks = makeLandmarks({
    5: { x: 0, y: 0, z: 0 },
    6: { x: 0, y: 0.03, z: 0 },
    7: { x: 0, y: 0.06, z: 0 },
    8: { x: 0, y: 0.09, z: 0 },
  })
  const features = extractFeatures(landmarks)
  expect(features.curl.index).toBeCloseTo(1.0, 2)
})

test('curl ratio is low for a contracted finger', () => {
  // Index: TIP curled back near MCP
  const landmarks = makeLandmarks({
    5: { x: 0, y: 0, z: 0 },
    6: { x: 0, y: 0.03, z: 0 },
    7: { x: 0, y: 0.04, z: 0.02 },
    8: { x: 0, y: 0.01, z: 0.01 },
  })
  const features = extractFeatures(landmarks)
  expect(features.curl.index).toBeLessThan(0.5)
})

test('tipDistances are normalized by palmSize', () => {
  const landmarks = makeLandmarks({
    0: { x: 0, y: 0, z: 0 },
    9: { x: 0, y: 0.1, z: 0 }, // palmSize = 0.1
    4: { x: 0, y: 0, z: 0 },   // thumb tip
    8: { x: 0, y: 0.05, z: 0 }, // index tip → raw distance 0.05
  })
  const features = extractFeatures(landmarks)
  expect(features.tipDistances.thumbIndex).toBeCloseTo(0.5, 2) // 0.05 / 0.1
})

test('wristPosition and indexTipPosition are extracted directly', () => {
  const landmarks = makeLandmarks({
    0: { x: 0.1, y: 0.2, z: 0.3 },
    8: { x: 0.4, y: 0.5, z: 0.6 },
  })
  const features = extractFeatures(landmarks)
  expect(features.wristPosition).toEqual({ x: 0.1, y: 0.2, z: 0.3 })
  expect(features.indexTipPosition).toEqual({ x: 0.4, y: 0.5, z: 0.6 })
})

test('palmAngle is atan2 of wrist→middle-MCP vector', () => {
  // wrist at origin, middle-MCP straight up (+y) → atan2(0.1, 0) = π/2
  const up = extractFeatures(makeLandmarks({ 0: { x: 0, y: 0, z: 0 }, 9: { x: 0, y: 0.1, z: 0 } }))
  expect(up.palmAngle).toBeCloseTo(Math.PI / 2)
  // middle-MCP to the right (+x) → atan2(0, 0.1) = 0
  const right = extractFeatures(makeLandmarks({ 0: { x: 0, y: 0, z: 0 }, 9: { x: 0.1, y: 0, z: 0 } }))
  expect(right.palmAngle).toBeCloseTo(0)
})
