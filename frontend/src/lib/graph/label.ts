/** Tope de caracteres por etiqueta de nodo. Un fact trae ~60 y tapa media pantalla. */
export const MAX_LABEL_CHARS = 26

/**
 * Recorta una etiqueta por el MEDIO, no por la derecha.
 *
 * Caso real del vault, visto en pantalla: cuatro notas de experimentos
 * llamadas `datos-tiempo-vuelo-masa1-oasis`, `…masa2-oasis`, `…masa3-harina` y
 * `…masa3-oasis`. Cortando por la derecha las cuatro salían como
 * "datos-tiempo-vuelo-mas…" — cuatro etiquetas IDÉNTICAS para cuatro cosas
 * distintas, que es peor que no etiquetar nada. Lo que las distingue está al
 * final, así que hay que conservar cabeza y cola.
 *
 * Vive aquí, y no en el componente, para que sea testeable en Node: importar
 * `VaultGraph.tsx` arrastraría three y react-three-fiber.
 */
export function elide(label: string, max: number = MAX_LABEL_CHARS): string {
  if (max <= 1) return '…'
  if (label.length <= max) return label
  // La cola se lleva el carácter de sobra cuando el presupuesto es impar: es
  // donde vive la parte que distingue (sufijos tipo `-masa3-harina`).
  const tail = Math.ceil((max - 1) / 2)
  const head = max - 1 - tail
  return `${label.slice(0, head)}…${label.slice(-tail)}`
}
