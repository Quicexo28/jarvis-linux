// frontend/src/lib/graph/forceLayout.ts
/**
 * Motor de layout force-directed 3D para el grafo de la bóveda.
 *
 * Determinista y SIN asignaciones por paso. Las dos cosas son requisitos, no
 * preferencias:
 *
 *  · Determinista porque el layout es memoria visual: el señor aprende dónde
 *    está `03-Conocimiento` en la escena. Si dos arranques colocan los cúmulos
 *    en sitios distintos, el grafo deja de ser un mapa y pasa a ser un adorno.
 *    De ahí el PRNG propio sembrado (mulberry32) y las anclas por espiral de
 *    Fibonacci — `Math.random()` está PROHIBIDO en este módulo.
 *  · Sin asignaciones porque `step()` corre dentro del bucle de r3f. En este
 *    WebKitGTK sobre iGPU la basura por frame se ve como tirones, misma
 *    disciplina que el motor de simulación (`lib/sim/`) y el pipeline de
 *    gestos: los buffers se crean UNA vez en el constructor y se mutan.
 *
 * Términos de fuerza, y ni uno más:
 *   1. Repulsión de Coulomb entre TODOS los pares (O(n²), aceptable a 40-250
 *      nodos), con carga ∝ √degree y un `minDist` que acota la singularidad.
 *   2. Muelle de Hooke por arista hacia una longitud de reposo que depende del
 *      `kind` (un wikilink es estructura; una mención es una casualidad).
 *   3. Muelle de cada nodo al ancla de su carpeta → cúmulos de color.
 *   4. Gravedad débil al origen → los componentes sueltos no se van al limbo.
 *   5. Amortiguación + techo de desplazamiento por paso.
 *   6. Euler semi-implícito con `dt` FIJO.
 *
 * Three-free a propósito: corre en Node bajo vitest, que es donde se prueban
 * las propiedades (determinismo, convergencia, coherencia de cúmulo).
 */

import type {
  EdgeKind, GraphData, LayoutBounds, LayoutHandle, LayoutOptions,
} from './types'

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

/**
 * Longitudes de reposo por tipo de arista.
 *
 * `link` es CORTO porque un wikilink es la estructura real del vault: lo que el
 * señor escribió a mano, y lo que debe dominar la forma del grafo. `mention` y
 * `fact` son LARGOS porque son asociaciones débiles (el nombre apareció en un
 * texto, un hecho de la memoria roza el tema): con la misma longitud que un
 * link deformarían la estructura hasta que un vecino accidental pareciera tan
 * importante como uno declarado. `tag` queda en medio — agrupa de verdad, pero
 * una etiqueta compartida es más barata que un enlace.
 */
export const DEFAULT_REST: Record<EdgeKind, number> = {
  link: 2.0,
  tag: 3.0,
  mention: 4.5,
  fact: 4.5,
}

export const LAYOUT_DEFAULTS: LayoutOptions = {
  seed: 1337,
  dt: 0.25,              // FIJO. v_max = maxStep/dt = 2 u/paso de simulación.
  damping: 0.85,         // ~0.85^400 ≈ 1e-28: la energía cinética se muere sola
  maxStep: 0.5,          // techo de desplazamiento: sin él el blob inicial de un
                         // grafo denso se autoexpulsa en las 3 primeras iteraciones
  repulsion: 4,
  minDist: 0.8,          // |F_rep| ≤ 4·q²/0.64 — acotada aunque dos nodos coincidan
  chargeDegreeScale: 0.35, // q = 1 + 0.35·√deg → un hub de grado 25 empuja 2.75×
  springK: 2.2,
  maxEdgeWeight: 4,
  restLength: DEFAULT_REST,
  clusterStrength: 0.5,
  clusterRadius: 12,     // con 6 carpetas: anclas a ≥17 u, cúmulos de radio ~5
  centerGravity: 0.03,   // débil a propósito: solo tiene que impedir la fuga
  initialRadius: 8,
  settleIterations: 300,
}

/** Dos nodos más cerca que 1e-6 se consideran COINCIDENTES: ahí la dirección de
 *  la repulsión es 0/0 → NaN. Se desempata con un empujón determinista. */
