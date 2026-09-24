// frontend/src/lib/graph/types.ts
/**
 * Contrato de datos del grafo de conocimiento de la bóveda + opciones del motor
 * de layout.
 *
 * Los tipos del grafo los EMITE el backend tal cual; este fichero es solo su
 * espejo tipado en el frontend, así que no se cambian sin cambiar al emisor.
 *
 * Aquí NO hay lógica: la matemática vive en `forceLayout.ts` y el render en los
 * componentes r3f. Este módulo (y todo `lib/graph/`) tiene que poder importarse
 * desde Node bajo vitest, así que jamás importa `three` ni `@react-three/*` —
 * misma disciplina que `lib/sim/` y `lib/geometry/`.
 */

/** Qué representa un nodo. `ghost` = referencia `[[wikilink]]` a una nota que
 *  todavía no existe en el vault (Obsidian las pinta huecas; aquí también). */
export type NodeType = 'note' | 'tag' | 'fact' | 'conversation' | 'ghost'

/** Cómo se relacionan dos nodos, de más fuerte a más débil:
 *  `link` = wikilink explícito, `tag` = etiqueta compartida,
 *  `mention` = el nombre aparece en el texto, `fact` = hecho de la memoria. */
export type EdgeKind = 'link' | 'tag' | 'mention' | 'fact'

export interface GraphNode {
  id: string
  label: string
  type: NodeType
  /** Carpeta de PRIMER nivel del vault (`02-Proyectos`, `memoria`, …). Es la
   *  clave de agrupación visual: un ancla por carpeta distinta. */
  folder: string
  path?: string
  tags: string[]
  degree: number
  ts?: number
}

export interface GraphEdge {
  source: string
  target: string
  kind: EdgeKind
  weight: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: Record<string, number>
  builtAt: number
}

/**
 * Coeficientes del motor. TODOS con nombre y TODOS con default en un único
 * objeto exportado (`LAYOUT_DEFAULTS`), igual que `CLAP_DEFAULTS` o
 * `gestures/config.ts`: si los números se reparten por el fichero, nadie
 * encuentra el que hay que mover.
 */
export interface LayoutOptions {
  /** Semilla del PRNG propio. Único punto de azar del motor (posiciones
   *  iniciales), así que misma semilla ⇒ mismo layout bit a bit. */
  seed: number
  /** Paso de integración FIJO. No se ata al frame rate por la misma razón que
   *  el `FixedClock` del motor de simulación: un layout que depende de si el
   *  compositor soltó un frame no es reproducible ni depurable. */
  dt: number
  /** Fracción de velocidad que sobrevive a cada paso (0–1). Es lo que hace que
   *  el sistema se ASIENTE en vez de oscilar para siempre. */
  damping: number
  /** Desplazamiento máximo por paso, en unidades de escena. Sin este techo un
   *  grafo denso explota en las primeras iteraciones (la repulsión de un blob
   *  inicial es enorme) y los nodos salen despedidos antes de que los muelles
   *  tengan algo que tirar. */
  maxStep: number
  /** k_rep de Coulomb: |F| = k_rep·q_i·q_j / d². */
  repulsion: number
  /** Distancia mínima usada en el denominador de la repulsión. Acota la fuerza
   *  a k_rep·q²/minDist² y mata la singularidad de dos nodos encimados. */
  minDist: number
  /** Carga por grado: q = 1 + chargeDegreeScale·√degree. Un hub empuja más
   *  fuerte para no quedar sepultado bajo sus propios vecinos. */
  chargeDegreeScale: number
  /** Constante del muelle de Hooke por arista (se multiplica por `weight`). */
  springK: number
  /** Techo del peso de arista. Un `weight` disparatado del backend tiraría del
   *  grafo entero desde una sola arista; recortarlo es más barato que confiar. */
  maxEdgeWeight: number
  /** Longitud de reposo por tipo de arista. PARCIAL: lo que falte cae al
   *  default, para poder afinar un solo `kind` sin repetir los cuatro. */
  restLength: Partial<Record<EdgeKind, number>>
  /** Muelle de cada nodo hacia el ancla de SU carpeta. Es lo que produce los
   *  cúmulos de color en pantalla — requisito de producto, no adorno. */
  clusterStrength: number
  /** Radio de la esfera donde se reparten las anclas de carpeta. */
  clusterRadius: number
  /** Gravedad débil al origen: evita que un componente desconectado (sin
   *  aristas que lo sujeten) se escape al infinito. */
  centerGravity: number
  /** Radio de la nube de posiciones iniciales. */
  initialRadius: number
  /** Iteraciones por defecto de `settle()`. */
  settleIterations: number
}

/** Caja envolvente + radio de encuadre, para que la cámara sepa dónde mirar. */
export interface LayoutBounds {
  min: [number, number, number]
  max: [number, number, number]
  /** Distancia máxima de un nodo al CENTRO de la caja (no al origen). */
  radius: number
}

export interface LayoutHandle {
  /**
   * xyz plano, longitud `nodes.length * 3`, mutado EN SITIO.
   *
   * La misma referencia durante toda la vida del handle: el renderer la lee
   * directo en un `InstancedMesh`, así que reasignarla (en vez de mutarla)
   * rompería el binding y la escena se quedaría congelada en el primer frame.
   */
  positions: Float32Array
  /** id → índice de nodo. Un id duplicado conserva la PRIMERA aparición. */
  index: Map<string, number>
  /** Avanza la simulación. CERO asignaciones dentro: en este WebKitGTK sobre
   *  iGPU la basura por frame se ve como tirones. */
  step(iterations?: number): void
  /** Muchos pasos de golpe (pre-asentar antes del primer frame). Devuelve la
   *  energía final. */
  settle(iterations?: number): number
  /** Energía cinética total. Sirve para saber si convergió y para que el HUD
   *  delate un layout inestable. */
  energy(): number
  /** Fija un nodo: deja de moverse pero sigue empujando a los demás (así
   *  «enfocar una nota» puede anclarla al centro sin deformar la física). */
  pin(id: string, x: number, y: number, z: number): void
  unpin(id: string): void
  bounds(): LayoutBounds
}
