import type { GraphNode } from './types'

/**
 * Radio visual de un nodo a partir de su número de CONEXIONES.
 *
 * Vive aquí, fuera del componente, para que sea testeable en Node: importar
 * `VaultGraph.tsx` arrastraría three y react-three-fiber.
 */

/** Mínimo: un nodo aislado tiene que seguir viéndose y siendo clicable. */
export const R_MIN = 0.13
/** Máximo: el hub más conectado del grafo. */
export const R_MAX = 0.95

/**
 * Construye la escala grado → radio para UN grafo concreto.
 *
 * Dos decisiones que parecen detalles y son lo que hace que la codificación se
 * lea:
 *
 * 1. **`√grado`, no `grado`.** Lo que el ojo compara entre dos esferas es el
 *    ÁREA que ocupan en pantalla, y el área va con el radio al cuadrado. Con
 *    radio ∝ grado, el hub de 26 enlaces se vería 676 veces más grande que uno
 *    de 1 y taparía media escena; con radio ∝ √grado el área aparente crece
 *    PROPORCIONAL al grado, que es la lectura honesta (la misma razón por la
 *    que un bubble chart escala por la raíz).
 *
 * 2. **Normalizado por el grado MÁXIMO del grafo**, no con un coeficiente fijo.
 *    Con coeficiente fijo (`0.16 + 0.085·√grado`, la versión anterior) el grueso
 *    de los nodos —grados 0 a 2— caía en 0.16-0.28, un rango de 1.75:1, MENOR
 *    que el 2.8:1 que la perspectiva introduce solo por la distancia a la
 *    cámara: un nodo de grado 2 cerca se veía más gordo que el hub de grado 26
 *    al fondo, y la codificación no decía nada. Normalizando se usa siempre el
 *    rango visual completo (~7:1), tenga el vault 50 notas o 5000.
 *
 * El TIPO de nodo no entra en el tamaño a propósito: el tamaño significa
 * conexiones y nada más. Que algo sea un fantasma o un recuerdo lo dice el
 * color.
 */
export function makeRadiusScale(
  nodes: readonly GraphNode[],
  maxDegree?: number,
): (n: GraphNode) => number {
  const observed = nodes.reduce((m, n) => Math.max(m, n.degree ?? 0), 0)
  // `Math.max(1, …)` evita dividir por cero en un grafo sin ninguna arista, en
  // el que además todos los nodos deben salir del mismo tamaño (R_MIN).
  const max = Math.max(1, maxDegree ?? observed)
  const k = Math.sqrt(max)
  return (n: GraphNode) => {
    const d = Math.max(0, n.degree ?? 0)
    // Recorte por arriba: `stats.maxDegree` viene del backend y un grafo
    // cacheado podría traer un máximo menor que el grado real de un nodo.
    const t = Math.min(1, Math.sqrt(d) / k)
    return R_MIN + (R_MAX - R_MIN) * t
  }
}
