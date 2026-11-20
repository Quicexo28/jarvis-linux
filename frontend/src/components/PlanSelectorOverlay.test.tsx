import { test, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PlanSelectorOverlay } from './PlanSelectorOverlay'
import type { SavedPlan } from '../types'

test('"← Volver" llama onCancel y no onSkip', () => {
  const onCancel = vi.fn(), onSkip = vi.fn(), onSelect = vi.fn()
  const plans = [{ room: 'sala', name: 'a' }] as unknown as SavedPlan[]
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  act(() => { root.render(<PlanSelectorOverlay plans={plans} onSelect={onSelect} onSkip={onSkip} onCancel={onCancel} />) })
  const btn = Array.from(el.querySelectorAll('button')).find(b => b.textContent?.includes('Volver'))!
  act(() => { btn.click() })
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(onSkip).not.toHaveBeenCalled()
  act(() => root.unmount())
  el.remove()
})
