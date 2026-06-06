import { test, expect, beforeEach } from 'vitest'
import { routeUtterance } from './router'
import { useJarvisStore } from '../state/jarvisStore'

beforeEach(() => {
  localStorage.clear()
  useJarvisStore.setState({ zoomedMode: null, mode: 'home', ringLevel: 'main', activeRingMode: 'home', requestedPlanKey: null })
})

test('empty input is ignored', async () => {
  expect((await routeUtterance('   ')).kind).toBe('ignored')
})

test('"siguiente" rotates the carousel locally (Tier-0)', async () => {
  const r = await routeUtterance('siguiente')
  expect(r.kind).toBe('handled')
  expect(useJarvisStore.getState().activeRingMode).toBe('house')
})

test('"modo casa" navigates locally without the brain', async () => {
  const r = await routeUtterance('modo casa')
  expect(r.kind).toBe('handled')
  expect(useJarvisStore.getState().zoomedMode).toBe('house')
})

test('"llévame al panel de estadísticas" opens system locally', async () => {
  const r = await routeUtterance('llévame al panel de estadísticas')
  expect(r.kind).toBe('handled')
  expect(useJarvisStore.getState().zoomedMode).toBe('system')
})

test('a chained multi-action command is forwarded to the brain', async () => {
  const r = await routeUtterance('abre el editor 3D y carga el último proyecto')
  expect(r.kind).toBe('forward')
  // Tier-0 must not have acted on it.
  expect(useJarvisStore.getState().zoomedMode).toBeNull()
})

test('a free-form question is forwarded to the brain', async () => {
  const r = await routeUtterance('qué dispositivos tengo en la sala de estar ahora mismo')
  expect(r.kind).toBe('forward')
})
