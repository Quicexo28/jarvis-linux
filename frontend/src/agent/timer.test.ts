import { test, expect, beforeEach } from 'vitest'
import { resetRegistry, registerCapabilities, executeCapability } from './registry'
import { timerCapabilities } from './capabilities/timer'
import { routeUtterance } from './router'
import { useTimerStore } from '../state/timerStore'

beforeEach(() => {
  resetRegistry()
  registerCapabilities(timerCapabilities)
  useTimerStore.getState().cancelAll()
})

test('timer.start adds a running timer of the right duration', async () => {
  const out = await executeCapability('timer.start', { seconds: 30 })
  expect(out.ok).toBe(true)
  const timers = useTimerStore.getState().timers
  expect(timers).toHaveLength(1)
  expect(timers[0].status).toBe('running')
  expect(timers[0].durationMs).toBe(30000)
})

test('timer.cancel without id cancels all running timers', async () => {
  await executeCapability('timer.start', { seconds: 10 })
  await executeCapability('timer.start', { seconds: 20 })
  await executeCapability('timer.cancel', {})
  // HEAD store removes cancelled timers rather than tagging them 'cancelled'.
  expect(useTimerStore.getState().timers).toHaveLength(0)
})

test('Tier-0 router handles "pon un temporizador de 30 segundos" locally', async () => {
  const r = await routeUtterance('pon un temporizador de 30 segundos')
  expect(r.kind).toBe('handled')
  const timers = useTimerStore.getState().timers
  expect(timers).toHaveLength(1)
  expect(timers[0].durationMs).toBe(30000)
})

test('Tier-0 router parses minutes', async () => {
  const r = await routeUtterance('ponme una alarma de 2 minutos')
  expect(r.kind).toBe('handled')
  expect(useTimerStore.getState().timers[0].durationMs).toBe(120000)
})
