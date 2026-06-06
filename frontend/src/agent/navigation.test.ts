import { test, expect, beforeEach } from 'vitest'
import { resetRegistry, registerCapabilities, executeCapability } from './registry'
import { navigationCapabilities } from './capabilities/navigation'
import { useJarvisStore } from '../state/jarvisStore'
import { useBootStore } from '../state/bootStore'
import { PLAN_STORAGE_KEY } from '../constants'

beforeEach(() => {
  resetRegistry()
  registerCapabilities(navigationCapabilities)
  localStorage.clear()
  useJarvisStore.setState({ zoomedMode: null, mode: 'home', ringLevel: 'main', activeRingMode: 'home', requestedPlanKey: null })
  useBootStore.setState({ bootState: 'AWAKE' })
})

test('nav.back closes a zoomed mode', async () => {
  useJarvisStore.getState().setZoomedMode('system')
  await executeCapability('nav.back', {})
  expect(useJarvisStore.getState().zoomedMode).toBeNull()
})

test('nav.ring.rotate advances the carousel when nothing is zoomed', async () => {
  useJarvisStore.setState({ activeRingMode: 'home', zoomedMode: null })
  const out = await executeCapability('nav.ring.rotate', { dir: 1 })
  expect(out.ok).toBe(true)
  expect(useJarvisStore.getState().activeRingMode).toBe('house')
})

test('nav.ring.rotate refuses while a view is open', async () => {
  useJarvisStore.getState().setZoomedMode('plan3d')
  const out = await executeCapability('nav.ring.rotate', { dir: 1 })
  expect(out.ok).toBe(false)
})

test('plan.loadLast picks the most recent plan and requests it', async () => {
  const plans = [
    { room: 'Sala', name: 'v1', segments: [], updatedAt: '2026-01-01T00:00:00.000Z' },
    { room: 'Sala', name: 'v2', segments: [], updatedAt: '2026-05-01T00:00:00.000Z' },
  ]
  localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans))
  const out = await executeCapability('plan.loadLast', {})
  expect(out.ok).toBe(true)
  expect(useJarvisStore.getState().requestedPlanKey).toBe('Sala::v2')
})

test('plan.loadLast fails gracefully with no saved plans', async () => {
  const out = await executeCapability('plan.loadLast', {})
  expect(out.ok).toBe(false)
  expect(useJarvisStore.getState().requestedPlanKey).toBeNull()
})

test('system.sleep moves boot state to DORMANT', async () => {
  await executeCapability('system.sleep', {})
  expect(useBootStore.getState().bootState).toBe('DORMANT')
})
