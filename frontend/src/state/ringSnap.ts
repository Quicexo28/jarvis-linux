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
