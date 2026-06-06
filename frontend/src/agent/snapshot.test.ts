import { test, expect, beforeEach } from 'vitest'
import { buildSnapshot } from './snapshot'
import { useJarvisStore } from '../state/jarvisStore'
import { useBootStore } from '../state/bootStore'
import { PLAN_STORAGE_KEY, PLAN3D_ENTITY_STORAGE_KEY } from '../constants'

beforeEach(() => {
  localStorage.clear()
  useJarvisStore.setState({
    mode: 'home', zoomedMode: null, ringLevel: 'main', activeRingMode: 'home',
    voiceEnabled: true, focusedEntity: null, requestedPlanKey: null,
  })
  useBootStore.setState({ bootState: 'AWAKE' })
})

test('snapshot reflects current store state', () => {
  useJarvisStore.getState().setZoomedMode('plan3d')
  const snap = buildSnapshot()
  expect(snap.zoomedMode).toBe('plan3d')
  expect(snap.bootState).toBe('AWAKE')
  expect(snap.voiceEnabled).toBe(true)
})

test('snapshot lists saved plans and resolves the active plan key', () => {
  const plans = [{ room: 'Sala', name: 'v2', segments: [], updatedAt: '2026-05-01T00:00:00.000Z' }]
  localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans))
  localStorage.setItem(PLAN3D_ENTITY_STORAGE_KEY, JSON.stringify({
    'Sala::v2': [{ id: 'tv-1', label: 'TV', kind: 'tv' }],
  }))
  useJarvisStore.getState().setRequestedPlanKey('Sala::v2')

  const snap = buildSnapshot()
  expect(snap.plans).toHaveLength(1)
  expect(snap.activePlanKey).toBe('Sala::v2')
  expect(snap.activePlanEntities).toEqual([{ id: 'tv-1', label: 'TV', kind: 'tv' }])
})
