// frontend/src/gestures/modifiers.test.ts
import { test, expect, beforeEach } from 'vitest'
import { ModifierLayer } from './modifiers'
import type { HandState, ActiveGesture } from './types'

function makeHandState(pinky: 'extended' | 'half' | 'contracted' = 'contracted'): HandState {
  return {
    fingers: { thumb: 'contracted', index: 'contracted', middle: 'contracted', ring: 'contracted', pinky },
    contacts: { thumbIndex: true },
    isIdle: false,
    extendedCount: pinky === 'extended' ? 1 : 0,
  }
}

let modifier: ModifierLayer

beforeEach(() => {
  modifier = new ModifierLayer()
})

test('status is none when no active gesture', () => {
  const status = modifier.update(makeHandState('extended'), null, 0.5, 0)
  expect(status.type).toBe('none')
})

test('transitions to paused when pinky extends during pinch', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  const status = modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  expect(status.type).toBe('paused')
  if (status.type === 'paused') {
    expect(status.frozenValue).toBe(1.5)
  }
})

test('transitions to waiting_resume when pinky lowers after pause', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  const status = modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  expect(status.type).toBe('waiting_resume')
})

test('resumes when distance matches target within tolerance', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  // Return to within tolerance of 0.08 target
  const status = modifier.update(makeHandState('contracted'), gesture, 0.082, 200)
  expect(status.type).toBe('none')
})

test('times out after 3s without match', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  // 3.1 seconds later, still not matched
  const status = modifier.update(makeHandState('contracted'), gesture, 0.30, 3200)
  expect(status.type).toBe('none')
})

test('re-pauses if pinky extends again during waiting_resume', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  const status = modifier.update(makeHandState('extended'), gesture, 0.12, 200)
  expect(status.type).toBe('paused')
})
