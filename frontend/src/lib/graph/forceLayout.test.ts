import { describe, it, expect } from 'vitest'
import {
  createLayout, folderAnchors, fibonacciSphere, mulberry32,
  LAYOUT_DEFAULTS, DEFAULT_REST, ForceLayout,
} from './forceLayout'
import type { EdgeKind, GraphData, GraphEdge, GraphNode } from './types'

/* ------------------------------------------------------------------ *
 * Constructores de grafos de prueba
 * ------------------------------------------------------------------ */

type NodeSpec = { id: string; folder?: string }
type EdgeSpec = { source: string; target: string; kind?: EdgeKind; weight?: number }

/** Rellena el contrato del backend a partir de lo mínimo, y calcula `degree`
 *  como lo haría el emisor (el motor lo usa para la carga de repulsión). */
function graph(nodes: NodeSpec[], edges: EdgeSpec[] = []): GraphData {
  const deg = new Map<string, number>()
  const es: GraphEdge[] = edges.map((e) => {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
    return { source: e.source, target: e.target, kind: e.kind ?? 'link', weight: e.weight ?? 1 }
  })
  const ns: GraphNode[] = nodes.map((n) => ({
    id: n.id,
    label: n.id,
    type: 'note',
    folder: n.folder ?? '03-Conocimiento',
    tags: [],
    degree: deg.get(n.id) ?? 0,
  }))
  return { nodes: ns, edges: es, stats: {}, builtAt: 0 }
}

/** Dos cúmulos de 6 nodos (anillo interno) unidos por un solo puente, TODOS en
 *  la misma carpeta: así la forma la producen las aristas y no las anclas. */
function twoClusters(): GraphData {
  const ids: NodeSpec[] = []
  const edges: EdgeSpec[] = []
  for (const g of ['a', 'b']) {
    for (let i = 0; i < 6; i++) ids.push({ id: `${g}${i}` })
    for (let i = 0; i < 6; i++) edges.push({ source: `${g}${i}`, target: `${g}${(i + 1) % 6}` })
  }
  edges.push({ source: 'a0', target: 'b0' })
  return graph(ids, edges)
}

/** Grafo completo: el caso que revienta un motor sin techo de desplazamiento. */
function dense(n: number): GraphData {
  const ids: NodeSpec[] = []
  const edges: EdgeSpec[] = []
  for (let i = 0; i < n; i++) ids.push({ id: `n${i}` })
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push({ source: `n${i}`, target: `n${j}` })
  return graph(ids, edges)
}

const FOLDER_NAMES = [
  '02-Proyectos', '03-Conocimiento', '06-Conversaciones', 'memoria',
  '00-Inbox', '05-Archivo', '04-Diario', '01-Areas',
]

/** Tamaño real esperado en producción: 40-250 nodos, 100-400 aristas.
 *  Los extremos se eligen AL AZAR (con el PRNG del módulo → mismo grafo en cada
 *  corrida), así que con k carpetas solo ~1/k de las aristas cae dentro de la
 *  misma carpeta: es el caso ADVERSARIO para la gravedad de cúmulo, porque la
 *  estructura de enlaces tira justo en contra de la agrupación por carpeta.
 *  Un vault real enlaza mucho más dentro de su propia carpeta. */
function realistic(nodeCount = 200, edgeCount = 400, folderCount = 5): GraphData {
  const folders = FOLDER_NAMES.slice(0, folderCount)
  const kinds: EdgeKind[] = ['link', 'link', 'tag', 'mention', 'fact']
  const rnd = mulberry32(7)
  const ids: NodeSpec[] = []
  for (let i = 0; i < nodeCount; i++) {
    ids.push({ id: `n${i}`, folder: folders[i % folders.length] })
  }
  const edges: EdgeSpec[] = []
  for (let k = 0; k < edgeCount; k++) {
    const a = Math.floor(rnd() * nodeCount)
    let b = Math.floor(rnd() * nodeCount)
    if (b === a) b = (a + 1) % nodeCount
    edges.push({ source: `n${a}`, target: `n${b}`, kind: kinds[k % kinds.length], weight: 1 })
  }
  return graph(ids, edges)
}

