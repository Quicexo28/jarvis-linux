import type { ReactNode } from 'react'
import { HUE, type Role } from '../lib/theme'

interface Props {
  label: ReactNode
  value: ReactNode
  /** Tiñe el valor y enciende el punto indicador. Omitido = sin punto, valor en texto primario. */
  tone?: Role
  /** Unidad o sufijo, en luminancia baja: "Mbps", "%", "min". Separarlo evita que compita con la cifra. */
  unit?: string
  /** Texto largo (rutas, URLs) — permite el corte de línea y reduce el cuerpo. */
  wrap?: boolean
  onClick?: () => void
  title?: string
}

/**
 * Una fila etiqueta → valor.
 *
 * La jerarquía va por LUMINANCIA, no por color: la etiqueta en texto
 * secundario, el valor en primario, la unidad en apagado. Así una columna de
 * diez filas se lee de un barrido vertical y el color queda libre para
 * significar estado en las que de verdad lo tienen.
 */
export function StatRow({ label, value, tone, unit, wrap, onClick, title }: Props) {
  const interactive = typeof onClick === 'function'
  return (
    <div
      className={`stat-row${wrap ? ' stat-row--wrap' : ''}${interactive ? ' stat-row--click' : ''}`}
      onClick={onClick}
      title={title}
      role={interactive ? 'button' : undefined}
    >
      {tone && <span className="stat-dot" style={{ background: HUE[tone] }} />}
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={tone ? { color: HUE[tone] } : undefined}>
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </span>
    </div>
  )
}
