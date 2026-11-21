// Prueba de humo del Núcleo contra el store REAL: teclado, ratón, atrás por niveles
// y el contrato con el backend (`ring_rotate` deja el dial a la vista, `view_close` cierra el menú y lo dice).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Nucleus } from './Nucleus'
import { StatusBar } from '../StatusBar'
import { useNavigation } from '../../hooks/useNavigation'
import { useJarvisStore } from '../../state/jarvisStore'
import { runPrimitive } from '../../skills/primitives'

function Harness() {
  const nav = useNavigation()
  return (
    <>
      <Nucleus listening={false} onOrb={nav.toggleMenu} onEnter={nav.enterMode} onBack={nav.handleBack} />
      <StatusBar voiceActive={false} voiceHeard={false} onEnter={nav.enterMode} />
    </>
  )
}

let host: HTMLDivElement
let root: Root
const run = async (verb: string, payload: unknown) => {
  let r: unknown
  await act(async () => { r = await runPrimitive(verb, payload) })
  return r
}
const set = (patch: Partial<ReturnType<typeof useJarvisStore.getState>>) => act(() => { useJarvisStore.setState(patch) })
const root$ = () => host.querySelector('.nx') as HTMLElement
const st = () => useJarvisStore.getState()
const press = (key: string, target: EventTarget = document.body) =>
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })

beforeEach(() => {
  useJarvisStore.setState({ zoomedMode: null, ringLevel: 'main', activeRingMode: 'home', menuOpen: false, ringAngle: 0, pinchZoomProgress: 0 })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(<Harness />) })
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Núcleo · teclado', () => {
  it('arranca en reposo y Espacio abre el menú con seis segmentos', () => {
    expect(root$().classList.contains('nx--rest')).toBe(true)
    press(' ')
    expect(st().menuOpen).toBe(true)
    expect(root$().classList.contains('nx--menu')).toBe(true)
    expect(host.querySelectorAll('.nx-seg[role="button"]')).toHaveLength(6)
  })

  it('las flechas mueven el resalte y 4 entra a Sistema', () => {
    press(' ')
    press('ArrowRight')
    expect(st().activeRingMode).toBe('house')
    expect(host.querySelector('.nx-seg.is-on')?.getAttribute('aria-label')).toContain('Casa')
    press('4')
    expect(st().zoomedMode).toBe('system')
    expect(root$().classList.contains('nx--mode')).toBe(true)
    expect(host.querySelector('.nx-title h1')?.textContent).toBe('Sistema')
  })

  it('Escape sube un nivel por pulsación: modo → menú → reposo', () => {
    press('4')
    press('Escape')
    expect(st().zoomedMode).toBeNull()
    expect(root$().classList.contains('nx--menu')).toBe(false) // se abrió por tecla directa: no había menú
    press(' ')
    press('4')
    press('Escape')
    expect(root$().classList.contains('nx--menu')).toBe(true)
    press('Escape')
    expect(root$().classList.contains('nx--rest')).toBe(true)
  })

  it('Casa abre un sub-dial de tres, y Escape vuelve al dial principal', () => {
    press(' ')
    press('2')
    expect(st().ringLevel).toBe('house-sub')
    expect(host.querySelectorAll('.nx-dial--sub .nx-seg')).toHaveLength(3)
    expect(host.querySelectorAll('.nx-dial--parent .nx-seg')).toHaveLength(6) // el principal sigue, encogido
    press('Escape')
    expect(st().ringLevel).toBe('main')
    expect(host.querySelectorAll('.nx-dial--main .nx-seg')).toHaveLength(6)
    expect(host.querySelector('.nx-dial--sub:not(.nx-dial--out)')).toBeNull() // el sub-dial solo queda como copia que se pliega
  })

  it('Útiles abre un sub-dial de dos', () => {
    press(' ')
    press('6')
    expect(st().ringLevel).toBe('utils-sub')
    expect(host.querySelectorAll('.nx-dial--sub .nx-seg')).toHaveLength(2)
  })

  it('desde dentro de un modo, las flechas cambian de modo', () => {
    press('4')
    expect(st().zoomedMode).toBe('system')
    press('ArrowRight')
    expect(st().zoomedMode).toBe('cloud')
  })

  it('escribiendo en un campo, las teclas no navegan (salvo Escape)', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    press(' ', input)
    press('4', input)
    expect(st().menuOpen).toBe(false)
    expect(st().zoomedMode).toBeNull()
    input.remove()
  })

  it('un botón enfocado activa con Espacio por sí mismo: no se activa dos veces', () => {
    const orb = host.querySelector('.nx-orb') as HTMLElement
    press(' ', orb)
    expect(st().menuOpen).toBe(false) // el handler global lo ignora; el <button> real lo activaría con su click
  })
})

describe('Núcleo · ratón', () => {
  it('clic en el orbe abre y cierra el menú', () => {
    const orb = host.querySelector('.nx-orb') as HTMLElement
    act(() => { orb.click() })
    expect(st().menuOpen).toBe(true)
    act(() => { orb.click() })
    expect(st().menuOpen).toBe(false)
  })

  it('clic en un segmento entra al modo', () => {
    press(' ')
    const seg = [...host.querySelectorAll('.nx-seg')].find(g => g.getAttribute('aria-label')?.startsWith('Memoria'))!
    act(() => { (seg as unknown as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(st().zoomedMode).toBe('vault')
  })

  it('la tira de la cabecera aparece fuera del reposo y entra al modo', () => {
    expect(host.querySelector('.nx-strip')).toBeNull()
    press(' ')
    const btn = [...host.querySelectorAll('.nx-strip button')].find(b => b.textContent?.includes('SISTEMA')) as HTMLElement
    act(() => { btn.click() })
    expect(st().zoomedMode).toBe('system')
  })

  it('pasar el ratón por un segmento lo resalta', () => {
    press(' ')
    const seg = host.querySelectorAll('.nx-seg')[3] as unknown as HTMLElement
    act(() => { seg.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(st().activeRingMode).toBe('system')
  })
})

describe('Contrato con el backend (primitivas de voz)', () => {
  it('ring_rotate deja el dial a la vista', async () => {
    expect(st().menuOpen).toBe(false)
    await run('ring_rotate', { direction: 'right' })
    expect(st().menuOpen).toBe(true)
    expect(st().activeRingMode).toBe('house')
  })

  it('view_close con solo el menú abierto lo cierra y dice qué cerró', async () => {
    set({ menuOpen: true })
    expect(await run('view_close', {})).toEqual({ closed: 'menu' })
    expect(st().menuOpen).toBe(false)
    expect(await run('view_close', {})).toEqual({ closed: 'noop' })
  })

  it('view_close sigue cerrando primero el modo y luego el sub-anillo', async () => {
    set({ zoomedMode: 'system', menuOpen: true })
    expect(await run('view_close', {})).toEqual({ closed: 'zoom' })
    set({ ringLevel: 'house-sub' })
    expect(await run('view_close', {})).toEqual({ closed: 'sub_ring' })
  })

  it('view_open de un modo lo muestra', async () => {
    await run('view_open', { view: 'system' })
    expect(st().zoomedMode).toBe('system')
    expect(root$().classList.contains('nx--mode')).toBe(true)
  })
})