/* ------------------------------------------------------------------ *
 * Utilidades de medida
 * ------------------------------------------------------------------ */

function dist(p: Float32Array, i: number, j: number): number {
  const dx = p[i * 3] - p[j * 3]
  const dy = p[i * 3 + 1] - p[j * 3 + 1]
  const dz = p[i * 3 + 2] - p[j * 3 + 2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function allFinite(p: Float32Array): boolean {
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false
  return true
}

/** Distancia media entre pares de la MISMA carpeta vs pares de carpeta distinta. */
function intraVsInter(data: GraphData, p: Float32Array): { intra: number; inter: number } {
  let intra = 0, intraN = 0, inter = 0, interN = 0
  for (let i = 0; i < data.nodes.length; i++) {
    for (let j = i + 1; j < data.nodes.length; j++) {
      const d = dist(p, i, j)
      if (data.nodes[i].folder === data.nodes[j].folder) { intra += d; intraN++ }
      else { inter += d; interN++ }
    }
  }
  return { intra: intra / intraN, inter: inter / interN }
}

/**
 * Peor cociente (distancia del centroide de una carpeta a SU ancla) / (a la
 * ancla ajena más próxima). < 1 significa que cada cúmulo sigue reconocible en
 * su sitio, que es la propiedad de producto: los colores no se mezclan.
 */
function worstAnchorRatio(data: GraphData, p: Float32Array): number {
  const { folders, anchors, indexOf } = folderAnchors(data, LAYOUT_DEFAULTS.clusterRadius)
  let worst = 0
  for (const folder of folders) {
    let cx = 0, cy = 0, cz = 0, count = 0
    data.nodes.forEach((node, i) => {
      if (node.folder !== folder) return
      cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2]
      count++
    })
    cx /= count; cy /= count; cz /= count
    const own = indexOf.get(folder)! * 3
    const ownD = Math.hypot(anchors[own] - cx, anchors[own + 1] - cy, anchors[own + 2] - cz)
    let nearestOther = Infinity
    for (const other of folders) {
      if (other === folder) continue
      const o = indexOf.get(other)! * 3
      const d = Math.hypot(anchors[o] - cx, anchors[o + 1] - cy, anchors[o + 2] - cz)
      if (d < nearestOther) nearestOther = d
    }
    worst = Math.max(worst, ownD / nearestOther)
  }
  return worst
}

const snapshot = (p: Float32Array) => Array.from(p)

/* ------------------------------------------------------------------ *
 * Determinismo
 * ------------------------------------------------------------------ */

describe('determinismo', () => {
  it('misma semilla ⇒ posiciones idénticas tras settle(300)', () => {
    const data = twoClusters()
    const a = createLayout(data)
    const b = createLayout(data)
    a.settle(300)
    b.settle(300)
    expect(snapshot(a.positions)).toEqual(snapshot(b.positions))
  })

  it('semilla distinta ⇒ layout distinto', () => {
    const data = twoClusters()
    const a = createLayout(data, { seed: 1 })
    const b = createLayout(data, { seed: 2 })
    a.settle(300)
    b.settle(300)
    expect(snapshot(a.positions)).not.toEqual(snapshot(b.positions))
  })

  it('step(k) equivale a k llamadas a step()', () => {
    const data = twoClusters()
    const a = createLayout(data)
    const b = createLayout(data)
    a.step(50)
    for (let i = 0; i < 50; i++) b.step()
    expect(snapshot(a.positions)).toEqual(snapshot(b.positions))
  })

  it('mulberry32 reproduce la misma secuencia y cambia con la semilla', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43)
    const seqA = [a(), a(), a()]
    expect(seqA).toEqual([b(), b(), b()])
    expect(seqA).not.toEqual([c(), c(), c()])
    for (const v of seqA) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })
})

