import { test, expect, beforeEach } from 'vitest'
import { runPrimitive } from './primitives'
import { useJarvisStore } from '../state/jarvisStore'

beforeEach(() => {
  const s = useJarvisStore.getState()
  s.setZoomedMode(null); s.setRingLevel('main'); s.setPinchZoomProgress(0)
})

test('view_close limpia un pinch pegado y lo informa', async () => {
  useJarvisStore.getState().setPinchZoomProgress(0.7)
  expect(await runPrimitive('view_close', {})).toEqual({ closed: 'pinch' })
  expect(useJarvisStore.getState().pinchZoomProgress).toBe(0)
})

test('view_close sin nada abierto: noop', async () => {
  expect(await runPrimitive('view_close', {})).toEqual({ closed: 'noop' })
})