const COINCIDENT_EPS2 = 1e-12
const COINCIDENT_NUDGE = 1e-3

/* ------------------------------------------------------------------ *
 * PRNG y anclas (deterministas, puros, testeables)
 * ------------------------------------------------------------------ */

/** mulberry32: 6 líneas, sin estado global, sembrable. `Math.random()` no sirve
 *  aquí — no se puede sembrar, así que el layout no sería reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Espiral de Fibonacci sobre la esfera: `count` puntos casi equidistantes,
 * escritos como triples xyz en `out` (longitud ≥ count*3).
 *
 * Fibonacci y NO azar porque las anclas son la identidad espacial de cada
 * carpeta: `03-Conocimiento` tiene que caer en el MISMO sitio en cada arranque.
 * Un reparto aleatorio (aunque sembrado) además amontona: la espiral garantiza
 * separación angular pareja, que es justo lo que mantiene los cúmulos legibles
 * cuando hay 6-8 carpetas.
 *
 * `count === 1` es un caso aparte: con una sola carpeta no hay nada que separar
 * y un ancla fuera del origen arrastraría el grafo ENTERO a un lado de la
 * cámara. Se ancla al origen.
 */
export function fibonacciSphere(count: number, radius: number, out: Float64Array): void {
  if (count <= 0) return
  if (count === 1) { out[0] = 0; out[1] = 0; out[2] = 0; return }
  // Ángulo de oro: la vuelta irracional que evita que los puntos se alineen.
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let k = 0; k < count; k++) {
    // (2k+1)/count en vez de k/count: reparto simétrico que no clava puntos
    // exactamente en los polos (ahí la espiral degenera).
    const y = 1 - (2 * k + 1) / count
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * k
    out[k * 3] = Math.cos(theta) * r * radius
    out[k * 3 + 1] = y * radius
    out[k * 3 + 2] = Math.sin(theta) * r * radius
  }
}

/**
 * Tabla carpeta → ancla. El ORDEN es el de primera aparición en `data.nodes`,
 * así que el mismo `GraphData` produce siempre la misma asignación (dos handles
 * del mismo grafo colocan una carpeta en el mismo punto). Exportada porque el
 * renderer también la quiere: etiquetas y colores de cúmulo cuelgan de ella.
 */
export function folderAnchors(
  data: GraphData, radius: number = LAYOUT_DEFAULTS.clusterRadius,
): { folders: string[]; indexOf: Map<string, number>; anchors: Float64Array } {
  const folders: string[] = []
  const indexOf = new Map<string, number>()
  const nodes = data.nodes ?? []
  for (let i = 0; i < nodes.length; i++) {
    const folder = nodes[i]?.folder ?? ''
    if (!indexOf.has(folder)) { indexOf.set(folder, folders.length); folders.push(folder) }
  }
  const anchors = new Float64Array(Math.max(1, folders.length) * 3)
  fibonacciSphere(folders.length, radius, anchors)
  return { folders, indexOf, anchors }
}

/* ------------------------------------------------------------------ *
 * Motor
 * ------------------------------------------------------------------ */

export class ForceLayout implements LayoutHandle {
  /** NUNCA se reasigna — ver `LayoutHandle.positions`. */
  readonly positions: Float32Array
  readonly index: Map<string, number>
  readonly folders: string[]

  private readonly opts: LayoutOptions
  private readonly count: number
  private readonly vel: Float64Array
  private readonly force: Float64Array
  private readonly charge: Float64Array
  private readonly anchorOf: Int32Array
  private readonly anchors: Float64Array
  private readonly pinned: Uint8Array
  private readonly edgeA: Int32Array
  private readonly edgeB: Int32Array
  private readonly edgeW: Float64Array
  private readonly edgeRest: Float64Array
  private readonly edgeCount: number
  /** Derivados precalculados: en el bucle de pares no se divide ni se eleva. */
  private readonly minDist2: number
  private readonly vmax: number
  private readonly vmax2: number

