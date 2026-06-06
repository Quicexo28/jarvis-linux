// frontend/src/gestures/state.test.ts
import { test, expect, beforeEach } from 'vitest'
import { HandStateTracker } from './state'
import type { HandFeatures } from './types'

function makeFeatures(overrides: Partial<HandFeatures> = {}): HandFeatures {
  return {
    palmSize: 0.1,
    curl: { thumb: 0.9, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 },
    tipDistances: { thumbIndex: 0.8, thumbIndex2D: 0.08, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 },
    wristPosition: { x: 0, y: 0, z: 0 },
    indexTipPosition: { x: 0, y: 0, z: 0 },
    palmAngle: 0,
    ...overrides,
  }
}

let tracker: HandStateTracker

beforeEach(() => {
  tracker = new HandStateTracker()
})

test('all fingers extended when curl high → isIdle true', () => {
  // Fingers need curl > 0.82 (EXTENDED_ENTER), thumb needs > 0.92
  const state = tracker.update(makeFeatures({
    curl: { thumb: 0.95, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 },
  }))
  expect(state.isIdle).toBe(true)
  expect(state.extendedCount).toBe(5)
  expect(state.fingers.index).toBe('extended')
})

test('all fingers contracted when curl low', () => {
  // Fingers need curl < 0.68 (CONTRACTED_ENTER), thumb needs < 0.85
  const features = makeFeatures({
    curl: { thumb: 0.80, index: 0.5, middle: 0.5, ring: 0.5, pinky: 0.5 },
  })
  const state = tracker.update(features)
  expect(state.fingers.index).toBe('contracted')
  expect(state.fingers.thumb).toBe('contracted')
  expect(state.isIdle).toBe(false)
  expect(state.extendedCount).toBe(0)
})

test('hysteresis prevents flicker at boundary', () => {
  // Start extended (curl=0.9 for fingers, 0.95 for thumb)
  tracker.update(makeFeatures({ curl: { thumb: 0.95, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 } }))
  // Drop to 0.80 — still above exit threshold 0.78, should stay extended
  const state = tracker.update(makeFeatures({ curl: { thumb: 0.95, index: 0.80, middle: 0.80, ring: 0.80, pinky: 0.80 } }))
  expect(state.fingers.index).toBe('extended')
  // Drop to 0.76 — below exit threshold 0.78, should become half
  const state2 = tracker.update(makeFeatures({ curl: { thumb: 0.95, index: 0.76, middle: 0.76, ring: 0.76, pinky: 0.76 } }))
  expect(state2.fingers.index).toBe('half')
})

test('contact thumbIndex enters when distance < 0.55', () => {
  const state = tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.50, thumbIndex2D: 0.05, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  expect(state.contacts.thumbIndex).toBe(true)
})

test('contact thumbIndex has exit hysteresis at 0.65', () => {
  // Enter contact
  tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.50, thumbIndex2D: 0.05, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  // Move to 0.60 — above enter threshold but below exit threshold, stays in contact
  const state = tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.60, thumbIndex2D: 0.06, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  expect(state.contacts.thumbIndex).toBe(true)
  // Move to 0.70 — above exit threshold, loses contact
  const state2 = tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.70, thumbIndex2D: 0.07, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  expect(state2.contacts.thumbIndex).toBe(false)
})