/* ------------------------------------------------------------------ *
 * Salud numérica
 * ------------------------------------------------------------------ */

describe('salud numérica', () => {
  it('un grafo normal no produce NaN ni Infinity', () => {
    const h = createLayout(twoClusters())
    h.settle(400)
    expect(allFinite(h.positions)).toBe(true)
    expect(Number.isFinite(h.energy())).toBe(true)
  })

  it('un grafo DENSO (todos contra todos) sigue acotado', () => {
    const h = createLayout(dense(24))
    h.settle(400)
    expect(allFinite(h.positions)).toBe(true)
    // El techo de desplazamiento es lo que evita la explosión: 400 pasos a
    // maxStep=0.5 permitirían 200 u de fuga, y el resultado se queda en decenas.
    expect(h.bounds().radius).toBeLessThan(60)
  })

  it('dos nodos en la MISMA posición inicial se separan (prueba del minDist)', () => {
    const h = createLayout(graph([{ id: 'a' }, { id: 'b' }, { id: 'c' }]))
    // `positions` es mutable por contrato (el renderer la lee, un test la puede
    // sembrar): se fuerza la coincidencia EXACTA, que es el 0/0 de la repulsión.
    for (let k = 0; k < 6; k++) h.positions[k] = 0
    h.settle(200)
    expect(allFinite(h.positions)).toBe(true)
    expect(dist(h.positions, 0, 1)).toBeGreaterThan(LAYOUT_DEFAULTS.minDist * 0.5)
  })

  it('tres nodos coincidentes se abren en tres direcciones distintas', () => {
    const h = createLayout(graph([{ id: 'a' }, { id: 'b' }, { id: 'c' }]))
    for (let k = 0; k < 9; k++) h.positions[k] = 2
    h.settle(200)
    expect(allFinite(h.positions)).toBe(true)
    expect(dist(h.positions, 0, 1)).toBeGreaterThan(0.2)
    expect(dist(h.positions, 0, 2)).toBeGreaterThan(0.2)
    expect(dist(h.positions, 1, 2)).toBeGreaterThan(0.2)
  })

  it('pesos y grados basura no contaminan el layout', () => {
    const data = graph([{ id: 'a' }, { id: 'b' }])
    data.edges = [{ source: 'a', target: 'b', kind: 'link', weight: NaN }]
    data.nodes[0].degree = NaN
    data.nodes[1].degree = -5
    const h = createLayout(data)
    h.settle(200)
    expect(allFinite(h.positions)).toBe(true)
  })

  it('un peso disparatado se recorta a maxEdgeWeight', () => {
    const data = graph([{ id: 'a' }, { id: 'b' }])
    data.edges = [{ source: 'a', target: 'b', kind: 'link', weight: 1e6 }]
    const h = createLayout(data)
    h.settle(300)
    expect(allFinite(h.positions)).toBe(true)
    // Sin el techo, k·w·(d−rest) con w=1e6 dispara el par fuera de la escena.
    expect(h.bounds().radius).toBeLessThan(30)
  })
})

/* ------------------------------------------------------------------ *
 * Convergencia
 * ------------------------------------------------------------------ */

describe('convergencia', () => {
  it('la energía cinética decae muchos órdenes de magnitud', () => {
    const h = createLayout(realistic(80, 160))
    h.step(10)
    const early = h.energy()
    h.step(390)
    const late = h.energy()
    expect(early).toBeGreaterThan(0)
    expect(late).toBeLessThan(early * 0.01)
  })

  it('settle devuelve la energía final', () => {
    const h = createLayout(twoClusters())
    expect(h.settle(300)).toBeCloseTo(h.energy(), 12)
  })

  it('settle() sin argumento usa settleIterations', () => {
    const data = twoClusters()
    const a = createLayout(data)
    const b = createLayout(data)
    a.settle()
    b.settle(LAYOUT_DEFAULTS.settleIterations)
    expect(snapshot(a.positions)).toEqual(snapshot(b.positions))
  })
})

