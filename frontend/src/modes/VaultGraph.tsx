import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useVaultGraphStore } from '../state/vaultGraphStore'
import { useJarvisStore } from '../state/jarvisStore'
import { createLayout } from '../lib/graph/forceLayout'
import { elide } from '../lib/graph/label'
import { makeRadiusScale } from '../lib/graph/size'
import type { GraphData, GraphNode } from '../lib/graph/types'
import type { LayoutHandle } from '../lib/graph/types'
import { BG, FOLDER_HUE, HUE, TEXT, hexToRgb, nodeHue, withAlpha } from '../lib/theme'
import { Model3DErrorBoundary } from '../components/Model3DViewer'
import { PanelSection } from '../components/PanelSection'
import { StatRow } from '../components/StatRow'
import { Badge } from '../components/Badge'

/* ─────────────────────────────────────────────────────────────
   Grafo de conocimiento en 3D.

   Lo que el señor ve: la bóveda de Obsidian, la memoria de Jarvis y las
   conversaciones como UNA red, agrupada en cúmulos de color por carpeta.

   Tres reglas de este fichero, todas heredadas de las cicatrices del repo
   (ver CLAUDE.md, secciones de gestos y de `kind: 'simulation'`):

   1. **Nada asigna memoria dentro de `useFrame`.** Matrices, buffers y colores
      se crean una vez y se MUTAN. En este WebKitGTK sobre iGPU la basura por
      frame se ve como tirones.
   2. **Dos draw calls para todo el grafo**: un `InstancedMesh` para los nodos y
      un `LineSegments` para las aristas. Un mesh por nota sería inmanejable en
      cuanto la bóveda crezca.
   3. **La simulación se CONGELA al converger.** Un layout ya asentado que sigue
      integrando es CPU quemada sin ningún píxel nuevo; y con la física parada
      las etiquetas pueden ser DOM (`Html`) en vez de texto en GPU, que es lo
      que evita meter troika/SDF y su descarga de fuente.
───────────────────────────────────────────────────────────── */

/** Pasos de integración por frame mientras el layout se asienta. */
const STEPS_PER_FRAME = 2
/** Energía por debajo de la cual se considera asentado y se deja de integrar. */
const SETTLE_EPSILON = 0.004
/** Tope duro de frames integrando: un grafo patológico no puede hervir para siempre. */
const MAX_SETTLE_FRAMES = 900
/** Cuántas etiquetas DOM se permiten a la vez. Más de esto y se lee peor, además de costar. */
const MAX_LABELS = 14
/**
 * Campo de visión ESTRECHO (teleobjetivo), no gran angular.
 *
 * El tamaño de un nodo codifica su número de conexiones, y con fov 55° la
 * perspectiva introducía por sí sola una variación aparente de 2.8:1 solo por
 * la distancia a la cámara — más que la que separaba al grueso de los nodos
 * entre sí. Resultado medido en pantalla: nodos de grado 2 en primer plano se
 * veían más gordos que el hub de grado 26 al fondo, y la codificación no decía
 * nada. Un fov de 32° con la cámara más lejos baja esa variación a ~1.67:1, muy
 * por debajo del 7:1 de la escala por grado, así que el tamaño vuelve a
 * significar conexiones. Sigue habiendo profundidad, solo menos exagerada.
 */
const FOV = 32
/** Distancia de encuadre en radios. Compensa el fov estrecho para que el grafo siga cabiendo. */
const FRAME_DISTANCE = 4.0

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

interface SceneProps {
  data: GraphData
  layout: LayoutHandle
  focusedId: string | null
  focusNonce: number
  query: string
  onPick: (id: string | null) => void
  onSettled: () => void
}

