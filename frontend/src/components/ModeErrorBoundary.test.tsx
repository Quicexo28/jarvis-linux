import { test, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ModeErrorBoundary } from './ModeErrorBoundary'

function Boom(): never { throw new Error('boom') }

afterEach(() => { vi.restoreAllMocks() })

function mount(ui: React.ReactElement) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  act(() => { root.render(ui) })
  return { el, unmount: () => { act(() => root.unmount()); el.remove() } }
}

test('hijo que lanza: no renderiza y onFail se llama una vez', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const onFail = vi.fn()
  const m = mount(<ModeErrorBoundary onFail={onFail}><Boom /></ModeErrorBoundary>)
  expect(m.el.innerHTML).toBe('')
  expect(onFail).toHaveBeenCalledTimes(1)
  m.unmount()
})

test('hijo sano: se renderiza', () => {
  const onFail = vi.fn()
  const m = mount(<ModeErrorBoundary onFail={onFail}><span>ok</span></ModeErrorBoundary>)
  expect(m.el.textContent).toBe('ok')
  expect(onFail).not.toHaveBeenCalled()
  m.unmount()
})