  constructor(data: GraphData, opts?: Partial<LayoutOptions>) {
    const o: LayoutOptions = { ...LAYOUT_DEFAULTS, ...opts }
    // `restLength` es PARCIAL por contrato: un spread plano perdería los kinds
    // que el caller no nombró, así que se re-fusiona a mano.
    o.restLength = { ...DEFAULT_REST, ...(opts?.restLength ?? {}) }
    this.opts = o

    const nodes = data.nodes ?? []
    const n = nodes.length
    this.count = n
    this.positions = new Float32Array(n * 3)
    this.vel = new Float64Array(n * 3)
    this.force = new Float64Array(n * 3)
    this.charge = new Float64Array(n)
    this.anchorOf = new Int32Array(n)
    this.pinned = new Uint8Array(n)

    // id → índice. PRIMERA aparición gana: si el backend repite un id, las
    // aristas tienen que resolver siempre al mismo nodo, y elegir "el último"
    // haría que el destino dependiera del orden de serialización.
    this.index = new Map<string, number>()
    for (let i = 0; i < n; i++) {
      const id = nodes[i]?.id
      if (typeof id === 'string' && !this.index.has(id)) this.index.set(id, i)
    }

    const table = folderAnchors(data, o.clusterRadius)
    this.folders = table.folders
    this.anchors = table.anchors
    for (let i = 0; i < n; i++) {
      this.anchorOf[i] = table.indexOf.get(nodes[i]?.folder ?? '') ?? 0
      const deg = Number.isFinite(nodes[i]?.degree) ? Math.max(0, nodes[i].degree) : 0
      this.charge[i] = 1 + o.chargeDegreeScale * Math.sqrt(deg)
    }

    // Posiciones iniciales: ÚNICO uso de azar en todo el motor. Nube uniforme
    // en una bola (cbrt del uniforme, si no se apiñan en la superficie),
    // centrada en el origen y NO en el ancla de cada carpeta: que los cúmulos
    // aparezcan tiene que ser obra de la física, no de la siembra.
    const rnd = mulberry32(o.seed)
    for (let i = 0; i < n; i++) {
      const theta = 2 * Math.PI * rnd()
      const z = 2 * rnd() - 1
      const r = o.initialRadius * Math.cbrt(rnd())
      const s = Math.sqrt(Math.max(0, 1 - z * z))
      this.positions[i * 3] = r * s * Math.cos(theta)
      this.positions[i * 3 + 1] = r * s * Math.sin(theta)
      this.positions[i * 3 + 2] = r * z
    }

    // Aristas aplanadas a arrays paralelos: el bucle por paso no vuelve a
    // mirar objetos ni strings. Se descartan aquí (una vez) las inválidas.
    const edges = data.edges ?? []
    const eA = new Int32Array(edges.length)
    const eB = new Int32Array(edges.length)
    const eW = new Float64Array(edges.length)
    const eR = new Float64Array(edges.length)
    let m = 0
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k]
      if (!e) continue
      const a = this.index.get(e.source)
      const b = this.index.get(e.target)
      // Arista a un id inexistente → se ignora en silencio: el grafo lo arma el
      // backend a partir de wikilinks, y un enlace roto es normal en un vault.
      if (a === undefined || b === undefined || a === b) continue
      const w = Number.isFinite(e.weight) ? e.weight : 1
      eA[m] = a
      eB[m] = b
      eW[m] = Math.min(Math.max(w, 0), o.maxEdgeWeight)
      const rest = o.restLength[e.kind]
      eR[m] = typeof rest === 'number' && Number.isFinite(rest) && rest > 0
        ? rest
        // Un `kind` que el backend añada mañana y este fichero no conozca cae
        // a la longitud de las asociaciones débiles: no deforma la estructura.
        : (DEFAULT_REST[e.kind] ?? DEFAULT_REST.mention)
      m++
    }
    this.edgeA = eA
    this.edgeB = eB
    this.edgeW = eW
    this.edgeRest = eR
    this.edgeCount = m

    this.minDist2 = o.minDist * o.minDist
    this.vmax = o.dt > 0 ? o.maxStep / o.dt : 0
    this.vmax2 = this.vmax * this.vmax
  }

  /** CERO asignaciones: solo lecturas/escrituras sobre buffers ya existentes. */
  step(iterations = 1): void {
    for (let it = 0; it < iterations; it++) this.tick()
  }

  settle(iterations = this.opts.settleIterations): number {
    this.step(iterations)
    return this.energy()
  }

  energy(): number {
    const v = this.vel
    let e = 0
    for (let i = 0; i < this.count; i++) {
      const k = i * 3
      e += v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2]
    }
    return 0.5 * e
  }

  pin(id: string, x: number, y: number, z: number): void {
    const i = this.index.get(id)
    if (i === undefined) return
    const k = i * 3
    this.pinned[i] = 1
    this.positions[k] = x
    this.positions[k + 1] = y
    this.positions[k + 2] = z
    // La velocidad se anula: si se dejara la que traía, al despinchar saldría
    // disparado con el impulso que acumuló antes de fijarse.
    this.vel[k] = 0
    this.vel[k + 1] = 0
    this.vel[k + 2] = 0
  }

  unpin(id: string): void {
    const i = this.index.get(id)
    if (i !== undefined) this.pinned[i] = 0
  }

  /** Asigna el objeto de vuelta a propósito: va al HUD / a la cámara, NO al
   *  bucle por frame, y devolver una referencia reutilizada haría que un caller
   *  que guarda el resultado viera cómo le cambia por debajo. */
  bounds(): LayoutBounds {
    const n = this.count
    const p = this.positions
    if (n === 0) return { min: [0, 0, 0], max: [0, 0, 0], radius: 0 }
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      const k = i * 3
      const x = p[k], y = p[k + 1], z = p[k + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
    let worst = 0
    for (let i = 0; i < n; i++) {
      const k = i * 3
      const dx = p[k] - cx, dy = p[k + 1] - cy, dz = p[k + 2] - cz
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 > worst) worst = d2
    }
    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      radius: Math.sqrt(worst),
    }
  }

  /* ---------------- un paso ---------------- */

  private tick(): void {
    const n = this.count
    if (n === 0) return
    const pos = this.positions
    const f = this.force
    const q = this.charge
    const o = this.opts

    f.fill(0)   // no asigna: reusa el buffer

    /* 1. Repulsión de Coulomb. UN solo recorrido de los pares (i<j) aplicando
     *    la fuerza simétrica a los dos nodos: la mitad de iteraciones que el
     *    doble bucle completo. Un único sqrt por par — inevitable, porque hace
     *    falta la DIRECCIÓN normalizada, no solo la magnitud.
     *
     *    Nota de robustez: |F| = k·q²·|d| / (dEff²·|d|) = k·q²/dEff², o sea la
     *    magnitud queda acotada por el `minDist` aunque d sea diminuto. El
     *    único caso venenoso es d EXACTAMENTE 0 (0/0 → NaN), y de eso se
     *    encarga el empujón determinista por eje. */
    const krep = o.repulsion
    const minD2 = this.minDist2
    for (let i = 0; i < n; i++) {
      const ix = i * 3
      const xi = pos[ix], yi = pos[ix + 1], zi = pos[ix + 2]
      const qi = krep * q[i]
      for (let j = i + 1; j < n; j++) {
        const jx = j * 3
        let dx = pos[jx] - xi
        let dy = pos[jx + 1] - yi
        let dz = pos[jx + 2] - zi
        let d2 = dx * dx + dy * dy + dz * dz
        if (d2 < COINCIDENT_EPS2) {
          // Dos nodos encimados (el backend puede dar posiciones idénticas si
          // alguien las escribe a mano, y dos ids distintos pueden coincidir
          // por redondeo float32). El eje se elige por (i+j)%3: determinista,
          // sin PRNG dentro del paso, y garantiza que el par se separe.
          const axis = (i + j) % 3
          dx = axis === 0 ? COINCIDENT_NUDGE : 0
          dy = axis === 1 ? COINCIDENT_NUDGE : 0
          dz = axis === 2 ? COINCIDENT_NUDGE : 0
          d2 = COINCIDENT_NUDGE * COINCIDENT_NUDGE
        }
        const dEff2 = d2 > minD2 ? d2 : minD2
        const s = (qi * q[j]) / (dEff2 * Math.sqrt(d2))
        const rx = dx * s, ry = dy * s, rz = dz * s
        f[ix] -= rx; f[ix + 1] -= ry; f[ix + 2] -= rz
        f[jx] += rx; f[jx + 1] += ry; f[jx + 2] += rz
      }
    }

    /* 2. Muelles de Hooke por arista, hacia la longitud de reposo del `kind`. */
    const kspring = o.springK
    const eA = this.edgeA, eB = this.edgeB, eW = this.edgeW, eR = this.edgeRest
    for (let k = 0; k < this.edgeCount; k++) {
      const ix = eA[k] * 3
      const jx = eB[k] * 3
      const dx = pos[jx] - pos[ix]
      const dy = pos[jx + 1] - pos[ix + 1]
      const dz = pos[jx + 2] - pos[ix + 2]
      const d2 = dx * dx + dy * dy + dz * dz
      // Extremos coincidentes: la dirección del muelle no existe. Se salta y
      // ya los separa la repulsión en este mismo paso.
      if (d2 < COINCIDENT_EPS2) continue
      const d = Math.sqrt(d2)
      const s = (kspring * eW[k] * (d - eR[k])) / d
      const ax = dx * s, ay = dy * s, az = dz * s
      f[ix] += ax; f[ix + 1] += ay; f[ix + 2] += az
      f[jx] -= ax; f[jx + 1] -= ay; f[jx + 2] -= az
    }

    /* 3+4+5+6. Ancla de carpeta, gravedad al centro, amortiguación, techo de
     *          velocidad e integración, TODO en el mismo recorrido: las dos
     *          primeras son fuerzas puramente locales, así que no hace falta
     *          un pase aparte (dos pases más sobre n nodos por frame, gratis
     *          de evitar). */
    const cs = o.clusterStrength
    const cg = o.centerGravity
    const dt = o.dt
    const damp = o.damping
    const vmax = this.vmax, vmax2 = this.vmax2
    const vel = this.vel
    const anchors = this.anchors
    const anchorOf = this.anchorOf
    const pinned = this.pinned
    for (let i = 0; i < n; i++) {
      const k = i * 3
      if (pinned[i]) {
        // Un nodo fijado no integra NADA (ni un float): sigue siendo fuente de
        // repulsión y de tensión para sus vecinos, pero su posición es dato.
        vel[k] = 0; vel[k + 1] = 0; vel[k + 2] = 0
        continue
      }
      const a = anchorOf[i] * 3
      const px = pos[k], py = pos[k + 1], pz = pos[k + 2]
      const fx = f[k] + cs * (anchors[a] - px) - cg * px
      const fy = f[k + 1] + cs * (anchors[a + 1] - py) - cg * py
      const fz = f[k + 2] + cs * (anchors[a + 2] - pz) - cg * pz

      // Euler semi-implícito: primero la velocidad con la fuerza de AHORA,
      // luego la posición con la velocidad nueva.
      let vx = (vel[k] + fx * dt) * damp
      let vy = (vel[k + 1] + fy * dt) * damp
      let vz = (vel[k + 2] + fz * dt) * damp

      // El techo se aplica a la VELOCIDAD, no solo al desplazamiento. Recortar
      // únicamente el paso dejaría una energía cinética fantasma que `energy()`
      // reportaría para siempre sin que nada se mueva — y ese número es el que
      // usa el HUD para decir si el layout convergió.
      const v2 = vx * vx + vy * vy + vz * vz
      if (v2 > vmax2) {
        const s = vmax / Math.sqrt(v2)
        vx *= s; vy *= s; vz *= s
      }
      vel[k] = vx; vel[k + 1] = vy; vel[k + 2] = vz
      pos[k] = px + vx * dt
      pos[k + 1] = py + vy * dt
      pos[k + 2] = pz + vz * dt
    }
  }
}

/** Punto de entrada del módulo. */
export function createLayout(data: GraphData, opts?: Partial<LayoutOptions>): LayoutHandle {
  return new ForceLayout(data, opts)
}