/* ------------------------------------------------------------------ *
 * Propiedades de producto: las aristas acortan, las carpetas agrupan
 * ------------------------------------------------------------------ */

describe('estructura', () => {
  it('los pares CONECTADOS acaban más cerca que los no conectados', () => {
    const data = twoClusters()
    const h = createLayout(data)
    h.settle(600)
    const n = data.nodes.length
    const linked = new Set(data.edges.map((e) => `${e.source}|${e.target}`))
    let conn = 0, connN = 0, free = 0, freeN = 0
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = data.nodes[i].id, b = data.nodes[j].id
        const isEdge = linked.has(`${a}|${b}`) || linked.has(`${b}|${a}`)
        const d = dist(h.positions, i, j)
        if (isEdge) { conn += d; connN++ } else { free += d; freeN++ }
      }
    }
    expect(connN).toBeGreaterThan(0)
    expect(freeN).toBeGreaterThan(0)
    expect(conn / connN).toBeLessThan(free / freeN)
  })

  it('la distancia media intra-carpeta es menor que la inter-carpeta', () => {
    const folders = ['02-Proyectos', '03-Conocimiento', 'memoria']
    const ids: NodeSpec[] = []
    const edges: EdgeSpec[] = []
    folders.forEach((folder, g) => {
      for (let i = 0; i < 6; i++) ids.push({ id: `${g}_${i}`, folder })
      for (let i = 0; i < 5; i++) edges.push({ source: `${g}_${i}`, target: `${g}_${i + 1}` })
    })
    const data = graph(ids, edges)
    const h = createLayout(data)
    h.settle(600)
    const { intra, inter } = intraVsInter(data, h.positions)
    expect(intra).toBeLessThan(inter)
  })

  it('cada cúmulo de carpeta acaba junto a SU ancla y no junto a otra', () => {
    const data = realistic(60, 90)
    const h = createLayout(data)
    h.settle(600)
    expect(worstAnchorRatio(data, h.positions)).toBeLessThan(1)
  })

  it('a escala real (250 nodos, 8 carpetas) los cúmulos siguen sin mezclarse', () => {
    // Caso adversario: extremos al azar ⇒ ~7 de cada 8 aristas CRUZAN carpeta,
    // o sea los muelles tiran en contra de las anclas todo el rato. Si esto se
    // rompe al afinar coeficientes, el grafo deja de mostrar cúmulos de color
    // y pasa a ser una bola gris — que es el fallo de producto, no un número.
    const data = realistic(250, 400, 8)
    const h = createLayout(data)
    h.settle(600)
    expect(allFinite(h.positions)).toBe(true)
    expect(worstAnchorRatio(data, h.positions)).toBeLessThan(1)
    const { intra, inter } = intraVsInter(data, h.positions)
    expect(intra).toBeLessThan(inter)
    // Y sigue convergiendo: 600 pasos bastan para apagar la energía cinética.
    expect(h.energy()).toBeLessThan(1)
  })

  it('una arista `link` acerca más que una `mention` del mismo peso', () => {
    const data = graph(
      [
        { id: 'l1', folder: 'A' }, { id: 'l2', folder: 'A' },
        { id: 'm1', folder: 'B' }, { id: 'm2', folder: 'B' },
      ],
      [
        { source: 'l1', target: 'l2', kind: 'link', weight: 1 },
        { source: 'm1', target: 'm2', kind: 'mention', weight: 1 },
      ],
    )
    const h = createLayout(data)
    h.settle(600)
    const linkD = dist(h.positions, 0, 1)
    const mentionD = dist(h.positions, 2, 3)
    expect(linkD).toBeLessThan(mentionD)
    // Y cada par se queda cerca de su longitud de reposo (la repulsión del par
    // los empuja un poco más allá, nunca por debajo).
    expect(linkD).toBeGreaterThan(DEFAULT_REST.link * 0.9)
    expect(mentionD).toBeGreaterThan(DEFAULT_REST.mention * 0.9)
  })

  it('restLength parcial solo mueve el kind nombrado', () => {
    const data = graph(
      [{ id: 'a', folder: 'A' }, { id: 'b', folder: 'A' }],
      [{ source: 'a', target: 'b', kind: 'link', weight: 1 }],
    )
    const base = createLayout(data)
    const long = createLayout(data, { restLength: { link: 9 } })
    base.settle(600)
    long.settle(600)
    expect(dist(long.positions, 0, 1)).toBeGreaterThan(dist(base.positions, 0, 1) + 4)
  })

  it('un hub empuja más fuerte que una hoja (carga por grado)', () => {
    // Estrella de 8 hojas: el centro tiene grado 8 y las hojas 1, así que su
    // carga es mayor y las hojas quedan repelidas más allá del reposo.
    const ids: NodeSpec[] = [{ id: 'hub' }]
    const edges: EdgeSpec[] = []
    for (let i = 0; i < 8; i++) { ids.push({ id: `leaf${i}` }); edges.push({ source: 'hub', target: `leaf${i}` }) }
    const h = createLayout(graph(ids, edges))
    h.settle(600)
    for (let i = 1; i <= 8; i++) expect(dist(h.positions, 0, i)).toBeGreaterThan(DEFAULT_REST.link)
  })
})

