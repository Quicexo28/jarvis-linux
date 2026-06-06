// frontend/src/gestures/output.test.ts
import { test, expect, beforeEach } from 'vitest'
import { OutputProcessor } from './output'
import type { GestureResult, HandFeatures, ModifierStatus } from './types'

function makeFeatures(overrides: Partial<HandFeatures> = {}): HandFeatures {
  return {
    palmSize: 0.1,
    curl: { thumb: 0.9, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 },
    tipDistances: { thumbIndex: 0.1, thumbIndex2D: 0.01, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 },
    wristPosition: { x: 0, y: 0, z: 0 },
    indexTipPosition: { x: 0.5, y: 0.5, z: 0 },
    palmAngle: 0,
    ...overrides,
  }
}

let processor: OutputProcessor

beforeEach(() => {
  processor = new OutputProcessor()
})

test('grab output tracks wrist delta from onset', () => {
  const gesture: GestureResult = { left: 'grab', right: 'idle' }
  const modifier: ModifierStatus = { type: 'none' }
  // First frame: onset
  processor.update(gesture, makeFeatures({ wristPosition: { x: 0.3, y: 0.4, z: 0 } }), null, modifier, false, false)
  // Second frame: moved
  const output = processor.update(gesture, makeFeatures({ wristPosition: { x: 0.35, y: 0.42, z: 0 } }), null, modifier, false, false)
  expect(output.grab.active).toBe(true)
  expect(output.grab.deltaX).toBeCloseTo(0.5, 1) // (0.35-0.3)/0.1
  expect(output.grab.deltaY).toBeCloseTo(0.2, 1) // (0.42-0.4)/0.1
})

test('grab resets delta on re-entry', () => {
  const modifier: ModifierStatus = { type: 'none' }
  // Activate grab
  processor.update({ left: 'grab', right: 'idle' }, makeFeatures({ wristPosition: { x: 0.3, y: 0.4, z: 0 } }), null, modifier, false, false)
  // Deactivate
  processor.update({ left: 'idle', right: 'idle' }, makeFeatures(), null, modifier, false, false)
  // Re-activate at new position
  const output = processor.update({ left: 'grab', right: 'idle' }, makeFeatures({ wristPosition: { x: 0.5, y: 0.5, z: 0 } }), null, modifier, false, false)
  expect(output.grab.deltaX).toBeCloseTo(0, 1) // fresh onset, no delta
})

test('point output maps index tip position', () => {
  const gesture: GestureResult = { left: 'point', right: 'idle' }
  const modifier: ModifierStatus = { type: 'none' }
  const output = processor.update(gesture, makeFeatures({ indexTipPosition: { x: 0.7, y: 0.3, z: 0 } }), null, modifier, false, false)
  expect(output.point.active).toBe(true)
  expect(output.point.screenX).toBeCloseTo(0.7, 2)
  expect(output.point.screenY).toBeCloseTo(0.3, 2)
})

test('pinch zoom uses smoothing toward target', () => {
  const gesture: GestureResult = { left: 'idle', right: 'pinch' }
  const modifier: ModifierStatus = { type: 'none' }
  // Fingers far apart (thumbIndex2D = MAX_PINCH_DIST = 0.08) → target zoom = MAX_ZOOM (3.0).
  const features = makeFeatures({ tipDistances: { thumbIndex: 0.8, thumbIndex2D: 0.08, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } })
  // Multiple frames to accumulate smoothing toward the target.
  let output = processor.update(gesture, null, features, modifier, false, false)
  for (let i = 0; i < 30; i++) {
    output = processor.update(gesture, null, features, modifier, false, false)
  }
  expect(output.pinch.active).toBe(true)
  expect(output.pinch.zoom).toBeGreaterThan(2.5) // smoothed value approaches 3.0 after many frames
})

test('pinch paused returns frozen value', () => {
  const gesture: GestureResult = { left: 'idle', right: 'pinch' }
  const modifier: ModifierStatus = { type: 'paused', frozenValue: 1.8 }
  const features = makeFeatures({ tipDistances: { thumbIndex: 0.04, thumbIndex2D: 0.015, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } })
  const output = processor.update(gesture, null, features, modifier, false, false)
  expect(output.pinch.paused).toBe(true)
  expect(output.pinch.zoom).toBe(1.8)
})

test('click and back pass through from discrete events', () => {
  const gesture: GestureResult = { left: 'idle', right: 'idle' }
  const modifier: ModifierStatus = { type: 'none' }
  const output = processor.update(gesture, makeFeatures(), null, modifier, true, false)
  expect(output.click).toBe(true)
  expect(output.back).toBe(false)
})
