import { useMemo } from 'react'
import { dialSegment } from '../../lib/nucleus'
import { modeMeta } from '../../constants'
import type { Mode } from '../../types'

/** Radios (unidades del viewBox) de cada anillo. El sub-dial ocupa la corona exterior; el principal, ya encogido, queda dentro. */
const RADII = { main: [156, 262], parent: [156, 262], sub: [190, 290] } as const

/** main: dial principal · parent: el principal ya encogido (hay un sub-dial abierto) · sub: el sub-dial de Casa/Útiles. */
export type DialRole = keyof typeof RADII

interface Props {
  items: Mode[]
  /** Resaltado (ratón, flechas, puño). */
  active: Mode
  visible: boolean
  role?: DialRole
  onPick: (mode: Mode) => void
  onHover: (mode: Mode) => void
}

/**
 * Dial de modos alrededor del orbe. Cada segmento es un `role="button"` propio:
 * el cursor de mano imanta SEGMENTOS, no el SVG entero (un objetivo más grande
 * que el 25 % de la pantalla se descarta). `.gesture-hover` se estila igual que
 * el resalte, porque los eventos sintéticos no activan `:hover` ni `mouseenter`.
 */
export function Dial({ items, active, visible, role = 'main', onPick, onHover }: Props) {
  const [r0, r1] = RADII[role]
  const segs = useMemo(() => items.map((_, i) => dialSegment(i, items.length, r0, r1)), [items, r0, r1])
  return (
    <svg className={`nx-dial nx-dial--${role}${items.length <= 3 ? ' nx-dial--few' : ''}`} viewBox="-300 -300 600 600" aria-hidden={!visible}>
      {role === 'sub'
        ? <g className="nx-ring nx-ring--c"><circle r="297" /></g>
        : <>
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
            style={{ transitionDelay: `${i * 40}ms` }}
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
