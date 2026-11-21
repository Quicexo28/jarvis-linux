import { describe, it, expect } from 'vitest'
import {
  nucleusLevel, dialItems, activation, backStep, keyAction, isTypingTarget, isActivatable, orbStateOf, dialSegment, parentArcs, subArcs, uniformArcs, SUB_STEP,
} from './nucleus'

describe('nucleusLevel', () => {
  it('con un modo abierto manda el modo', () => {
    expect(nucleusLevel('system', true, 'main')).toBe('mode')
  })
  it('sin modo: reposo o menú según la bandera', () => {
    expect(nucleusLevel(null, false, 'main')).toBe('rest')
    expect(nucleusLevel(null, true, 'main')).toBe('menu')
  })
  it('un sub-anillo muestra el dial aunque el menú no se abriera a mano (voz)', () => {
    expect(nucleusLevel(null, false, 'house-sub')).toBe('menu')
    expect(nucleusLevel(null, false, 'utils-sub')).toBe('menu')
  })
})

describe('dialItems', () => {
  it('seis modos en el principal, tres en casa, dos en útiles', () => {
    expect(dialItems('main')).toHaveLength(6)
    expect(dialItems('house-sub')).toEqual(['plan3d', 'space', 'plan2d'])
    expect(dialItems('utils-sub')).toEqual(['timer', 'chrono'])
  })
})

describe('activation', () => {
  it('reposo abre el menú, menú entra al resaltado, modo no hace nada', () => {
    expect(activation('rest', 'home')).toEqual({ type: 'openMenu' })
    expect(activation('menu', 'system')).toEqual({ type: 'enter', mode: 'system' })
    expect(activation('mode', 'system')).toBeNull()
  })
})

describe('backStep: un nivel por llamada', () => {
  const base = { selector: false, zoomedMode: null, ringLevel: 'main' as const, menuOpen: false }
  it('orden: selector, modo, sub-anillo, menú, nada', () => {
    expect(backStep({ ...base, selector: true, zoomedMode: 'plan3d', ringLevel: 'house-sub', menuOpen: true })).toBe('selector')
    expect(backStep({ ...base, zoomedMode: 'plan3d', ringLevel: 'house-sub', menuOpen: true })).toBe('mode')
    expect(backStep({ ...base, ringLevel: 'house-sub', menuOpen: true })).toBe('sublevel')
    expect(backStep({ ...base, menuOpen: true })).toBe('menu')
    expect(backStep(base)).toBe('none')
  })
})

describe('keyAction', () => {
  it('Escape siempre sube un nivel, incluso con un canvas abierto', () => {
    expect(keyAction('Escape', 'mode', 6, true)).toEqual({ type: 'back' })
  })
  it('con un canvas abierto el resto de teclas son del modo', () => {
    for (const k of [' ', 'Enter', 'ArrowLeft', '3']) expect(keyAction(k, 'mode', 6, true)).toBeNull()
  })
  it('Espacio/Enter: activa en reposo y menú, vuelve desde un modo', () => {
    expect(keyAction(' ', 'rest', 6, false)).toEqual({ type: 'activate' })
    expect(keyAction('Enter', 'menu', 6, false)).toEqual({ type: 'activate' })
    expect(keyAction(' ', 'mode', 6, false)).toEqual({ type: 'back' })
  })
  it('flechas mueven en ambos sentidos', () => {
    expect(keyAction('ArrowRight', 'menu', 6, false)).toEqual({ type: 'move', dir: 1 })
    expect(keyAction('ArrowLeft', 'menu', 6, false)).toEqual({ type: 'move', dir: -1 })
  })
  it('un dígito elige solo si existe esa entrada', () => {
    expect(keyAction('4', 'menu', 6, false)).toEqual({ type: 'pick', index: 3 })
    expect(keyAction('4', 'menu', 3, false)).toBeNull()
    expect(keyAction('0', 'menu', 6, false)).toBeNull()
  })
  it('otras teclas no hacen nada', () => {
    expect(keyAction('v', 'rest', 6, false)).toBeNull()
  })
})

describe('foco', () => {
  it('detecta dónde se escribe y qué ya reacciona a Espacio/Enter', () => {
    const input = document.createElement('input')
    const btn = document.createElement('button')
    const seg = document.createElement('div'); seg.setAttribute('role', 'button')
    const plain = document.createElement('div')
    expect(isTypingTarget(input)).toBe(true)
    expect(isTypingTarget(btn)).toBe(false)
    expect(isActivatable(btn)).toBe(true)
    expect(isActivatable(seg)).toBe(true)
    expect(isActivatable(plain)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('orbStateOf', () => {
  it('hablar > pensar > escuchar > reposo', () => {
    expect(orbStateOf(true, true, true)).toBe('speak')
    expect(orbStateOf(true, true, false)).toBe('think')
    expect(orbStateOf(true, false, false)).toBe('listen')
    expect(orbStateOf(false, false, false)).toBe('idle')
  })
})

describe('dialSegment', () => {
  it('el primer segmento de seis arranca arriba y su centro queda en el cuadrante superior derecho', () => {
    const s = dialSegment(0, 6, 150, 260)
    expect(s.cx).toBeGreaterThan(0)
    expect(s.cy).toBeLessThan(0)
    expect(s.d.startsWith('M')).toBe(true)
  })
  it('los seis centros están a la misma distancia del origen', () => {
    const r = Array.from({ length: 6 }, (_, i) => dialSegment(i, 6, 150, 260)).map(s => Math.hypot(s.cx, s.cy))
    for (const x of r) expect(Math.abs(x - r[0])).toBeLessThan(0.05)
  })
  it('con dos entradas el arco es casi media vuelta y no activa el arco grande', () => {
    expect(dialSegment(0, 2, 150, 260).d).toContain(' 0 0 1 ')
  })
  it('con una sola entrada el arco es mayor de media vuelta', () => {
    expect(dialSegment(0, 1, 150, 260).d).toContain(' 0 1 1 ')
  })
})

describe('sub-dial como arco', () => {
  it('el principal amplía la entrada elegida y sigue sumando una vuelta', () => {
    const { arcs, span } = parentArcs(6, 1, 3)
    expect(span).toBeCloseTo(3 * SUB_STEP)
    expect(arcs[1][1] - arcs[1][0]).toBeCloseTo(span)
    expect(arcs[0][1] - arcs[0][0]).toBeLessThan(2 * Math.PI / 6) // las demás se encogen
    expect(arcs[5][1] - arcs[0][0]).toBeCloseTo(2 * Math.PI)
  })
  it('el sub-dial queda centrado sobre la entrada ampliada y no ocupa la vuelta entera', () => {
    const { arcs, mid } = parentArcs(6, 1, 3)
    const sub = subArcs(3, mid)
    expect((sub[0][0] + sub[2][1]) / 2).toBeCloseTo(mid)
    expect(sub[2][1] - sub[0][0]).toBeLessThan(Math.PI * 1.2)
    expect(uniformArcs(6)).toHaveLength(6)
    expect(arcs[1][0] + (arcs[1][1] - arcs[1][0]) / 2).toBeCloseTo(mid)
  })
})