function GraphScene({ data, layout, focusedId, focusNonce, query, onPick, onSettled }: SceneProps) {
  const { camera } = useThree()
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const linesRef = useRef<THREE.LineSegments>(null)
  const controlsRef = useRef<{ target: THREE.Vector3; update: () => void } | null>(null)
  const framesRef = useRef(0)
  const settledRef = useRef(false)

  const nodes = data.nodes
  const count = nodes.length

  // ── Buffers, creados UNA vez por grafo ───────────────────────────────────
  const scratch = useMemo(() => ({
    dummy: new THREE.Object3D(),
    color: new THREE.Color(),
    target: new THREE.Vector3(),
  }), [])

  // `stats.maxDegree` lo calcula ya el backend; se le pasa para no recorrer los
  // nodos otra vez (y para que el radio no dependa de si el grafo llegó filtrado).
  const radiusOf = useMemo(
    () => makeRadiusScale(nodes, typeof data.stats?.maxDegree === 'number' ? data.stats.maxDegree : undefined),
    [nodes, data.stats],
  )

  const radii = useMemo(
    () => Float32Array.from(nodes, (n) => radiusOf(n)),
    [nodes, radiusOf],
  )

  /** Aristas cuyos DOS extremos existen. Una arista colgando sería un segmento al origen. */
  const edgePairs = useMemo(() => {
    const pairs: number[] = []
    for (const e of data.edges) {
      const a = layout.index.get(e.source)
      const b = layout.index.get(e.target)
      if (a === undefined || b === undefined) continue
      pairs.push(a, b)
    }
    return Int32Array.from(pairs)
  }, [data.edges, layout])

  const edgeCount = edgePairs.length / 2

  const lineGeom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edgeCount * 6), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(edgeCount * 6), 3))
    return g
  }, [edgeCount])

  // Geometría de nodo compartida. Icosaedro de detalle 1 (42 vértices): a este
  // tamaño en pantalla es indistinguible de una esfera y cuesta la décima parte.
  const nodeGeom = useMemo(() => new THREE.IcosahedronGeometry(1, 1), [])

  useEffect(() => () => { lineGeom.dispose(); nodeGeom.dispose() }, [lineGeom, nodeGeom])

  // ── Color e intensidad: se recalculan solo al cambiar foco o filtro ───────
  // Atenuar en vez de ocultar: esconder los nodos que no casan rompe las
  // aristas y el grafo deja de explicar de qué está hecho lo que sí casa.
  const highlight = useMemo(() => {
    const q = normalize(query.trim())
    const neighbors = new Set<string>()
    if (focusedId) {
      neighbors.add(focusedId)
      for (const e of data.edges) {
        if (e.source === focusedId) neighbors.add(e.target)
        if (e.target === focusedId) neighbors.add(e.source)
      }
    }
    const on = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const n = nodes[i]
      const matchesQuery = !q || normalize(n.label).includes(q) || normalize(n.id).includes(q)
      const inFocus = !focusedId || neighbors.has(n.id)
      on[i] = matchesQuery && inFocus ? 1 : q || focusedId ? 0.12 : 1
    }
    return { on, neighbors, hasQuery: Boolean(q) }
  }, [query, focusedId, data.edges, nodes, count])

  // Colores de instancia y de arista. Fuera de useFrame a propósito: solo
  // dependen del grafo y del resaltado, nunca del tiempo.
  useEffect(() => {
    const mesh = meshRef.current
    if (!mesh) return
    for (let i = 0; i < count; i++) {
      const [r, g, b] = hexToRgb(nodeHue(nodes[i]))
      const k = highlight.on[i]
      // Mezcla hacia el fondo en vez de bajar la opacidad: con transparencia,
      // 200 esferas obligarían a ordenar por profundidad cada frame.
      const [br, bg, bb] = hexToRgb(BG)
      scratch.color.setRGB(
        (br + (r - br) * k) / 255,
        (bg + (g - bg) * k) / 255,
        (bb + (b - bb) * k) / 255,
      )
      mesh.setColorAt(i, scratch.color)
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

    const colors = lineGeom.getAttribute('color') as THREE.BufferAttribute
    const arr = colors.array as Float32Array
    for (let e = 0; e < edgeCount; e++) {
      const a = edgePairs[e * 2]
      const b = edgePairs[e * 2 + 1]
      // Gradiente por arista: cada extremo lleva el hue de SU nodo, así el
      // enlace dice de dónde a dónde va sin necesidad de flechas.
      const [ar, ag, ab] = hexToRgb(nodeHue(nodes[a]))
      const [br2, bg2, bb2] = hexToRgb(nodeHue(nodes[b]))
      const ka = highlight.on[a] * 0.55
      const kb = highlight.on[b] * 0.55
      arr[e * 6 + 0] = (ar / 255) * ka
      arr[e * 6 + 1] = (ag / 255) * ka
      arr[e * 6 + 2] = (ab / 255) * ka
      arr[e * 6 + 3] = (br2 / 255) * kb
      arr[e * 6 + 4] = (bg2 / 255) * kb
      arr[e * 6 + 5] = (bb2 / 255) * kb
    }
    colors.needsUpdate = true
  }, [highlight, nodes, count, edgePairs, edgeCount, lineGeom, scratch])

  // ── Foco: la cámara viaja, el grafo NO se mueve ───────────────────────────
  // Anclar el nodo enfocado al centro tironearía toda la red cada vez que el
  // señor mira otra nota. Se mueve el punto de órbita, que es reversible.
  useEffect(() => {
    if (!focusedId) return
    const i = layout.index.get(focusedId)
    if (i === undefined) return
    const p = layout.positions
    scratch.target.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])
    const ctl = controlsRef.current
    if (ctl) {
      ctl.target.copy(scratch.target)
      ctl.update()
    }
    // Acerca la cámara manteniendo su dirección actual: un salto a una posición
    // fija desorienta, perder la orientación del cúmulo desorienta más.
    const dir = camera.position.clone().sub(scratch.target).normalize()
    camera.position.copy(scratch.target).addScaledVector(dir, 6)
  }, [focusedId, focusNonce, layout, camera, scratch])

  // Encuadre inicial: que el grafo entero quepa sin que nadie toque la rueda.
  // Apunta al CENTRO REAL de la nube, no al origen: los componentes
  // desconectados desplazan el centroide, y mirando a (0,0,0) el grafo quedaba
  // pegado al borde superior con media pantalla vacía debajo.
  useEffect(() => {
    const { min, max, radius } = layout.bounds()
    const cx = (min[0] + max[0]) / 2
    const cy = (min[1] + max[1]) / 2
    const cz = (min[2] + max[2]) / 2
    const d = Math.max(8, radius * FRAME_DISTANCE)
    camera.position.set(cx + d * 0.3, cy + d * 0.25, cz + d)
    camera.lookAt(cx, cy, cz)

    // El HUD se come ~400 px del borde derecho, así que centrar en la VENTANA
    // deja media red debajo del panel. Se desplaza la vista a lo largo del eje
    // derecho de la cámara para que el grafo quede centrado en el hueco libre;
    // mover cámara y objetivo a la vez es un paneo, no una rotación, así que la
    // orientación de los cúmulos no cambia.
    const dir = scratch.target.set(0, 0, 0)
    camera.getWorldDirection(dir)
    const right = dir.cross(camera.up).normalize().multiplyScalar(radius * 0.32)
    camera.position.add(right)

    const ctl = controlsRef.current
    if (ctl) { ctl.target.set(cx, cy, cz).add(right); ctl.update() }
  }, [layout, camera])

  useFrame(() => {
    const mesh = meshRef.current
    if (!mesh) return

    // Integra solo mientras no haya convergido.
    if (!settledRef.current) {
      layout.step(STEPS_PER_FRAME)
      framesRef.current += 1
      if (layout.energy() < SETTLE_EPSILON || framesRef.current > MAX_SETTLE_FRAMES) {
        settledRef.current = true
        onSettled()
      }
    } else if (framesRef.current < 0) {
      return // congelado y sin nada que repintar
    }

    const pos = layout.positions
    const { dummy } = scratch

    for (let i = 0; i < count; i++) {
      dummy.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      // 1.25 y no 1.6: el nodo enfocado ya se distingue por su etiqueta y por
      // tener a los vecinos encendidos, y un resalte grande lo hacía PARECER
      // más conectado de lo que está — justo lo que el tamaño codifica.
      const boost = nodes[i].id === focusedId ? 1.25 : 1
      dummy.scale.setScalar(radii[i] * boost)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true

    const attr = lineGeom.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    for (let e = 0; e < edgeCount; e++) {
      const a = edgePairs[e * 2] * 3
      const b = edgePairs[e * 2 + 1] * 3
      arr[e * 6 + 0] = pos[a]
      arr[e * 6 + 1] = pos[a + 1]
      arr[e * 6 + 2] = pos[a + 2]
      arr[e * 6 + 3] = pos[b]
      arr[e * 6 + 4] = pos[b + 1]
      arr[e * 6 + 5] = pos[b + 2]
    }
    attr.needsUpdate = true

    // Una vez congelado, este frame es el ÚLTIMO que escribe buffers.
    if (settledRef.current) framesRef.current = -1
  })

  /** Etiquetas: el nodo enfocado, sus vecinos y los hubs. Solo cuando ya no se mueve nada. */
  const labelled = useMemo(() => {
    const q = normalize(query.trim())
    const pick: GraphNode[] = []
    if (q) {
      pick.push(...nodes.filter((n) => normalize(n.label).includes(q)))
    } else if (focusedId) {
      pick.push(...nodes.filter((n) => highlight.neighbors.has(n.id)))
    } else {
      // Ordena por grado pero DEGRADA facts y conversaciones: son hojas por
      // naturaleza y, etiquetadas, tapan la estructura que sí explica el grafo.
      const weight = (n: GraphNode) => (n.type === 'note' ? 2 : n.type === 'ghost' ? 0 : 1)
      pick.push(...[...nodes].sort((a, b) => weight(b) - weight(a) || b.degree - a.degree))
    }
    return pick.slice(0, MAX_LABELS)
  }, [nodes, query, focusedId, highlight])

  const handleClick = useCallback((e: { instanceId?: number; stopPropagation: () => void }) => {
    e.stopPropagation()
    if (e.instanceId == null) return
    const n = nodes[e.instanceId]
    onPick(n ? n.id : null)
  }, [nodes, onPick])

  return (
    <>
      <color attach="background" args={[BG]} />
      <ambientLight intensity={0.6} />

      <instancedMesh
        ref={meshRef}
        args={[nodeGeom, undefined, count]}
        onPointerDown={handleClick}
      >
        {/* Basic y no standard: el color ES el dato (el hue de la carpeta). Un
            material con luces lo tiznaría según dónde caiga la lámpara.

            SIN `vertexColors`: eso lee un atributo `color` de la GEOMETRÍA, y
            el icosaedro compartido no lo tiene, así que el shader multiplicaba
            por basura y los 48 nodos salían negros mientras las aristas sí se
            veían. El color por instancia (`setColorAt` → `instanceColor`) lo
            aplica three por su cuenta. */}
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      <lineSegments ref={linesRef} geometry={lineGeom}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.75}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>

      {labelled.map((n) => {
        const i = layout.index.get(n.id)
        if (i === undefined) return null
        const p = layout.positions
        return (
          <Html
            key={n.id}
            position={[p[i * 3], p[i * 3 + 1] + radiusOf(n) + 0.22, p[i * 3 + 2]]}
            center
            /* SIN distanceFactor: escalaba la etiqueta por la distancia a la
               cámara, así que los nodos cercanos salían con texto gigante
               (medido en pantalla: cuatro etiquetas de 20 px tapando el HUD) y
               los lejanos ilegibles. Un grafo se lee con etiquetas de tamaño
               fijo — es lo que hace Obsidian. */
            zIndexRange={[0, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <span
              className={`graph-label${n.id === focusedId ? ' graph-label--focus' : ''}`}
              style={{ color: nodeHue(n), borderColor: withAlpha(nodeHue(n), 0.3) }}
              title={n.label}
            >
              {elide(n.label)}
            </span>
          </Html>
        )
      })}

      <OrbitControls
        ref={controlsRef as never}
        enablePan
        enableZoom
        autoRotate={!focusedId && !query}
        autoRotateSpeed={0.22}
        rotateSpeed={0.6}
        zoomSpeed={0.8}
      />
    </>
  )
}

/* ─────────────────────────────────────────────────────────────
   HUD — DOM sobre el lienzo. Nada de esto vive en la escena 3D:
   texto en GPU costaría una fuente SDF y se leería peor.
───────────────────────────────────────────────────────────── */

function Legend({ folders, maxDegree }: { folders: Map<string, number>; maxDegree?: number }) {
  const rows = [...folders.entries()].sort((a, b) => b[1] - a[1])
  return (
    <PanelSection title="Cúmulos" meta={`${rows.length}`}>
      {rows.map(([folder, n]) => (
        <div key={folder} className="legend-row">
          <i className="legend-swatch" style={{ background: FOLDER_HUE[folder] ?? nodeHue({ folder }) }} />
          <span className="legend-name">{folder}</span>
          <span className="legend-count">{n}</span>
        </div>
      ))}
      {/* Las dos codificaciones se explican donde el señor ya está mirando el
          color. Un gráfico que codifica una magnitud en el tamaño y no lo dice
          obliga a adivinar si un nodo es grande por importante o por cercano. */}
      <div className="legend-encoding">
        <span className="legend-encoding-dots" aria-hidden>
          <i style={{ width: 4, height: 4 }} />
          <i style={{ width: 7, height: 7 }} />
          <i style={{ width: 11, height: 11 }} />
        </span>
        <span>tamaño = enlaces{typeof maxDegree === 'number' ? ` (0–${maxDegree})` : ''}</span>
      </div>
    </PanelSection>
  )
}

function Detail({ node, data, onPick }: { node: GraphNode; data: GraphData; onPick: (id: string) => void }) {
  const links = useMemo(() => {
    const out: { id: string; label: string; kind: string }[] = []
    const byId = new Map(data.nodes.map((n) => [n.id, n]))
    for (const e of data.edges) {
      const other = e.source === node.id ? e.target : e.target === node.id ? e.source : null
      if (!other) continue
      const n = byId.get(other)
      if (n) out.push({ id: n.id, label: n.label, kind: e.kind })
    }
    return out
  }, [node, data])

  const TYPE_LABEL: Record<string, string> = {
    note: 'Nota', fact: 'Recuerdo', conversation: 'Conversación', tag: 'Etiqueta', ghost: 'Sin crear',
  }

  return (
    <PanelSection title="Nodo" tone={node.type === 'ghost' ? 'idle' : 'info'}>
      <div className="graph-detail-title" style={{ color: nodeHue(node) }}>{node.label}</div>
      <div className="graph-detail-badges">
        <Badge tone={node.type === 'ghost' ? 'idle' : 'info'}>{TYPE_LABEL[node.type] ?? node.type}</Badge>
        {node.folder && <Badge tone="idle">{node.folder}</Badge>}
        {node.tags.slice(0, 3).map((t) => <Badge key={t} tone="ok">{t}</Badge>)}
      </div>
      <StatRow label="Enlaces" value={node.degree} />
      {links.length > 0 && (
        <div className="graph-detail-links">
          {links.slice(0, 10).map((l) => (
            <button key={`${l.id}-${l.kind}`} className="graph-link-chip" onClick={() => onPick(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      )}
    </PanelSection>
  )
}

export function VaultGraph() {
  const { data, status, error, focusedId, focusNonce, query, load, setFocused, setQuery } =
    useVaultGraphStore()
  const setZoomedMode = useJarvisStore((s) => s.setZoomedMode)
  const [, setSettled] = useState(false)

  useEffect(() => { void load() }, [load])

  // El layout se crea UNA vez por grafo. Recrearlo en cada render reiniciaría
  // la física y el grafo no dejaría de temblar nunca.
  const layout = useMemo(() => (data ? createLayout(data) : null), [data])

  const folders = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of data?.nodes ?? []) m.set(n.folder, (m.get(n.folder) ?? 0) + 1)
    return m
  }, [data])

  const focusedNode = useMemo(
    () => data?.nodes.find((n) => n.id === focusedId) ?? null,
    [data, focusedId],
  )

  return (
    <div className="vault-graph">
      {layout && data && (
        <Model3DErrorBoundary>
          <Canvas
            className="vault-graph-canvas"
            camera={{ position: [6, 5, 16], fov: FOV }}
            onPointerMissed={() => setFocused(null)}
          >
            <GraphScene
              data={data}
              layout={layout}
              focusedId={focusedId}
              focusNonce={focusNonce}
              query={query}
              onPick={setFocused}
              onSettled={() => setSettled(true)}
            />
          </Canvas>
        </Model3DErrorBoundary>
      )}

      <div className="vault-graph-hud">
        <header className="vault-graph-head">
          <div>
            <h2 className="vault-graph-title">Grafo de Conocimiento</h2>
            <p className="vault-graph-sub">
              {status === 'ready' && data
                ? `${data.nodes.length} nodos · ${data.edges.length} enlaces`
                : status === 'loading' ? 'Leyendo la bóveda…'
                : status === 'error' ? 'Sin grafo' : ''}
            </p>
          </div>
          <button className="vault-graph-close" onClick={() => setZoomedMode(null)}>← Volver</button>
        </header>

        <input
          className="hud-input vault-graph-search"
          placeholder="Filtrar nodos…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {status === 'error' && (
          <PanelSection title="Error" tone="fail">
            <StatRow label="Motivo" value={error ?? 'desconocido'} wrap />
            <StatRow label="Reintentar" value="↻" tone="info" onClick={() => void load({ force: true })} />
          </PanelSection>
        )}

        {focusedNode && data
          ? <Detail node={focusedNode} data={data} onPick={setFocused} />
          : <Legend folders={folders} maxDegree={typeof data?.stats?.maxDegree === 'number' ? data.stats.maxDegree : undefined} />}

        {data && (
          <PanelSection title="Composición" tone="idle">
            {Object.entries(data.stats).map(([k, v]) => (
              <StatRow key={k} label={k} value={v} />
            ))}
          </PanelSection>
        )}
      </div>

      {status === 'loading' && (
        <div className="vault-graph-loading" style={{ color: HUE.info }}>
          <span style={{ color: TEXT.muted }}>Tejiendo la red…</span>
        </div>
      )}
    </div>
  )
}
