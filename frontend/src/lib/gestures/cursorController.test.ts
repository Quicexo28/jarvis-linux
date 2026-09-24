import { test, expect, beforeEach } from 'vitest'
import { CursorController, type CursorSample } from './cursorController'
import { CURSOR_DWELL_MS, CURSOR_DWELL_CANCEL_PX } from '../../gestures/config'

interface Log {
  enter: string[]
  leave: string[]
  press: (string | null)[]
  release: (string | null)[]
  click: { id: string | null; via: string }[]
  dwell: number[]
  exits: number
}

let log: Log
let controller: CursorController
/** Objetivo "activo" del resolvedor de prueba: id que devuelve, o null. */
let resolveId: string | null = null

beforeEach(() => {
  log = { enter: [], leave: [], press: [], release: [], click: [], dwell: [], exits: 0 }
  resolveId = null
  controller = new CursorController({
    resolve: (x, y) => ({ id: resolveId, x, y }),
    onMove: () => {},
    onEnter: (id) => log.enter.push(id),
    onLeave: (id) => log.leave.push(id),
    onPress: (id) => log.press.push(id),
    onRelease: (id) => log.release.push(id),
    onClick: (id, _x, _y, via) => log.click.push({ id, via }),
    onDwell: (p) => log.dwell.push(p),
    onExit: () => { log.exits++ },
  })
})

const s = (v: Partial<CursorSample> & { t: number }): CursorSample =>
  ({ active: true, x: 10, y: 10, pressed: false, down: false, up: false, ...v })

test('entrar y salir de un objetivo emite enter/leave una sola vez', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: 50 }))
  expect(log.enter).toEqual(['a'])
  resolveId = 'b'
  controller.update(s({ t: 100 }))
  expect(log.leave).toEqual(['a'])
  expect(log.enter).toEqual(['a', 'b'])
})

test('tap sobre el mismo objetivo → click', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: 50, pressed: true, down: true }))
  expect(log.press).toEqual(['a'])
  controller.update(s({ t: 150, pressed: false, up: true }))
  expect(log.release).toEqual(['a'])
  expect(log.click).toEqual([{ id: 'a', via: 'tap' }])
})

test('soltar sobre OTRO objetivo no hace click (igual que arrastrar fuera con el ratón)', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: 50, pressed: true, down: true }))
  resolveId = 'b'
  controller.update(s({ t: 150, pressed: false, up: true }))
  expect(log.click).toEqual([])
})

test('presión abandonada sin `up` (pose perdida) suelta sin click', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: 50, pressed: true, down: true }))
  controller.update(s({ t: 120, pressed: false }))
  expect(log.release.length).toBe(1)
  expect(log.click).toEqual([])
})

test('dwell: quieto sobre el objetivo dispara un click por permanencia', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: CURSOR_DWELL_MS / 2 }))
  expect(log.click).toEqual([])
  expect(Math.max(...log.dwell)).toBeGreaterThan(0.4)
  controller.update(s({ t: CURSOR_DWELL_MS + 10 }))
  expect(log.click).toEqual([{ id: 'a', via: 'dwell' }])
})

test('dwell no se repite mientras no cambie el objetivo', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: CURSOR_DWELL_MS + 10 }))
  controller.update(s({ t: CURSOR_DWELL_MS * 3 }))
  expect(log.click.length).toBe(1)
})

test('mover el cursor cancela el dwell en curso', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: CURSOR_DWELL_MS - 50, x: 10 + CURSOR_DWELL_CANCEL_PX + 5 }))
  controller.update(s({ t: CURSOR_DWELL_MS + 10, x: 10 + CURSOR_DWELL_CANCEL_PX + 5 }))
  expect(log.click).toEqual([])
})

test('sin objetivo no hay dwell', () => {
  resolveId = null
  controller.update(s({ t: 0 }))
  controller.update(s({ t: CURSOR_DWELL_MS * 2 }))
  expect(log.click).toEqual([])
  expect(log.dwell.every(p => p === 0)).toBe(true)
})

test('mano perdida: leave + exit, y no vuelve a emitirlos', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update({ active: false, x: 0, y: 0, pressed: false, down: false, up: false, t: 50 })
  controller.update({ active: false, x: 0, y: 0, pressed: false, down: false, up: false, t: 100 })
  expect(log.leave).toEqual(['a'])
  expect(log.exits).toBe(1)
})

test('mano perdida con el botón presionado no deja el clic colgado', () => {
  resolveId = 'a'
  controller.update(s({ t: 0 }))
  controller.update(s({ t: 50, pressed: true, down: true }))
  controller.update({ active: false, x: 0, y: 0, pressed: false, down: false, up: false, t: 100 })
  resolveId = 'a'
  controller.update(s({ t: 200, pressed: false, up: true }))
  expect(log.click).toEqual([])
})
