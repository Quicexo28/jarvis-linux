// frontend/src/gestures/recognizer.test.ts
import { test, expect, beforeEach } from 'vitest'
import { GestureRecognizer } from './recognizer'
import type { HandState, HandFeatures } from './types'

function makeState(
  fingers: Record<string, 'extended' | 'half' | 'contracted'>,
  contacts = { thumbIndex: false },
): HandState {
  const f = {
    thumb: 'extended' as const,
    index: 'extended' as const,
    middle: 'extended' as const,
    ring: 'extended' as const,
    pinky: 'extended' as const,
    ...fingers,
  }
  const extendedCount = Object.values(f).filter(v => v === 'extended').length
  return {
    fingers: f,
    contacts,
    isIdle: extendedCount === 5,
    extendedCount,
  }
}

function makeFeatures(tipDistances = { thumbIndex: 0.8, thumbIndex2D: 0.08, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 }): HandFeatures {
  return {
    palmSize: 0.1,
    curl: { thumb: 0.9, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 },
    tipDistances,
    wristPosition: { x: 0, y: 0, z: 0 },
    indexTipPosition: { x: 0, y: 0, z: 0 },
    palmAngle: 0,
  }
}

let recognizer: GestureRecognizer

beforeEach(() => {
  recognizer = new GestureRecognizer()
})

test('left hand: all contracted = grab', () => {
  const state = makeState({ thumb: 'contracted', index: 'contracted', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  const result = recognizer.update(state, null, makeFeatures(), null, 0)
  expect(result.left).toBe('grab')
})

test('left hand: index extended only = point', () => {
  const state = makeState({ thumb: 'contracted', index: 'extended', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  const result = recognizer.update(state, null, makeFeatures(), null, 0)
  expect(result.left).toBe('point')
})

test('left hand: index+middle extended + separated = peace_sep', () => {
  const state = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const features = makeFeatures({ thumbIndex: 0.8, thumbIndex2D: 0.08, indexMiddle: 0.5, middleRing: 0.3, ringPinky: 0.3 })
  const result = recognizer.update(state, null, features, null, 0)
  expect(result.left).toBe('peace_sep')
})

test('left hand: index+middle extended + together = peace_close', () => {
  const state = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const features = makeFeatures({ thumbIndex: 0.8, thumbIndex2D: 0.08, indexMiddle: 0.2, middleRing: 0.3, ringPinky: 0.3 })
  const result = recognizer.update(state, null, features, null, 0)
  expect(result.left).toBe('peace_close')
})

test('left hand: all extended = idle', () => {
  const state = makeState({})
  const result = recognizer.update(state, null, makeFeatures(), null, 0)
  expect(result.left).toBe('idle')
})

test('right hand: middle+ring+pinky contracted with thumbIndex close = pinch', () => {
  const state = makeState({ middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  const features = makeFeatures({ thumbIndex: 0.4, thumbIndex2D: 0.04, indexMiddle: 0.6, middleRing: 0.3, ringPinky: 0.3 })
  const result = recognizer.update(null, state, null, features, 0)
  expect(result.right).toBe('pinch')
})

test('right hand: all extended = idle', () => {
  const state = makeState({})
  const result = recognizer.update(null, state, null, makeFeatures(), 0)
  expect(result.right).toBe('idle')
})

test('discrete release: peace_sep emits click after >150ms hold', () => {
  const peaceState = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const sepFeatures = makeFeatures({ thumbIndex: 0.8, thumbIndex2D: 0.08, indexMiddle: 0.5, middleRing: 0.3, ringPinky: 0.3 })
  // Hold for 200ms
  recognizer.update(peaceState, null, sepFeatures, null, 0)
  recognizer.update(peaceState, null, sepFeatures, null, 100)
  recognizer.update(peaceState, null, sepFeatures, null, 200)
  // Release (go to idle)
  const idleState = makeState({})
  recognizer.update(idleState, null, makeFeatures(), null, 250)
  expect(recognizer.consumeDiscreteEvents().click).toBe(true)
})

test('discrete anti-bounce: pose <150ms does not emit', () => {
  const peaceState = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const sepFeatures = makeFeatures({ thumbIndex: 0.8, thumbIndex2D: 0.08, indexMiddle: 0.5, middleRing: 0.3, ringPinky: 0.3 })
  // Hold for only 100ms
  recognizer.update(peaceState, null, sepFeatures, null, 0)
  recognizer.update(peaceState, null, sepFeatures, null, 100)
  // Release quickly
  const idleState = makeState({})
  recognizer.update(idleState, null, makeFeatures(), null, 120)
  expect(recognizer.consumeDiscreteEvents().click).toBe(false)
})
