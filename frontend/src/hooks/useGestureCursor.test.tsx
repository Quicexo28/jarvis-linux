// Integración del cursor de mano contra el DOM REAL (jsdom): muestra de gesto →
// imantado → evento de puntero → `onClick` del botón. Es la única forma de
// verificar sin cámara que "señalar y tocar pulsa el menú": los tests puros de
// hitTest/cursorController cubren la lógica, pero no que los eventos
// sintetizados lleguen a un `<button>` de verdad.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useGestureCursor } from './useGestureCursor'
import { useGestureStore } from '../state/gestureStore'
import { useCursorStore } from '../state/cursorStore'
import { DEFAULT_OUTPUT } from '../gestures/types'
import type { GestureOutput } from '../gestures/types'

const BTN = { left: 100, top: 100, width: 120, height: 30 }

let container: HTMLDivElement
let root: Root
let button: HTMLButtonElement
let clicks: number

function Harness() {
  useGestureCursor(true)
  return null
}

/** jsdom no implementa layout: hay que fabricar el rect y el hit-test. */
function stubGeometry() {
  button.getBoundingClientRect = () => ({
    ...BTN,
    right: BTN.left + BTN.width,
    bottom: BTN.top + BTN.height,
    x: BTN.left, y: BTN.top,
    toJSON: () => ({}),
  }) as DOMRect
  document.elementFromPoint = (x: number, y: number) =>
    x >= BTN.left && x <= BTN.left + BTN.width && y >= BTN.top && y <= BTN.top + BTN.height
      ? button
      : document.body
}

/** Píxeles de ventana → coordenadas normalizadas del pipeline. */
function at(px: number, py: number): { screenX: number; screenY: number } {
  return { screenX: px / window.innerWidth, screenY: py / window.innerHeight }
}

function emit(patch: Partial<GestureOutput>) {
  const base: GestureOutput = { ...DEFAULT_OUTPUT, ...patch }
  act(() => { useGestureStore.getState().setOutput(base) })
}

beforeEach(() => {
  clicks = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  button = document.createElement('button')
  button.textContent = 'Modo casa'
  button.addEventListener('click', () => { clicks++ })
  document.body.appendChild(button)
  stubGeometry()
  vi.spyOn(performance, 'now').mockReturnValue(0)
  root = createRoot(container)
  act(() => { root.render(<Harness />) })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  button.remove()
  vi.restoreAllMocks()
  useGestureStore.getState().setOutput(DEFAULT_OUTPUT)
  useCursorStore.getState().set({ visible: false, target: null, pressed: false, dwell: 0 })
})

const pointAt = (px: number, py: number, tap = { pressed: false, down: false, up: false }) =>
  emit({ point: { active: true, ...at(px, py), vx: 0, vy: 0 }, tap })

test('señalar un botón y tocar → su onClick se ejecuta', () => {
  pointAt(150, 112)
  expect(clicks).toBe(0)
  expect(button.classList.contains('gesture-hover')).toBe(true)

  pointAt(150, 112, { pressed: true, down: true, up: false })
  expect(useCursorStore.getState().pressed).toBe(true)

  pointAt(150, 112, { pressed: false, down: false, up: true })
  expect(clicks).toBe(1)
  expect(useCursorStore.getState().pressed).toBe(false)
})

test('el imán alcanza un botón que el dedo no acierta por poco', () => {
  // 18 px por encima del borde: fuera del rect, dentro del radio de imantado.
  pointAt(150, 82)
  const { x, y, target } = useCursorStore.getState()
  expect(target).not.toBeNull()
  expect(y).toBeGreaterThan(BTN.top)
  expect(x).toBe(150)

  pointAt(150, 82, { pressed: true, down: true, up: false })
  pointAt(150, 82, { pressed: false, down: false, up: true })
  expect(clicks).toBe(1)
})

test('lejos del botón no engancha ni pulsa nada', () => {
  pointAt(600, 600)
  expect(useCursorStore.getState().target).toBeNull()
  expect(button.classList.contains('gesture-hover')).toBe(false)

  pointAt(600, 600, { pressed: true, down: true, up: false })
  pointAt(600, 600, { pressed: false, down: false, up: true })
  expect(clicks).toBe(0)
})

test('perder la mano limpia el hover y esconde el cursor', () => {
  pointAt(150, 112)
  expect(useCursorStore.getState().visible).toBe(true)
  emit({ point: { active: false, screenX: 0, screenY: 0, vx: 0, vy: 0 } })
  expect(useCursorStore.getState().visible).toBe(false)
  expect(button.classList.contains('gesture-hover')).toBe(false)
})

test('los eventos sintéticos llevan la marca __gesture (el anillo la usa)', () => {
  let marked: boolean | null = null
  button.addEventListener('click', (e) => {
    marked = (e as MouseEvent & { __gesture?: boolean }).__gesture === true
  })
  pointAt(150, 112)
  pointAt(150, 112, { pressed: true, down: true, up: false })
  pointAt(150, 112, { pressed: false, down: false, up: true })
  expect(marked).toBe(true)
})

test('el adelanto predictivo desplaza el cursor en el sentido del movimiento', () => {
  document.elementFromPoint = () => document.body
  emit({ point: { active: true, ...at(600, 400), vx: 0.0006, vy: 0 } })
  const withLead = useCursorStore.getState().x
  emit({ point: { active: true, ...at(600, 400), vx: 0, vy: 0 } })
  const without = useCursorStore.getState().x
  expect(withLead).toBeGreaterThan(without)
})