/* ------------------------------------------------------------------ *
 * Anclas de carpeta
 * ------------------------------------------------------------------ */

describe('anclas de carpeta', () => {
  it('el mismo GraphData coloca cada carpeta en el mismo ancla', () => {
    const data = realistic(40, 60)
    const a = folderAnchors(data)
    const b = folderAnchors(data)
    expect(a.folders).toEqual(b.folders)
    expect(Array.from(a.anchors)).toEqual(Array.from(b.anchors))
    // Y el motor usa esa misma tabla: dos handles comparten el reparto.
    const h1 = new ForceLayout(data)
    const h2 = new ForceLayout(data)
    expect(h1.folders).toEqual(h2.folders)
    expect(h1.folders).toEqual(a.folders)
  })

  it('el orden es el de primera aparición, no el alfabético', () => {
    const data = graph([
      { id: 'a', folder: 'zeta' }, { id: 'b', folder: 'alfa' }, { id: 'c', folder: 'zeta' },
    ])
    expect(folderAnchors(data).folders).toEqual(['zeta', 'alfa'])
  })

  it('una sola carpeta se ancla al ORIGEN', () => {
    // Un ancla fuera del origen arrastraría el grafo entero a un lado de la
    // cámara, que es lo peor que puede pasarle al caso más común (un vault
    // recién indexado con todo en una carpeta).
    const { anchors } = folderAnchors(graph([{ id: 'a' }, { id: 'b' }]))
    expect(Array.from(anchors.subarray(0, 3))).toEqual([0, 0, 0])
  })

  it('fibonacciSphere reparte sobre la esfera de radio pedido', () => {
    const out = new Float64Array(16 * 3)
    fibonacciSphere(16, 5, out)
    for (let k = 0; k < 16; k++) {
      expect(Math.hypot(out[k * 3], out[k * 3 + 1], out[k * 3 + 2])).toBeCloseTo(5, 6)
    }
    // Sin dos puntos encimados: la separación mínima de 16 puntos es amplia.
    let worst = Infinity
    for (let i = 0; i < 16; i++) {
      for (let j = i + 1; j < 16; j++) {
        const d = Math.hypot(out[i * 3] - out[j * 3], out[i * 3 + 1] - out[j * 3 + 1], out[i * 3 + 2] - out[j * 3 + 2])
        if (d < worst) worst = d
      }
    }
    expect(worst).toBeGreaterThan(1)
  })

  it('fibonacciSphere con 0 puntos no escribe nada', () => {
    const out = new Float64Array(3).fill(7)
    fibonacciSphere(0, 5, out)
    expect(Array.from(out)).toEqual([7, 7, 7])
  })
})

