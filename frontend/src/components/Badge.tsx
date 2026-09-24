import type { ReactNode } from 'react'
import { HUE, withAlpha, type Role } from '../lib/theme'

interface Props {
  tone?: Role
  /** Punto pulsante a la izquierda — para estados VIVOS (escuchando, conectado, grabando). */
  live?: boolean
  children: ReactNode
  title?: string
}

/**
 * Píldora de estado. Sustituye los `<div>` con borde y color literal que había
 * repartidos por los paneles (`border: '1px solid #64ffda44'` y compañía).
 *
 * El punto `live` es lo único animado: un estado que parpadea cuando NO está
 * cambiando entrena al ojo a ignorarlo.
 */
export function Badge({ tone = 'info', live, children, title }: Props) {
  const hue = HUE[tone]
  return (
    <span
      className={`badge${live ? ' badge--live' : ''}`}
      title={title}
      style={{ color: hue, borderColor: withAlpha(hue, 0.35), background: withAlpha(hue, 0.08) }}
    >
      {live && <i className="badge-dot" style={{ background: hue }} />}
      {children}
    </span>
  )
}
