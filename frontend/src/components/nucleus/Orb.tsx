import { useRef, type CSSProperties } from 'react'
import { useVoiceLevel } from '../../hooks/useOrbState'
import type { OrbState } from '../../lib/nucleus'

interface Props {
  state: OrbState
  onClick: () => void
}

const LABEL: Record<OrbState, string> = {
  idle: 'Jarvis en reposo',
  listen: 'Jarvis escucha',
  think: 'Jarvis piensa',
  speak: 'Jarvis habla',
}

/** Seis meridianos cubren la esfera completa (cada círculo ya son dos). */
const MERIDIANS = [0, 1, 2, 3, 4, 5]
/** Paralelos en grados de latitud; `--c` es el radio relativo y `--s` la altura relativa. */
const PARALLELS = [-60, -30, 0, 30, 60].map(deg => ({
  equator: deg === 0,
  vars: { '--c': Math.cos((deg * Math.PI) / 180).toFixed(3), '--s': Math.sin((deg * Math.PI) / 180).toFixed(3) } as CSSProperties,
}))

/**
 * El orbe ES Jarvis. Es un <button> de verdad: Espacio y Enter lo activan solos
 * y el cursor de mano lo imanta.
 *
 * Aspecto de holograma, no de bola sólida: una malla de alambre en 3D real (CSS
 * 3D, la gira el compositor) con un núcleo translúcido, un borde de luz, líneas de
 * escaneo y una banda que la recorre. Cada estado cambia color y movimiento (ver
 * nucleus.css); el nivel de voz entra por la variable `--lv`.
 */
export function Orb({ state, onClick }: Props) {
  const ref = useRef<HTMLButtonElement>(null)
  useVoiceLevel(ref, state === 'speak')
  return (
    <button ref={ref} type="button" className="nx-orb" data-state={state} onClick={onClick}
      aria-label={`${LABEL[state]}. Abre o cierra el menú de modos`}>
      <i className="nx-rp" /><i className="nx-rp" /><i className="nx-tk" /><i className="nx-glow" />
      <span className="nx-globe">
        <i className="nx-core" />
        <span className="nx-spin">
          {MERIDIANS.map(i => <i key={i} className="nx-mer" style={{ '--i': i } as CSSProperties} />)}
          {PARALLELS.map((p, i) => <i key={i} className={`nx-lat${p.equator ? ' nx-lat--eq' : ''}`} style={p.vars} />)}
        </span>
        <span className="nx-clip"><i className="nx-lines" /><i className="nx-scan" /></span>
        <i className="nx-rim" />
      </span>
    </button>
  )
}
