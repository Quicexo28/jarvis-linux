import { test, expect, beforeEach } from 'vitest'
import {
  getSpeakerMode,
  getSpeakerName,
  setSpeakerMode,
  resetSession,
  filterIntentsByMode,
  incrementTurnCount,
  getTurnCount,
} from '../src/lib/speakerContext.js'

beforeEach(() => resetSession())

test('default mode after resetSession is UNKNOWN', () => {
  expect(getSpeakerMode()).toBe('UNKNOWN')
})

test('setSpeakerMode OWNER sets mode and name', () => {
  setSpeakerMode('OWNER', 'Santiago')
  expect(getSpeakerMode()).toBe('OWNER')
  expect(getSpeakerName()).toBe('Santiago')
})

test('setSpeakerMode KNOWN sets mode and name', () => {
  setSpeakerMode('KNOWN', 'María')
  expect(getSpeakerMode()).toBe('KNOWN')
  expect(getSpeakerName()).toBe('María')
})

test('setSpeakerMode LOW_CONF clears name', () => {
  setSpeakerMode('OWNER', 'Santiago')
  setSpeakerMode('LOW_CONF', null)
  expect(getSpeakerMode()).toBe('LOW_CONF')
  expect(getSpeakerName()).toBeNull()
})

test('resetSession resets mode to UNKNOWN and clears name', () => {
  setSpeakerMode('OWNER', 'Santiago')
  resetSession()
  expect(getSpeakerMode()).toBe('UNKNOWN')
  expect(getSpeakerName()).toBeNull()
})

test('OWNER: all intents allowed', () => {
  expect(filterIntentsByMode('self_build', 'OWNER')).toBe(true)
  expect(filterIntentsByMode('chat', 'OWNER')).toBe(true)
  expect(filterIntentsByMode('file_delicate', 'OWNER')).toBe(true)
})

test('KNOWN: only limited intents allowed', () => {
  expect(filterIntentsByMode('chat', 'KNOWN')).toBe(true)
  expect(filterIntentsByMode('complex_task', 'KNOWN')).toBe(true)
  expect(filterIntentsByMode('self_build', 'KNOWN')).toBe(false)
  expect(filterIntentsByMode('file_delicate', 'KNOWN')).toBe(false)
})

test('UNKNOWN: same limited set as KNOWN', () => {
  expect(filterIntentsByMode('chat', 'UNKNOWN')).toBe(true)
  expect(filterIntentsByMode('self_build', 'UNKNOWN')).toBe(false)
})

test('LOW_CONF: no intents allowed', () => {
  expect(filterIntentsByMode('chat', 'LOW_CONF')).toBe(false)
  expect(filterIntentsByMode('self_build', 'LOW_CONF')).toBe(false)
})

test('incrementTurnCount returns incremented count', () => {
  expect(incrementTurnCount('Santiago')).toBe(1)
  expect(incrementTurnCount('Santiago')).toBe(2)
  expect(incrementTurnCount('María')).toBe(1)
})

test('getTurnCount returns 0 for unknown speaker', () => {
  expect(getTurnCount('Desconocido')).toBe(0)
})

test('resetSession clears turn counts', () => {
  incrementTurnCount('Santiago')
  incrementTurnCount('Santiago')
  resetSession()
  expect(getTurnCount('Santiago')).toBe(0)
})
