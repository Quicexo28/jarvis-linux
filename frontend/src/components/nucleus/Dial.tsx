import { useLayoutEffect, useMemo, useRef } from 'react'
import { arcSegment, type Arc } from '../../lib/nucleus'
import { modeMeta } from '../../constants'
import type { Mode } from '../../types'

/** Radios (unidades del viewBox) de cada anillo. El sub-dial ocupa la corona exterior; el principal, ya encogido, queda dentro. */
const RADII = { main: [156, 262], parent: [156, 262], sub: [170, 270] } as const

/** Duración de la expansión; igual que la de `nx-parent-in` en nucleus.css. */
const EXPAND_MS = 450

/** main: dial principal · parent: el principal ya encogido (hay un sub-dial abierto) · sub: el sub-dial de Casa/Útiles. */
export type DialRole = keyof typeof RADII

interface Props {
  items: Mode[]
  /** Resaltado (ratón, flechas, puño). */
  active: Mode
  visible: boolean
  /** Ángulos de cada entrada. */
  arcs: readonly Arc[]
  role?: DialRole
  /** Punto (unidades del viewBox) desde donde el dial se materializa: el borde de la entrada del principal que lo abre. */
  origin?: { x: number; y: number }
  /** Si se da, los segmentos se estiran desde estos ángulos hasta `arcs` (expansión del dial). */
  fromArcs?: readonly Arc[]
  /** back: el principal vuelve de un sub-dial (crece desde su tamaño encogido) · out: el sub-dial que se despide. */
  enter?: 'back' | 'out'
  onPick: (mode: Mode) => void
  onHover: (mode: Mode) => void
}

/**
 * Dial de modos alrededor del orbe. Cada segmento es un `role="button"` propio:
 * el cursor de mano imanta SEGMENTOS, no el SVG entero (un objetivo más grande
 * que el 25 % de la pantalla se descarta). `.gesture-hover` se estila igual que
 * el resalte, porque los eventos sintéticos no activan `:hover` ni `mouseenter`.
 */
export function Dial({ items, arcs, active, visible, role = 'main', enter, fromArcs, origin, onPick, onHover }: Props) {
  const [r0, r1] = RADII[role]
  const segs = useMemo(() => arcs.map(([a, b]) => arcSegment(a, b, r0, r1)), [arcs, r0, r1])
  const svg = useRef<SVGSVGElement>(null)

  // Expansión: tween corto de los ángulos escribiendo directo en el DOM (sin pasar por React).
  // Va en layout effect para que el primer cuadro ya salga desde los ángulos de origen.
  useLayoutEffect(() => {
    const el = svg.current
    if (!el || !fromArcs || fromArcs.length !== arcs.length) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const segEls = Array.from(el.querySelectorAll<SVGGElement>('.nx-seg'))
    const paint = (k: number) => segEls.forEach((g, i) => {
      const s = arcSegment(fromArcs[i][0] + (arcs[i][0] - fromArcs[i][0]) * k, fromArcs[i][1] + (arcs[i][1] - fromArcs[i][1]) * k, r0, r1)
      g.querySelector('path')?.setAttribute('d', s.d)
      const [n, t] = Array.from(g.querySelectorAll('text'))
      n?.setAttribute('x', String(s.cx)); n?.setAttribute('y', String(s.cy - 7))
      t?.setAttribute('x', String(s.cx)); t?.setAttribute('y', String(s.cy + 14))
    })
    paint(0)
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / EXPAND_MS)
      paint(1 - Math.pow(1 - p, 3))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [arcs, fromArcs, r0, r1])

  return (
    <svg ref={svg} className={`nx-dial nx-dial--${role}${enter ? ` nx-dial--${enter}` : ''}${items.length <= 3 ? ' nx-dial--few' : ''}`} viewBox="-300 -300 600 600" aria-hidden={!visible}
      style={origin ? { transformOrigin: `${50 + origin.x / 6}% ${50 + origin.y / 6}%` } : undefined}>
      {role !== 'sub' && <>
            <g className="nx-ring nx-ring--c"><circle r="287" /></g>
            <g className="nx-ring nx-ring--a"><circle r="140" /></g>
            <g className="nx-ring nx-ring--b"><circle r="132" /></g>
          </>}
      {items.map((mode, i) => {
        const s = segs[i]
        const label = modeMeta[mode].label
        const pick = () => onPick(mode)
        return (
          <g
            key={mode}
            className={`nx-seg${mode === active ? ' is-on' : ''}`}
            role="button"
            tabIndex={visible ? 0 : -1}
            aria-label={role === 'parent' ? `${label}, volver al dial principal` : `${label}, tecla ${i + 1}`}
            style={{ transitionDelay: `${i * 40}ms`, ['--i' as string]: i }}
            onMouseEnter={() => onHover(mode)}
            onFocus={() => onHover(mode)}
            onClick={pick}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick() } }}
          >
            <path d={s.d} />
            <text className="nx-seg-n" x={s.cx} y={s.cy - 7}>{String(i + 1).padStart(2, '0')}</text>
            <text className="nx-seg-t" x={s.cx} y={s.cy + 14}>{label.toUpperCase()}</text>
          </g>
        )
      })}
    </svg>
  )
}
