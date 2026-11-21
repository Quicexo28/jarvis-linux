import { useMemo } from 'react'
import { dialSegment } from '../../lib/nucleus'
import { modeMeta } from '../../constants'
import type { Mode } from '../../types'

const R0 = 156
const R1 = 262

interface Props {
  items: Mode[]
  /** Resaltado (ratón, flechas, puño). */
  active: Mode
  visible: boolean
  onPick: (mode: Mode) => void
  onHover: (mode: Mode) => void
}

/**
 * Dial de modos alrededor del orbe. Cada segmento es un `role="button"` propio:
 * el cursor de mano imanta SEGMENTOS, no el SVG entero (un objetivo más grande
 * que el 25 % de la pantalla se descarta). `.gesture-hover` se estila igual que
 * el resalte, porque los eventos sintéticos no activan `:hover` ni `mouseenter`.
 */
export function Dial({ items, active, visible, onPick, onHover }: Props) {
  const segs = useMemo(() => items.map((_, i) => dialSegment(i, items.length, R0, R1)), [items])
  return (
    <svg className={`nx-dial${items.length <= 3 ? ' nx-dial--few' : ''}`} viewBox="-300 -300 600 600" aria-hidden={!visible}>
      <g className="nx-ring nx-ring--c"><circle r="287" /></g>
      <g className="nx-ring nx-ring--a"><circle r="140" /></g>
      <g className="nx-ring nx-ring--b"><circle r="132" /></g>
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
            aria-label={`${label}, tecla ${i + 1}`}
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
