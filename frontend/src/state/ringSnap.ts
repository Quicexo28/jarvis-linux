/**
 * Geometría del arrastre del carrusel. `ringAngle` se mide en UNIDADES DE SLOT
 * (0 = primer slot, 1 = el siguiente…), no en radianes: es lo que espera
 * `snapToNearestSlot` y lo que escribe `rotateRing`. La conversión a radianes
 * la hace el renderer (`ringAngle · 2π/nSlots`), que es el único que necesita
 * ángulos. Mezclar las dos unidades fue un bug real: el arrastre sumaba
 * "radianes" a un valor en slots.
 */

/** Snap a continuous ring angle (in slot units) to the nearest integer slot,
 *  wrapping modulo numSlots. */
export function snapToNearestSlot(ringAngle: number, numSlots: number): number {
  const rounded = Math.round(ringAngle)
  return ((rounded % numSlots) + numSlots) % numSlots
}

/**
 * Ángulo del anillo mientras se arrastra con el puño. ABSOLUTO contra el
 * enganche: `deltaX` ya viene anclado al punto donde se cerró el puño
 * (GrabTracker) y filtrado con One-Euro, así que el anillo es una FUNCIÓN
 * DIRECTA de dónde está la mano — la misma posición de mano da siempre el mismo
 * ángulo. La versión anterior integraba incrementos por frame, y encima les
 * aplicaba zona muerta y un exponente: los movimientos lentos se anulaban
 * enteros y la correspondencia mano↔anillo se perdía al primer gesto.
 *
 * SIGNO: `deltaX > 0` = mano a la DERECHA. El carrusel se manipula como un
 * objeto real — empujar la mano a la derecha arrastra los hologramas a la
 * derecha, lo que trae al frente el que estaba a la IZQUIERDA. Con la rotación
 * del contenedor eso es ángulo DECRECIENTE, de ahí el menos.
 */
export function dragToRingAngle(
  baseAngle: number, deltaX: number, slotsPerUnit: number,
): number {
  return baseAngle - deltaX * slotsPerUnit
}

/**
 * Slot resaltado durante el arrastre, con HISTÉRESIS. `snapToNearestSlot` a
 * secas cambia de slot justo en x.5: con la mano quieta cerca de la frontera el
 * temblor de landmarks lo hacía alternar entre dos modos, y cada cambio
 * re-renderiza el anillo entero (geometría `active`, halo, etiqueta) — parpadeo
 * visible y frames largos. El slot anterior se conserva hasta que el ángulo se
 * aleja `margin` slots MÁS ALLÁ de la frontera. `prevSlot < 0` = sin slot previo.
 */
export function slotWithHysteresis(
  angle: number, prevSlot: number, numSlots: number, margin: number,
): number {
  const nearest = snapToNearestSlot(angle, numSlots)
  if (prevSlot < 0 || nearest === prevSlot) return nearest
  // Distancia con vuelta (en slots) del ángulo al slot que ya estaba resaltado.
  let d = (((angle - prevSlot) % numSlots) + numSlots) % numSlots
  if (d > numSlots / 2) d -= numSlots
  return Math.abs(d) <= 0.5 + margin ? prevSlot : nearest
}

/** Estado de un seguidor de muelle. Se muta EN SITIO: cero asignaciones por frame. */
export interface SpringState { x: number; v: number }

/**
 * Avanza `s` hacia `target` con un muelle CRÍTICAMENTE amortiguado
 * (ë = −2ω·ė − ω²·e), integrado de forma EXACTA para el paso `dt` (segundos).
 *
 * Por qué así y no un lerp por frame:
 *  - El lerp anterior (`k·6` con `k = 1 − 0.005^dt`) multiplicaba FUERA del
 *    exponente: el factor pasa de 1 con frames de más de 34 ms y de 2 con más de
 *    76 ms. En este WebKitGTK, con la inferencia de MediaPipe en el main thread,
 *    esos frames son normales → el anillo se pasaba del objetivo y oscilaba:
 *    el temblor del arrastre con el puño. La solución exacta es estable con
 *    cualquier `dt` y NO sobrepasa un objetivo quieto.
 *  - El objetivo llega a escalones (~25 Hz, una muestra del pipeline). Un
 *    seguidor de primer orden copia cada escalón con un salto de velocidad
 *    (tirones a 25 Hz); el de segundo orden da velocidad continua.
 * Retardo sobre un movimiento a velocidad constante: 2/ω segundos.
 */
export function springFollow(s: SpringState, target: number, omega: number, dt: number): void {
  const e0 = s.x - target
  const c = s.v + omega * e0
  const decay = Math.exp(-omega * dt)
  s.x = target + (e0 + c * dt) * decay
  s.v = (s.v - omega * c * dt) * decay
}

/**
 * Fracción de un lerp por frame INDEPENDIENTE del frame rate: con `rate` en 1/s,
 * dos frames de 16 ms avanzan exactamente lo mismo que uno de 32 ms, y el
 * resultado nunca pasa de 1 (no hay sobreimpulso por un frame largo).
 */
export function dampFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt)
}
