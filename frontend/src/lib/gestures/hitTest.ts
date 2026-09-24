// frontend/src/lib/gestures/hitTest.ts
// Imantado del cursor de mano a los objetivos de la interfaz. Puro y sin DOM
// (el hook le pasa los rects ya leídos) — testeable en Node.
//
// Por qué existe: apuntar con el dedo tiene un error de varios píxeles sobre la
// pantalla (temblor + error del modelo + 20 Hz de muestreo), y los botones del
// HUD miden ~30 px de alto. Sin imán, la ley de Fitts hace el menú inusable con
// la mano aunque el cursor sea perfectamente estable. Con imán, el objetivo
// EFECTIVO pasa a medir rect + radio.
import { CURSOR_MAGNET_RADIUS, CURSOR_MAGNET_STICKY } from '../../gestures/config'

export interface TargetRect {
  id: string
  left: number
  top: number
  width: number
  height: number
}

export interface MagnetResult {
  /** Objetivo enganchado, o null si no hay ninguno en el radio. */
  id: string | null
  /** Punto imantado: SIEMPRE dentro del rect del objetivo enganchado. */
  x: number
  y: number
  /** true si el cursor ya estaba dentro del rect (no hubo tirón). */
  inside: boolean
}

export interface MagnetOptions {
  radius?: number
  stickyRadius?: number
  /** Cuánto se mete el punto imantado dentro del borde (px). */
  inset?: number
}

function area(r: TargetRect): number {
  return Math.max(0, r.width) * Math.max(0, r.height)
}

function contains(r: TargetRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height
}

/** Punto del rect más cercano a (x,y), metido `inset` px hacia dentro. */
export function closestPointInRect(
  r: TargetRect, x: number, y: number, inset = 0,
): { x: number; y: number } {
  const ix = Math.min(inset, r.width / 2)
  const iy = Math.min(inset, r.height / 2)
  return {
    x: Math.min(Math.max(x, r.left + ix), r.left + r.width - ix),
    y: Math.min(Math.max(y, r.top + iy), r.top + r.height - iy),
  }
}

/** Distancia euclídea al rect (0 si el punto está dentro). */
export function distanceToRect(r: TargetRect, x: number, y: number): number {
  const dx = Math.max(r.left - x, 0, x - (r.left + r.width))
  const dy = Math.max(r.top - y, 0, y - (r.top + r.height))
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Engancha (x,y) al objetivo más cercano.
 *
 * Reglas, en orden:
 *  1. Si el cursor está DENTRO de algún rect gana ese — y si hay varios, el de
 *     menor área (el más específico: un botón dentro de un panel, no el panel).
 *     El punto no se mueve: dentro del objetivo el cursor debe ser honesto.
 *  2. Si no, el objetivo PEGAJOSO (el ya enganchado) conserva la plaza mientras
 *     siga dentro de `stickyRadius`. Sin esta histéresis el cursor entre dos
 *     botones contiguos parpadea entre ambos a la tasa del pipeline, y cada
 *     parpadeo reinicia el dwell y dispara enter/leave en el DOM.
 *  3. Si no, el más cercano dentro de `radius`.
 *
 * El punto devuelto para los casos 2 y 3 es el más cercano DENTRO del rect: los
 * eventos que emite el hook tienen que caer sobre el elemento, no a su lado.
 */
export function magnetize(
  x: number,
  y: number,
  targets: readonly TargetRect[],
  stickyId: string | null = null,
  opts: MagnetOptions = {},
): MagnetResult {
  const radius = opts.radius ?? CURSOR_MAGNET_RADIUS
  const stickyRadius = opts.stickyRadius ?? CURSOR_MAGNET_STICKY
  const inset = opts.inset ?? 4

  let innermost: TargetRect | null = null
  for (const t of targets) {
    if (!contains(t, x, y)) continue
    if (innermost === null || area(t) < area(innermost)) innermost = t
  }
  if (innermost) return { id: innermost.id, x, y, inside: true }

  if (stickyId !== null) {
    const sticky = targets.find(t => t.id === stickyId)
    if (sticky && distanceToRect(sticky, x, y) <= stickyRadius) {
      const p = closestPointInRect(sticky, x, y, inset)
      return { id: sticky.id, x: p.x, y: p.y, inside: false }
    }
  }

  let best: TargetRect | null = null
  let bestD = Infinity
  for (const t of targets) {
    const d = distanceToRect(t, x, y)
    if (d < bestD) { bestD = d; best = t }
  }
  if (best && bestD <= radius) {
    const p = closestPointInRect(best, x, y, inset)
    return { id: best.id, x: p.x, y: p.y, inside: false }
  }

  return { id: null, x, y, inside: false }
}
