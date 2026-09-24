import type { ReactNode } from 'react'
import { HUE, type Role } from '../lib/theme'

interface Props {
  /** Título de la sección, en mayúsculas por CSS (no lo escribas ya en mayúsculas). */
  title: string
  /** Rol semántico del encabezado. Por defecto `info` — la sección es estructura, no alarma. */
  tone?: Role
  /** Dato corto a la derecha del título: un conteo, un estado, una hora. */
  meta?: ReactNode
  children: ReactNode
}

/**
 * Encabezado de sección con regla cromática.
 *
 * Existe porque este patrón estaba copiado a mano ocho veces dentro de
 * `AwakeApp.tsx`, cada copia con su propio `fontSize` (9 u 10), su propio
 * `letterSpacing` y su propio cyan literal. Un solo componente hace que todas
 * las secciones respiren igual, y que el TONO del encabezado sea el que dice
 * si la sección está sana o pide atención.
 */
export function PanelSection({ title, tone = 'info', meta, children }: Props) {
  return (
    <section className="panel-section" style={{ ['--sec-hue' as string]: HUE[tone] }}>
      <header className="panel-section-head">
        <span className="panel-section-rule" />
        <h3 className="panel-section-title">{title}</h3>
        {meta != null && <span className="panel-section-meta">{meta}</span>}
      </header>
      <div className="panel-section-body">{children}</div>
    </section>
  )
}
