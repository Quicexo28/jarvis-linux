import { test, expect, beforeEach } from 'vitest'
import { resetRegistry, registerCapabilities, toToolSchemas, executeCapability } from './registry'
import { navigationCapabilities } from './capabilities/navigation'
import { useJarvisStore } from '../state/jarvisStore'

beforeEach(() => {
  resetRegistry()
  registerCapabilities(navigationCapabilities)
  localStorage.clear()
  useJarvisStore.setState({ zoomedMode: null, mode: 'home', ringLevel: 'main', activeRingMode: 'home', requestedPlanKey: null })
})

test('toToolSchemas exposes registered capabilities as tool schemas', () => {
  const schemas = toToolSchemas()
  const names = schemas.map((s) => s.name)
  expect(names).toContain('nav.goto')
  expect(names).toContain('plan.loadLast')
  const goto = schemas.find((s) => s.name === 'nav.goto')!
  expect(goto.input_schema.required).toEqual(['mode'])
})

test('executeCapability runs nav.goto and mutates the store', async () => {
  const out = await executeCapability('nav.goto', { mode: 'system' })
  expect(out.ok).toBe(true)
  expect(useJarvisStore.getState().zoomedMode).toBe('system')
  expect(out.snapshot.zoomedMode).toBe('system')
})

test('executeCapability rejects an invalid enum value', async () => {
  const out = await executeCapability('nav.goto', { mode: 'nope' })
  expect(out.ok).toBe(false)
  expect(out.result.detail).toMatch(/inválido/i)
  expect(useJarvisStore.getState().zoomedMode).toBeNull()
})

test('executeCapability rejects a missing required param', async () => {
  const out = await executeCapability('nav.goto', {})
  expect(out.ok).toBe(false)
  expect(out.result.detail).toMatch(/requerido/i)
})

test('executeCapability reports an unknown capability', async () => {
  const out = await executeCapability('does.not.exist', {})
  expect(out.ok).toBe(false)
  expect(out.result.detail).toMatch(/desconocida/i)
})
