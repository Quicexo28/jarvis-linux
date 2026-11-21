// Lógica PURA del Núcleo (orbe + dial). Sin React ni DOM: se prueba en Node.
// El store sigue siendo la fuente (`ringLevel`, `activeRingMode`, `zoomedMode`);
// aquí solo se DERIVA lo que se ve y qué hace cada entrada en cada nivel.
import type { Mode } from '../types'
import type { RingLevel } from '../state/jarvisStore'
import { MAIN_RING, SUB_RING, SUB_RING_UTILS } from '../constants'

/** Lo que hay en pantalla: solo el orbe (rest), el dial (menu) o un modo abierto (mode). */
export type NucleusLevel = 'rest' | 'menu' | 'mode'

/** Un sub-anillo (casa, útiles) siempre muestra su dial, aunque el menú no se haya abierto a mano (p. ej. por voz). */
export function nucleusLevel(zoomedMode: Mode | null, menuOpen: boolean, ringLevel: RingLevel): NucleusLevel {
  if (zoomedMode) return 'mode'
  return menuOpen || ringLevel !== 'main' ? 'menu' : 'rest'
}

/** Entradas del dial según el nivel del anillo. */
export function dialItems(ringLevel: RingLevel): Mode[] {
  return ringLevel === 'house-sub' ? SUB_RING : ringLevel === 'utils-sub' ? SUB_RING_UTILS : MAIN_RING
}

// --- Activar (clic, V suelta, pinch completo, Enter) -------------------------

export type Activation = { type: 'openMenu' } | { type: 'enter'; mode: Mode } | null

/** En reposo abre el menú; en el menú entra al modo resaltado; dentro de un modo no hace nada. */
export function activation(level: NucleusLevel, highlighted: Mode): Activation {
  if (level === 'rest') return { type: 'openMenu' }
  if (level === 'menu') return { type: 'enter', mode: highlighted }
  return null
}

// --- Atrás -------------------------------------------------------------------

export type BackStep = 'selector' | 'mode' | 'sublevel' | 'menu' | 'none'

/** Cada llamada sube UN nivel: selector de plano → modo → sub-anillo → menú → reposo. */
export function backStep(s: { selector: boolean; zoomedMode: Mode | null; ringLevel: RingLevel; menuOpen: boolean }): BackStep {
  if (s.selector) return 'selector'
  if (s.zoomedMode != null) return 'mode'
  if (s.ringLevel !== 'main') return 'sublevel'
  return s.menuOpen ? 'menu' : 'none'
}

// --- Teclado -----------------------------------------------------------------

export type NavKey =
  | { type: 'activate' }
  | { type: 'back' }
  | { type: 'move'; dir: 1 | -1 }
  | { type: 'pick'; index: number }

/**
 * Tecla → acción. Escape siempre sube un nivel. Con un modo de canvas abierto
 * (planos, grafo) el resto de teclas son del propio modo y aquí no se tocan.
 * Espacio/Enter dentro de un modo vuelven al menú.
 */
export function keyAction(key: string, level: NucleusLevel, itemCount: number, canvasZoom: boolean): NavKey | null {
  if (key === 'Escape') return { type: 'back' }
  if (canvasZoom) return null
  if (key === ' ' || key === 'Enter') return level === 'mode' ? { type: 'back' } : { type: 'activate' }
  if (key === 'ArrowRight' || key === 'ArrowDown') return { type: 'move', dir: 1 }
  if (key === 'ArrowLeft' || key === 'ArrowUp') return { type: 'move', dir: -1 }
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1
    return index < itemCount ? { type: 'pick', index } : null
  }
  return null
}

/** El foco está donde se escribe: ninguna tecla de navegación debe robarlo. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
}

/** El foco está en algo que ya reacciona a Espacio/Enter por sí mismo: evita activar dos veces. */
export function isActivatable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.closest('button, [role="button"], a[href], summary') !== null
}

// --- Orbe --------------------------------------------------------------------

export type OrbState = 'idle' | 'listen' | 'think' | 'speak'

/** Hablar manda sobre pensar, y pensar sobre escuchar. */
export function orbStateOf(listening: boolean, thinking: boolean, speaking: boolean): OrbState {
  if (speaking) return 'speak'
  if (thinking) return 'think'
  return listening ? 'listen' : 'idle'
}

// --- Geometría del dial ------------------------------------------------------

export interface DialSegment {
  /** Trazo SVG del anillo parcial. */
  d: string
  /** Centro del segmento (para las etiquetas). */
  cx: number
  cy: number
}

const f = (n: number) => n.toFixed(2)

/** Segmento `i` de `n` entre los radios `r0` y `r1`. El primero arranca arriba y se reparte en sentido horario. */
export function dialSegment(i: number, n: number, r0: number, r1: number, gap = 0.03): DialSegment {
  const step = (2 * Math.PI) / n
  const a0 = -Math.PI / 2 + i * step + gap
  const a1 = -Math.PI / 2 + (i + 1) * step - gap
  const am = (a0 + a1) / 2
  const large = a1 - a0 > Math.PI ? 1 : 0
  const at = (r: number, a: number) => `${f(r * Math.cos(a))},${f(r * Math.sin(a))}`
  const rm = (r0 + r1) / 2
  return {
    d: `M${at(r1, a0)} A${r1},${r1} 0 ${large} 1 ${at(r1, a1)} L${at(r0, a1)} A${r0},${r0} 0 ${large} 0 ${at(r0, a0)} Z`,
    cx: Number(f(rm * Math.cos(am))),
    cy: Number(f(rm * Math.sin(am))),
  }
}
