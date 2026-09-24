import { HUE, severityHue, withAlpha, type Role } from '../lib/theme'

interface Props {
  label: string
  /** Valor medido. `null`/`NaN` = sin dato, y el medidor lo dice en vez de dibujar un cero. */
  value: number | null | undefined
  /** Fondo de escala. Por defecto 100 (porcentaje). */
  max?: number
  unit?: string
  /** Umbral de atención. Con `warn`+`crit` el hue lo DERIVA el dato y `tone` se ignora. */
  warn?: number
  /** Umbral crítico. */
  crit?: number
  /** true cuando lo bajo es lo malo (batería, espacio libre). */
  invert?: boolean
  /** Rol fijo, para métricas sin umbral (caudal de red, por ejemplo). */
  tone?: Role
  /** Decimales de la cifra. */
  decimals?: number
  /** Número de segmentos de la barra. 12 por defecto: bastantes para leer la proporción, pocos para que cada uno se vea. */
  segments?: number
}

/**
 * Medidor segmentado.
 *
 * Segmentos discretos y no una barra continua por dos razones: leer "nueve de
 * doce" de un vistazo es más rápido que estimar un porcentaje de longitud, y
 * doce divs con opacidad fija cuestan cero por frame — importante en este
 * WebKitGTK, donde cualquier animación de gradiente se nota.
 *
 * El color NO es un parámetro estético: con `warn`/`crit` sale de
 * `severityHue`, así que un valor alto se pone ámbar y uno crítico rojo sin que
 * el sitio de la llamada tenga que acordarse de hacerlo.
 */
export function HoloMeter({
  label, value, max = 100, unit = '%', warn, crit, invert,
  tone = 'info', decimals = 0, segments = 12,
}: Props) {
  const known = typeof value === 'number' && Number.isFinite(value)
  const hue = !known
    ? HUE.idle
    : warn != null && crit != null
      ? severityHue(value, { warn, crit, invert })
      : HUE[tone]

  const ratio = known ? Math.max(0, Math.min(1, value / max)) : 0
  // `round` y no `floor`: con floor, un 99% mostraba once segmentos de doce y
  // parecía que faltaba mucho más de lo que faltaba.
  const filled = Math.round(ratio * segments)

  return (
    <div className="holo-meter" style={{ ['--m-hue' as string]: hue }}>
      <span className="holo-meter-label">{label}</span>
      <span className="holo-meter-bar" aria-hidden>
        {Array.from({ length: segments }, (_, i) => (
          <i
            key={i}
            className="holo-meter-seg"
            style={i < filled
              ? { background: hue, boxShadow: `0 0 6px ${withAlpha(hue, 0.55)}` }
              : undefined}
          />
        ))}
      </span>
      <span className="holo-meter-value" style={{ color: hue }}>
        {known ? value.toFixed(decimals) : '—'}
        {known && unit && <span className="holo-meter-unit">{unit}</span>}
      </span>
    </div>
  )
}