/* ------------------------------------------------------------------ *
 * Casos límite
 * ------------------------------------------------------------------ */

describe('casos límite', () => {
  it('0 nodos: nada que hacer y nada que lanzar', () => {
    const h = createLayout(graph([]))
    expect(h.positions.length).toBe(0)
    expect(() => h.step(10)).not.toThrow()
    expect(h.settle(10)).toBe(0)
    expect(h.energy()).toBe(0)
    expect(h.bounds()).toEqual({ min: [0, 0, 0], max: [0, 0, 0], radius: 0 })
    expect(() => h.pin('nope', 0, 0, 0)).not.toThrow()
    expect(() => h.unpin('nope')).not.toThrow()
  })

  it('1 nodo: converge al origen de su ancla sin oscilar', () => {
    const h = createLayout(graph([{ id: 'solo' }]))
    h.settle(400)
    expect(h.positions.length).toBe(3)
    expect(allFinite(h.positions)).toBe(true)
    // Carpeta única ⇒ ancla en el origen ⇒ el nodo acaba ahí.
    expect(Math.hypot(h.positions[0], h.positions[1], h.positions[2])).toBeLessThan(0.1)
    expect(h.energy()).toBeLessThan(1e-6)
  })

  it('aristas a ids inexistentes se ignoran sin lanzar', () => {
    const data = graph([{ id: 'a' }, { id: 'b' }])
    data.edges = [
      { source: 'a', target: 'fantasma', kind: 'link', weight: 1 },
      { source: 'nadie', target: 'b', kind: 'link', weight: 1 },
      { source: 'x', target: 'y', kind: 'link', weight: 1 },
      { source: 'a', target: 'a', kind: 'link', weight: 1 },   // bucle: sin dirección
    ]
    const h = createLayout(data)
    expect(() => h.settle(200)).not.toThrow()
    expect(allFinite(h.positions)).toBe(true)
    // Sin ninguna arista válida solo actúan repulsión y anclas: los dos nodos
    // se separan al menos el minDist.
    expect(dist(h.positions, 0, 1)).toBeGreaterThan(LAYOUT_DEFAULTS.minDist)
  })

  it('un id duplicado conserva la PRIMERA aparición en el índice', () => {
    const data = graph([{ id: 'dup' }, { id: 'otro' }, { id: 'dup' }])
    const h = createLayout(data)
    expect(h.positions.length).toBe(9)       // el duplicado ocupa su fila igual
    expect(h.index.size).toBe(2)
    expect(h.index.get('dup')).toBe(0)       // no 2
    // Y una arista contra el id duplicado resuelve a ese primer nodo.
    data.edges = [{ source: 'dup', target: 'otro', kind: 'link', weight: 1 }]
    const h2 = createLayout(data)
    h2.settle(400)
    expect(dist(h2.positions, 0, 1)).toBeLessThan(dist(h2.positions, 2, 1))
  })

  it('nodos sin carpeta caen todos en el mismo cúmulo', () => {
    const data = graph([{ id: 'a' }, { id: 'b' }])
    data.nodes.forEach((n) => { (n as { folder?: string }).folder = undefined })
    const h = createLayout(data)
    expect(() => h.settle(100)).not.toThrow()
    expect(allFinite(h.positions)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * pin / unpin
 * ------------------------------------------------------------------ */

describe('pin', () => {
  it('un nodo fijado no se mueve ni un float', () => {
    const h = createLayout(twoClusters())
    // Valores exactamente representables en float32 → comparación exacta.
    h.pin('a0', 1.5, -2.25, 0.75)
    h.settle(500)
    expect(h.positions[0]).toBe(1.5)
    expect(h.positions[1]).toBe(-2.25)
    expect(h.positions[2]).toBe(0.75)
  })

  it('el nodo fijado sigue empujando a los demás', () => {
    const h = createLayout(graph([{ id: 'p' }, { id: 'q' }]))
    h.pin('p', 0, 0, 0)
    h.settle(400)
    expect(dist(h.positions, 0, 1)).toBeGreaterThan(LAYOUT_DEFAULTS.minDist)
  })

  it('unpin lo libera', () => {
    const h = createLayout(twoClusters())
    h.pin('a0', 12, 12, 12)
    h.settle(200)
    expect(h.positions[0]).toBe(12)
    h.unpin('a0')
    h.settle(200)
    expect(h.positions[0]).not.toBe(12)
  })

  it('pin sobre un id inexistente no hace nada', () => {
    const h = createLayout(twoClusters())
    const before = snapshot(h.positions)
    h.pin('no-existe', 5, 5, 5)
    expect(snapshot(h.positions)).toEqual(before)
  })

  it('la energía de un grafo con todo fijado es exactamente 0', () => {
    const data = twoClusters()
    const h = createLayout(data)
    data.nodes.forEach((n, i) => h.pin(n.id, i, 0, 0))
    expect(h.settle(100)).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * Contrato con el renderer
 * ------------------------------------------------------------------ */

describe('contrato con el renderer', () => {
  it('positions es SIEMPRE la misma referencia (binding del InstancedMesh)', () => {
    const h = createLayout(twoClusters())
    const ref = h.positions
    h.step()
    expect(h.positions).toBe(ref)
    h.step(20)
    expect(h.positions).toBe(ref)
    h.settle(100)
    expect(h.positions).toBe(ref)
    h.pin('a0', 0, 0, 0)
    expect(h.positions).toBe(ref)
    h.unpin('a0')
    expect(h.positions).toBe(ref)
    expect(ref).toBeInstanceOf(Float32Array)
    expect(ref.length).toBe(12 * 3)
  })

  it('positions se muta EN SITIO (los valores cambian, el buffer no)', () => {
    const h = createLayout(twoClusters())
    const before = snapshot(h.positions)
    h.step(20)
    expect(snapshot(h.positions)).not.toEqual(before)
  })

  it('bounds encuadra a todos los nodos', () => {
    const h = createLayout(realistic(60, 90))
    h.settle(400)
    const b = h.bounds()
    const cx = (b.min[0] + b.max[0]) / 2
    const cy = (b.min[1] + b.max[1]) / 2
    const cz = (b.min[2] + b.max[2]) / 2
    for (let i = 0; i < 60; i++) {
      const p = h.positions
      expect(p[i * 3]).toBeGreaterThanOrEqual(b.min[0])
      expect(p[i * 3]).toBeLessThanOrEqual(b.max[0])
      const d = Math.hypot(p[i * 3] - cx, p[i * 3 + 1] - cy, p[i * 3 + 2] - cz)
      expect(d).toBeLessThanOrEqual(b.radius + 1e-6)
    }
    expect(b.radius).toBeGreaterThan(0)
  })

  it('bounds devuelve un objeto nuevo cada vez (nadie lo ve cambiar por debajo)', () => {
    const h = createLayout(twoClusters())
    const a = h.bounds()
    h.step(50)
    const b = h.bounds()
    expect(a).not.toBe(b)
    expect(a.min).not.toBe(b.min)
  })
})

/* ------------------------------------------------------------------ *
 * Presupuesto de tiempo
 * ------------------------------------------------------------------ */

describe('rendimiento', () => {
  it('settle(300) sobre 200 nodos / 400 aristas cuesta menos de 250 ms', () => {
    const data = realistic(200, 400)
    let best = Infinity
    for (let r = 0; r < 3; r++) {
      const h = createLayout(data)
      const t0 = performance.now()
      h.settle(300)
      const ms = performance.now() - t0
      if (ms < best) best = ms
      expect(allFinite(h.positions)).toBe(true)
    }
    // eslint-disable-next-line no-console
    console.log(`[bench] settle(300) · 200 nodos / 400 aristas: ${best.toFixed(1)} ms (mejor de 3)`)
    expect(best).toBeLessThan(250)
  })
})
