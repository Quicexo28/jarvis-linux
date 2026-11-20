import { test, expect } from 'vitest'
import { runPrimitive } from './primitives'
import { useUiStore } from '../state/uiStore'

test('overlay_open/close text_input abre y cierra el cuadro de texto', async () => {
  expect(await runPrimitive('overlay_open', { name: 'text_input' })).toEqual({ opened: 'text_input' })
  expect(useUiStore.getState().textInputOpen).toBe(true)
  expect(await runPrimitive('overlay_close', { name: 'text_input' })).toEqual({ closed: 'text_input' })
  expect(useUiStore.getState().textInputOpen).toBe(false)
})
