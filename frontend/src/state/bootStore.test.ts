import { test, expect, beforeEach } from 'vitest'
import { useBootStore } from './bootStore'

beforeEach(() => {
  useBootStore.setState({ bootState: 'DORMANT' })
})

test('initial bootState is DORMANT', () => {
  expect(useBootStore.getState().bootState).toBe('DORMANT')
})

test('setBootState transitions to AWAKE', () => {
  useBootStore.getState().setBootState('AWAKE')
  expect(useBootStore.getState().bootState).toBe('AWAKE')
})

test('setBootState can return to DORMANT from AWAKE', () => {
  useBootStore.getState().setBootState('AWAKE')
  useBootStore.getState().setBootState('DORMANT')
  expect(useBootStore.getState().bootState).toBe('DORMANT')
})

test('silentWake transitions directly to AWAKE from DORMANT', () => {
  useBootStore.getState().silentWake()
  expect(useBootStore.getState().bootState).toBe('AWAKE')
})
