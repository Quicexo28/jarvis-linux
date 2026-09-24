/** Renderer for `kind: 'simulation'` objects.
 *
 *  Rules that shaped this file (all of them learned the hard way on this box —
 *  see the WebKitGTK notes in CLAUDE.md):
 *
 *  · ONE WebGL context. This mounts inside the existing Model3DViewer canvas.
 *  · No allocation inside useFrame. Buffers, matrices and colors are made once
 *    and mutated; a fresh Vector3 per body per frame is measurable garbage here.
 *  · No React state per step. Positions go straight into geometry attributes;
 *    only the HUD text crosses into zustand, throttled to ~4 Hz.
 *  · Fixed simulation steps, decoupled from frame rate (FixedClock), so a
 *    dropped frame changes how MUCH is simulated, never the trajectory.
 */

import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useSimStore } from '../../state/simStore'
import { FixedClock, TrailBuffer } from '../../lib/sim/integrators'
import { NBodyEngine } from '../../lib/sim/nbody'
import { buildNBody } from '../../lib/sim/presets'
import { DynamicsEngine, buildDynamics } from '../../lib/sim/dynamics'
import { FieldEngine, buildField, type FieldSample } from '../../lib/sim/field'
import { OdeEngine, buildOde } from '../../lib/sim/ode'
import type { SimBody, SimEngine, SimulationBody, VectorOverlay } from '../../lib/sim/types'
import {
  resolveAppearance, needsOwnMesh, spinAngle, spinSlowdown,
  type BodyAppearance,
} from '../../lib/sim/appearance'
import { BlackHoleView } from './BlackHoleView'

/* ---------------- Engine construction ---------------- */

export interface SimSetup {
  engine: SimEngine
  clock: FixedClock
  trailLength: number
  title: string
  /** Extra per-system data the renderer needs. */
  nbody?: NBodyEngine
  /** The raw bodies of an orbital system, in engine order. The engine keeps
   *  only colors/radii/names, and the realistic look needs the rest (texture,
   *  obliquity, rotation period, rings). */
  bodies?: SimBody[]
  /** Unidades de simulación por segundo real. La usa `spinSlowdown` para que
   *  la rotación propia sea visible en vez de un estroboscopio. */
  timeScale: number
  dynamics?: DynamicsEngine
  field?: FieldEngine
  ode?: OdeEngine
}

export function createSim(spec: SimulationBody): SimSetup {
  switch (spec.system) {
    case 'dynamics': {
      const build = buildDynamics(spec)
      const engine = new DynamicsEngine(build)
      return {
        engine, dynamics: engine, trailLength: build.trail, title: build.title,
        timeScale: build.timeScale,
        clock: new FixedClock(build.dt, build.timeScale),
      }
    }
    case 'field': {
      const build = buildField(spec)
      const engine = new FieldEngine(build)
      return {
        engine, field: engine, trailLength: build.trail, title: build.title,
        timeScale: build.timeScale,
        clock: new FixedClock(build.dt, build.timeScale),
      }
    }
    case 'ode': {
      const build = buildOde(spec)
      const engine = new OdeEngine(build)
      return {
        engine, ode: engine, trailLength: build.trail, title: build.title,
        timeScale: build.timeScale,
        clock: new FixedClock(build.dt, build.timeScale),
      }
    }
    case 'nbody':
    default: {
      const build = buildNBody(spec as never)
      const engine = new NBodyEngine(build)
      return {
        engine, nbody: engine, trailLength: build.trail, bodies: build.bodies,
        title: build.title ?? 'Simulación', timeScale: build.timeScale,
        clock: new FixedClock(build.dt, build.timeScale),
      }
    }
  }
}

/* ---------------- Apariencia realista ---------------- */

/** Caché de texturas a nivel de MÓDULO, compartida entre montajes.
 *
 *  El visor se abre y se cierra muchas veces en una sesión. Un `TextureLoader`
 *  por cuerpo y por montaje sube la misma imagen a la GPU una y otra vez, y
 *  como estas texturas NO se destruyen en el cleanup (son compartidas), cada
 *  reapertura dejaría un duplicado huérfano dentro del único contexto WebGL
 *  que tenemos. Una sola copia por ruta, viva mientras viva la página. */
const textureCache = new Map<string, THREE.Texture>()
const textureLoader = new THREE.TextureLoader()

function loadTexture(path: string, srgb = true): THREE.Texture {
  const hit = textureCache.get(path)
  if (hit) return hit
  // Ruta RELATIVA: vite construye con `base: './'`, igual que hace el cargador
  // del modelo de gestos. Una barra inicial rompe la build empaquetada.
  const tex = textureLoader.load(path.replace(/^\//, ''))
  // Sin sRGB los planetas salen lavados: la textura es color, no datos.
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  textureCache.set(path, tex)
  return tex
}

/** Esfera con los POLOS EN Z.
 *
 *  `SphereGeometry` de three pone sus polos en ±Y, pero aquí se trabaja en
 *  coordenadas matemáticas (z arriba) y el eje de giro de un planeta es su z.
 *  Sin esta rotación de π/2 la textura sale tumbada y el planeta gira sobre un
 *  eje que atraviesa su ecuador. Se rota la GEOMETRÍA una vez, compartida,
 *  para no gastar una rotación de nodo por cuerpo. */
const SPHERE_Z_UP = (() => {
  const g = new THREE.SphereGeometry(1, 48, 32)
  g.rotateX(Math.PI / 2)
  return g
})()

/** Anillo con la UV reescrita para que `u` sea el RADIO normalizado.
 *
 *  Las UV que trae `RingGeometry` recorren un cuadrado, así que una textura de
 *  anillo —que es un perfil radial: un degradado de una dimensión con el hueco
 *  de Cassini dentro— sale retorcida y el hueco no aparece donde toca. Hay que
 *  reescribir el atributo: u = (r − interior)/(exterior − interior). */
function makeRingGeometry(inner: number, outer: number): THREE.RingGeometry {
  const geo = new THREE.RingGeometry(inner, outer, 96, 1)
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  const span = outer - inner || 1
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i))
    uv.setXY(i, (r - inner) / span, 0.5)
  }
  uv.needsUpdate = true
  return geo
}

/** Un cuerpo que salió del InstancedMesh y tiene malla propia. */
interface RealBody {
  index: number
  /** Se posiciona cada frame; lleva dentro la inclinación y el giro. */
  group: THREE.Group
  /** El nodo que gira sobre el eje ya inclinado. */
  spin: THREE.Object3D
  /** Capa de nubes: gira un poco más rápido que el suelo, como el viento. */
  clouds: THREE.Object3D | null
  period: number
  tilt: number
  emissive: boolean
}

/** Construye las mallas propias de los cuerpos texturizados o emisivos.
 *
 *  Los demás se quedan en el `InstancedMesh`: cada textura es un material
 *  distinto, así que texturizar obliga a una draw call por cuerpo. En el
 *  sistema solar eso son 10 mallas — nada. Aplicado a las 1000 partículas de
 *  un `dynamics` sería el fin del frame rate, y por eso `needsOwnMesh` decide
 *  por cuerpo y no por escena. */
function buildRealBodies(
  bodies: SimBody[], looks: BodyAppearance[], radii: number[], colors: string[],
  castShadows: boolean,
): RealBody[] {
  const out: RealBody[] = []
  bodies.forEach((_body, index) => {
    const look = looks[index]
    if (!look || !needsOwnMesh(look)) return
    const r = radii[index] ?? 0.08

    const group = new THREE.Group()
    const tiltNode = new THREE.Group()
    // La inclinación se aplica UNA vez: es una propiedad del cuerpo, no del
    // frame. Dentro de este nodo, el eje local z ya es el eje de giro real.
    tiltNode.rotation.x = (look.tilt * Math.PI) / 180
    const spin = new THREE.Group()

    const mat = makeBodyMaterial(look, colors[index], castShadows)
    const mesh = new THREE.Mesh(SPHERE_Z_UP, mat)
    mesh.scale.setScalar(r)
    if (castShadows && !look.emissive) { mesh.castShadow = true; mesh.receiveShadow = true }
    spin.add(mesh)

    let clouds: THREE.Object3D | null = null
    if (look.clouds) {
      const cm = new THREE.MeshStandardMaterial({
        map: loadTexture(look.clouds),
        transparent: true, opacity: 0.55, depthWrite: false,
      })
      const cloudMesh = new THREE.Mesh(SPHERE_Z_UP, cm)
      cloudMesh.scale.setScalar(r * 1.015)
      clouds = new THREE.Group()
      clouds.add(cloudMesh)
      tiltNode.add(clouds)
    }

    if (look.rings) {
      // Radios en RADIOS DEL CUERPO, no en unidades de escena.
      const ring = new THREE.Mesh(
        makeRingGeometry(look.rings.inner * r, look.rings.outer * r),
        new THREE.MeshBasicMaterial({
          map: look.rings.texture ? loadTexture(look.rings.texture) : undefined,
          color: look.rings.texture ? '#ffffff' : '#c8b48a',
          transparent: true, opacity: 0.9,
          side: THREE.DoubleSide,
          // Sin esto los anillos se tapan a sí mismos por el lado lejano: son
          // translúcidos y escribir profundidad descarta lo que hay detrás.
          depthWrite: false,
        }),
      )
      ring.rotation.x = ((look.rings.tilt ?? 0) * Math.PI) / 180
      if (castShadows) ring.receiveShadow = true
      // Al nodo INCLINADO, no al que gira: el anillo vive en el ecuador del
      // planeta y no acompaña su rotación (son partículas en órbita propia).
      tiltNode.add(ring)
    }

    tiltNode.add(spin)
    group.add(tiltNode)
    out.push({
      index, group, spin, clouds,
      period: look.rotationPeriod, tilt: look.tilt, emissive: look.emissive,
    })
  })
  return out
}

function makeBodyMaterial(
  look: BodyAppearance, color: string, castShadows: boolean,
): THREE.Material {
  if (look.emissive) {
    // Una estrella no RECIBE luz: se emite a sí misma. Con `meshStandard` el
    // Sol saldría iluminado por su propia pointLight desde dentro, o sea
    // negro. (Y sólido emisivo clipa a blanco: por eso `basic` + la textura.)
    return new THREE.MeshBasicMaterial({
      map: look.texture ? loadTexture(look.texture) : undefined,
      color: look.texture ? '#ffffff' : color,
      toneMapped: true,
    })
  }
  const mat = new THREE.MeshStandardMaterial({
    map: look.texture ? loadTexture(look.texture) : undefined,
    color: look.texture ? '#ffffff' : color,
    roughness: 0.9, metalness: 0,
  })
  if (look.night) {
    // Luces de ciudad en el lado nocturno. `emissiveMap` se suma DESPUÉS de la
    // iluminación, así que aparece justo donde no llega la luz de la estrella
    // — el terminador día/noche sale gratis, sin shader propio.
    mat.emissiveMap = loadTexture(look.night)
    mat.emissive = new THREE.Color('#ffffff')
    mat.emissiveIntensity = 0.9
  }
  void castShadows
  return mat
}

/** Enciende el mapa de sombras del renderer mientras esta escena vive.
 *
 *  `castShadow` en una luz no hace NADA si el renderer tiene las sombras
 *  apagadas, y el visor las trae apagadas porque las figuras abstractas no las
 *  usan. Se restaura el valor anterior al desmontar: dejarlo encendido cobraría
 *  un paso de render extra a todas las demás vistas para siempre. */
function ShadowMapToggle({ enabled }: { enabled: boolean }) {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    if (!enabled) return
    const before = gl.shadowMap.enabled
    const beforeType = gl.shadowMap.type
    gl.shadowMap.enabled = true
    gl.shadowMap.type = THREE.PCFSoftShadowMap
    return () => { gl.shadowMap.enabled = before; gl.shadowMap.type = beforeType }
  }, [gl, enabled])
  return null
}

/** Cuántos cuerpos admiten sombras proyectadas.
 *
 *  Una `pointLight` con sombras cuesta un mapa CÚBICO: seis renders de la
 *  escena por luz y por frame. En esta iGPU el sistema solar completo con
 *  sombras es un tirón permanente, mientras que Tierra-Luna (el caso donde la
 *  sombra SIGNIFICA algo: el eclipse) va sobrado. */
const SHADOW_BODY_LIMIT = 12

/* ---------------- Reusable primitives ---------------- */

/** A polyline whose vertex count changes every frame (trails). */
function makeLine(capacity: number, color: string, opacity = 0.7): THREE.Line {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3))
  geo.setDrawRange(0, 0)
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity })
  return new THREE.Line(geo, mat)
}

/** A polyline that never changes (orbits, streamlines, light rays).
 *
 *  Con `magnitudes` la línea se colorea POR VÉRTICE con la misma rampa que las
 *  flechas: una línea de campo de color plano dice por dónde va el campo pero
 *  no cuánto vale, y en un dipolo eso son dos órdenes de magnitud de diferencia
 *  entre el centro y el borde. `max` es el máximo GLOBAL del campo, para que
 *  todas las líneas compartan escala. */
function makeStaticLine(
  points: Float32Array, color: string, opacity = 0.35,
  magnitudes?: Float32Array, max = 1,
): THREE.Line {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(points, 3))
  if (magnitudes && magnitudes.length) {
    const cols = new Float32Array(magnitudes.length * 3)
    const c = new THREE.Color()
    for (let i = 0; i < magnitudes.length; i++) {
      fieldRamp(c, max > 1e-9 ? Math.min(1, magnitudes[i] / max) : 0)
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3))
    return new THREE.Line(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: Math.min(1, opacity * 2),
    }))
  }
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }))
}

/** Rampa de color de intensidad de campo, compartida por flechas y líneas.
 *  Estaba escrita a mano dentro del bucle de flechas; con dos consumidores,
 *  duplicarla garantizaba que un día dejaran de decir lo mismo. */
function fieldRamp(out: THREE.Color, unit: number): THREE.Color {
  return out.setHSL(0.58 - 0.5 * unit, 0.85, 0.35 + 0.3 * unit)
}

const UP = new THREE.Vector3(0, 1, 0)

/** Instanced arrow set: thin shafts as line segments, cone heads as instances.
 *  One draw call each, so a 1700-arrow field costs two draws, not 1700. */
class ArrowSet {
  readonly group = new THREE.Group()
  private readonly segments: THREE.LineSegments
  private readonly heads: THREE.InstancedMesh
  private readonly posAttr: THREE.BufferAttribute
  private readonly colAttr: THREE.BufferAttribute
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly dir = new THREE.Vector3()
  private readonly pos = new THREE.Vector3()
  private readonly scl = new THREE.Vector3()
  private readonly color = new THREE.Color()

  constructor(readonly capacity: number, headSize = 0.06) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 6), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 6), 3))
    this.posAttr = geo.getAttribute('position') as THREE.BufferAttribute
    this.colAttr = geo.getAttribute('color') as THREE.BufferAttribute
    this.segments = new THREE.LineSegments(
      geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    )
    const cone = new THREE.ConeGeometry(headSize, headSize * 2.4, 7)
    this.heads = new THREE.InstancedMesh(
      cone, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }), capacity,
    )
    this.heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.group.add(this.segments, this.heads)
  }

  /** Arrows written since the last begin(). */
  private n = 0

  /** Starts a rewrite of the whole set. */
  begin() { this.n = 0 }

  add(ox: number, oy: number, oz: number, vx: number, vy: number, vz: number, color: THREE.ColorRepresentation) {
    if (this.n >= this.capacity) return
    const i = this.n++
    const c = this.color.set(color)
    const p = this.posAttr.array as Float32Array
    const col = this.colAttr.array as Float32Array
    const k = i * 6
    p[k] = ox; p[k + 1] = oy; p[k + 2] = oz
    p[k + 3] = ox + vx; p[k + 4] = oy + vy; p[k + 5] = oz + vz
    for (const off of [0, 3]) {
      col[k + off] = c.r; col[k + off + 1] = c.g; col[k + off + 2] = c.b
    }
    const len = Math.hypot(vx, vy, vz)
    if (len > 1e-6) {
      this.dir.set(vx / len, vy / len, vz / len)
      this.q.setFromUnitVectors(UP, this.dir)
      this.pos.set(ox + vx, oy + vy, oz + vz)
      this.scl.setScalar(1)
      this.m.compose(this.pos, this.q, this.scl)
    } else {
      this.m.makeScale(0, 0, 0)
    }
    this.heads.setMatrixAt(i, this.m)
    this.heads.setColorAt(i, c)
  }

  end() {
    this.segments.geometry.setDrawRange(0, this.n * 2)
    this.posAttr.needsUpdate = true
    this.colAttr.needsUpdate = true
    this.heads.count = this.n
    this.heads.instanceMatrix.needsUpdate = true
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true
  }

  dispose() {
    this.segments.geometry.dispose()
    ;(this.segments.material as THREE.Material).dispose()
    this.heads.geometry.dispose()
    ;(this.heads.material as THREE.Material).dispose()
  }
}

/* ---------------- Main component ---------------- */

const HUD_INTERVAL_MS = 250

export function SimulationObject({ spec }: { spec: SimulationBody }) {
  if (spec.system === 'blackhole') return <BlackHoleView spec={spec} />
  return <IntegratedSim spec={spec} />
}

function IntegratedSim({ spec }: { spec: SimulationBody }) {
  const setReadout = useSimStore((s) => s.setReadout)
  const setActive = useSimStore((s) => s.setActive)

  // The engine is rebuilt only when the spec identity changes — never per frame.
  const setup = useMemo(() => createSim(spec), [spec])
  const { engine, clock, trailLength } = setup

  const trails = useMemo(
    () => (trailLength > 0 ? new TrailBuffer(engine.bodyCount, trailLength) : null),
    [engine, trailLength],
  )

  const bodiesRef = useRef<THREE.InstancedMesh>(null)

  // Look realista: por defecto SÍ. Un sistema solar de esferas planas no se
  // parece a nada; `realistic: false` recupera el modo esquemático de antes.
  const realistic = spec.realistic !== false

  // La apariencia se resuelve UNA vez: la necesitan tanto la decisión sobre
  // sombras como la construcción de las mallas, y resolverla dos veces dejaría
  // las dos a merced de que sigan coincidiendo.
  const looks = useMemo(
    () => setup.bodies?.map((b) => resolveAppearance(b, b.name)) ?? [],
    [setup],
  )
  const hasStar = looks.some((l) => l.emissive)
  const hasMeshes = looks.some(needsOwnMesh)

  // Sin mallas propias no hay nada que proyecte sombra, y encender el mapa
  // cuesta un paso de render por frame para no dibujar nada — el caso de un
  // `dynamics` de pocas partículas, que pasa el límite de cuerpos y no tiene
  // ni estrella ni cuerpos texturizados.
  const shadows = realistic && hasMeshes
    && (spec.shadows ?? engine.bodyCount <= SHADOW_BODY_LIMIT)
    && engine.bodyCount <= SHADOW_BODY_LIMIT

  /** Radio aproximado de la escena, para encuadrar la cámara de sombra. */
  const sceneSpan = useMemo(() => {
    let max = 1
    for (const r of engine.radii) if (r > max) max = r
    return Math.max(4, max * 12)
  }, [engine])

  const realBodies = useMemo(
    () => (realistic && setup.bodies
      ? buildRealBodies(setup.bodies, looks, engine.radii, engine.colors, shadows)
      : []),
    [realistic, setup, looks, engine, shadows],
  )
  /** Cuerpos que ya NO deben pintarse en el InstancedMesh (tienen malla). */
  const ownMesh = useMemo(() => {
    const flags = new Uint8Array(engine.bodyCount)
    for (const b of realBodies) flags[b.index] = 1
    return flags
  }, [realBodies, engine])

  /** Factor único que alarga TODOS los periodos de rotación por igual, para
   *  que el giro se vea sin romper las razones entre cuerpos. */
  const spinFactor = useMemo(
    () => spinSlowdown(realBodies.map((b) => b.period), setup.timeScale),
    [realBodies, setup],
  )

  const lastHud = useRef(0)
  const lastReset = useRef(useSimStore.getState().resetToken)
  const scratch = useMemo(
    () => ({
      m: new THREE.Matrix4(),
      v: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      s: new THREE.Vector3(),
      trail: new Float32Array(Math.max(1, trailLength) * 3),
      overlay: new Float32Array(Math.max(1, engine.bodyCount) * 3),
    }),
    [trailLength, engine],
  )

  // Trail lines, one per body.
  const trailLines = useMemo(() => {
    if (!trails) return []
    return Array.from({ length: engine.bodyCount }, (_, i) =>
      makeLine(trailLength, engine.colors[i], 0.55))
  }, [trails, engine, trailLength])

  // Static overlays: orbit ellipses (nbody) and streamlines (field).
  const staticLines = useMemo(() => {
    const out: THREE.Line[] = []
    if (setup.nbody) {
      for (const p of setup.nbody.orbitPaths()) {
        if (p) out.push(makeStaticLine(p.points, p.color, 0.28))
      }
    }
    if (setup.field) {
      const max = setup.field.sample().maxMagnitude
      for (const line of setup.field.streamlines()) {
        if (line.length < 6) continue
        out.push(makeStaticLine(
          line, '#4a7fa8', 0.4, setup.field.streamlineMagnitudes(line), max,
        ))
      }
    }
    return out
  }, [setup])

  // Live arrows: per-body vectors (dynamics) or the field lattice.
  const arrows = useMemo(() => {
    if (setup.dynamics) {
      const overlays = setup.dynamics.overlays.length || 1
      return new ArrowSet(engine.bodyCount * overlays, 0.07)
    }
    if (setup.field) return new ArrowSet(setup.field.sample().magnitudes.length, 0.05)
    return null
  }, [setup, engine])

  // Chain rods (double pendulum and friends).
  const chains = useMemo(() => {
    const nodes = setup.ode?.build.chain.length ?? 0
    if (!nodes) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(engine.bodyCount * nodes * 2 * 3), 3))
    return new THREE.LineSegments(
      geo, new THREE.LineBasicMaterial({ color: '#8fb8cc', transparent: true, opacity: 0.75 }),
    )
  }, [setup, engine])

  useEffect(() => {
    setActive(true, setup.title)
    return () => setActive(false)
  }, [setup, setActive])

  // Dispose GPU resources on unmount: the viewer can be reopened many times in
  // one session and leaked geometries add up inside a single WebGL context.
  useEffect(() => () => {
    for (const l of trailLines) { l.geometry.dispose(); (l.material as THREE.Material).dispose() }
    for (const l of staticLines) { l.geometry.dispose(); (l.material as THREE.Material).dispose() }
    arrows?.dispose()
    chains?.geometry.dispose()
    // Las texturas NO se destruyen: están cacheadas a nivel de módulo y las
    // comparte el siguiente montaje. Sí los materiales y las geometrías de
    // anillo, que son propios de esta escena. `SPHERE_Z_UP` también se
    // comparte, así que tampoco se toca.
    for (const b of realBodies) {
      b.group.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        if (m.geometry !== SPHERE_Z_UP) m.geometry.dispose()
        const mat = m.material as THREE.Material | THREE.Material[]
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else mat.dispose()
      })
    }
  }, [trailLines, staticLines, arrows, chains, realBodies])

  // Static field arrows are written once; time-dependent ones every frame.
  const fieldSampleRef = useRef<FieldSample | null>(null)

  useFrame((_state, delta) => {
    const { playing, speed, resetToken } = useSimStore.getState()

    if (resetToken !== lastReset.current) {
      lastReset.current = resetToken
      engine.reset()
      clock.reset()
      trails?.clear()
    }

    if (playing) {
      // `speed` scales real elapsed time, never the fixed step: the trajectory
      // stays identical whether you watch it at 0.1× or 30×.
      const steps = clock.pending(delta * speed)
      for (let i = 0; i < steps; i++) engine.step()
    }

    const frame = engine.frame()
    const pos = frame.positions

    // Bodies.
    const mesh = bodiesRef.current
    if (mesh) {
      for (let i = 0; i < engine.bodyCount; i++) {
        const k = i * 3
        scratch.v.set(pos[k], pos[k + 1], pos[k + 2])
        // Escala 0 = invisible. Un cuerpo con malla propia sigue ocupando su
        // hueco en el buffer de instancias (los índices los comparte con el
        // motor y con las estelas), así que se esconde, no se elimina.
        scratch.s.setScalar(ownMesh[i] ? 0 : engine.radii[i])
        scratch.m.compose(scratch.v, scratch.q, scratch.s)
        mesh.setMatrixAt(i, scratch.m)
      }
      mesh.instanceMatrix.needsUpdate = true
    }

    // Mallas propias: posición del motor, giro propio sobre el eje inclinado.
    for (let i = 0; i < realBodies.length; i++) {
      const b = realBodies[i]
      const k = b.index * 3
      b.group.position.set(pos[k], pos[k + 1], pos[k + 2])
      if (b.period) {
        const a = spinAngle(frame.t, b.period * spinFactor, b.tilt)
        b.spin.rotation.z = a
        // Las nubes adelantan un 8% al suelo: es lo que hace que la atmósfera
        // se lea como atmósfera y no como una calcomanía pegada al planeta.
        if (b.clouds) b.clouds.rotation.z = a * 1.08
      }
    }

    // Trails.
    if (trails && playing) {
      for (let i = 0; i < engine.bodyCount; i++) {
        const k = i * 3
        trails.push(i, pos[k], pos[k + 1], pos[k + 2])
      }
      for (let i = 0; i < trailLines.length; i++) {
        const n = trails.ordered(i, scratch.trail)
        const attr = trailLines[i].geometry.getAttribute('position') as THREE.BufferAttribute
        ;(attr.array as Float32Array).set(scratch.trail.subarray(0, n * 3))
        attr.needsUpdate = true
        trailLines[i].geometry.setDrawRange(0, n)
      }
    }

    // Vector overlays.
    if (arrows && setup.dynamics) {
      const d = setup.dynamics
      const vScale = d.build.spec.vectorScale ?? autoVectorScale(frame.velocities)
      arrows.begin()
      for (let i = 0; i < engine.bodyCount; i++) {
        const k = i * 3
        for (const kind of d.overlays) {
          const src = pickOverlay(kind, frame.velocities, frame.accelerations, d.masses[i], scratch.overlay)
          if (!src) continue
          arrows.add(
            pos[k], pos[k + 1], pos[k + 2],
            src[k] * vScale, src[k + 1] * vScale, src[k + 2] * vScale,
            OVERLAY_COLORS[kind],
          )
        }
      }
      arrows.end()
    } else if (arrows && setup.field) {
      const build = setup.field.build
      if (!fieldSampleRef.current || build.timeDependent) {
        fieldSampleRef.current = setup.field.sample()
      }
      const s = fieldSampleRef.current
      const norm = (build.extent / build.density) * 1.7
      arrows.begin()
      const col = new THREE.Color()
      for (let i = 0; i < s.magnitudes.length; i++) {
        const k = i * 3
        const mag = s.magnitudes[i]
        const unit = mag > 1e-9 ? Math.min(1, mag / s.maxMagnitude) : 0
        // Arrow LENGTH is compressed (sqrt) so a 1/r² field stays readable
        // near its singularity; magnitude is carried by COLOUR instead.
        const len = norm * Math.sqrt(unit)
        const f = mag > 1e-9 ? len / mag : 0
        fieldRamp(col, unit)
        arrows.add(
          s.origins[k] * build.viewScale, s.origins[k + 1] * build.viewScale, s.origins[k + 2] * build.viewScale,
          s.vectors[k] * f, s.vectors[k + 1] * f, s.vectors[k + 2] * f,
          build.colorByMagnitude ? col : '#38d5ff',
        )
      }
      arrows.end()
    }

    // Chain rods.
    if (chains && setup.ode) {
      const nodes = setup.ode.build.chain.length
      const cp = setup.ode.chainPos
      const attr = chains.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = attr.array as Float32Array
      let w = 0
      for (let i = 0; i < engine.bodyCount; i++) {
        let px = 0, py = 0, pz = 0   // pivot at the origin
        for (let c = 0; c < nodes; c++) {
          const k = (i * nodes + c) * 3
          arr[w++] = px; arr[w++] = py; arr[w++] = pz
          arr[w++] = cp[k]; arr[w++] = cp[k + 1]; arr[w++] = cp[k + 2]
          px = cp[k]; py = cp[k + 1]; pz = cp[k + 2]
        }
      }
      attr.needsUpdate = true
      chains.geometry.setDrawRange(0, w / 3)
    }

    // HUD, throttled — this is the only path that touches React.
    const now = performance.now()
    if (now - lastHud.current > HUD_INTERVAL_MS) {
      lastHud.current = now
      setReadout(frame.readout ?? [])
    }
  })

  return (
    <group>
      {/* Solo si hay cuerpos que instanciar. Un `Math.max(1, ...)` reservaría
          una instancia igualmente y su matriz se quedaría en IDENTIDAD: una
          esfera de radio 1 plantada en el origen. Es el mismo fallo que dejaba
          una bola blanca tapando el agujero negro. */}
      {engine.bodyCount > 0 && (
        <instancedMesh
          ref={bodiesRef}
          args={[undefined, undefined, engine.bodyCount]}
          frustumCulled={false}
        >
          <sphereGeometry args={[1, 16, 12]} />
          <meshStandardMaterial roughness={0.55} metalness={0.15} />
        </instancedMesh>
      )}
      <BodyColors mesh={bodiesRef} colors={engine.colors} />
      {trailLines.map((l, i) => <primitive key={`t${i}`} object={l} />)}
      {staticLines.map((l, i) => <primitive key={`s${i}`} object={l} />)}
      {arrows && <primitive object={arrows.group} />}
      {chains && <primitive object={chains} />}
      {realBodies.map((b) => <primitive key={`b${b.index}`} object={b.group} />)}
      <ShadowMapToggle enabled={shadows} />
      {/* La luz va DENTRO del grupo de cada estrella, no clavada en el origen:
          en un sistema binario las dos estrellas se mueven, y una luz fija en
          (0,0,0) iluminaría desde un punto donde no hay nada. */}
      {realBodies.filter((b) => b.emissive).slice(0, MAX_SHADOW_LIGHTS).map((b) => (
        <StarLight key={`l${b.index}`} target={b.group} shadows={shadows} />
      ))}
      {/* Un sistema SIN estrella propia (`earth-moon`, `jupiter-moons`) no puede
          iluminarse desde el origen: ahí está el baricentro, o sea DENTRO del
          cuerpo principal — la Tierra saldría alumbrada desde su propio centro
          y la sombra que produce un eclipse no existiría. El modelo correcto es
          una luz DIRECCIONAL: a 1 UA los rayos del Sol son paralelos sobre un
          sistema de 384 000 km. Y su sombra es un mapa plano en vez de cúbico,
          así que además es seis veces más barata que la de una pointLight. */}
      {setup.nbody && realistic && !hasStar && hasMeshes && (
        <SunlightBeam distance={sceneSpan} shadows={shadows} />
      )}
      {/* Modo esquemático: la luz de siempre, sin tocar. */}
      {setup.nbody && !realistic && (
        <pointLight position={[0, 0, 0]} intensity={2.2} distance={0} color="#fff2d0" />
      )}
    </group>
  )
}

/** Luz solar paralela para sistemas que no llevan su estrella dentro.
 *
 *  La cámara de sombra de una direccional es ORTOGRÁFICA y no tiene tamaño por
 *  defecto útil: hay que encuadrarla sobre la escena o la sombra se recorta a
 *  un cuadrado de 10 unidades y el eclipse desaparece justo cuando los cuerpos
 *  se separan. Se dimensiona con la extensión real de la simulación. */
function SunlightBeam({ distance, shadows }: { distance: number; shadows: boolean }) {
  const light = useMemo(() => new THREE.DirectionalLight('#fff4de', 2.6), [])
  useEffect(() => {
    // Desde +x y un poco elevada: rasante da sombras largas y legibles, y el
    // plano orbital (xy en coordenadas matemáticas) queda bien iluminado.
    light.position.set(distance * 3, 0, distance * 0.35)
    light.castShadow = shadows
    if (shadows) {
      const c = light.shadow.camera
      c.left = -distance; c.right = distance
      c.top = distance; c.bottom = -distance
      c.near = 0.1; c.far = distance * 8
      c.updateProjectionMatrix()
      light.shadow.mapSize.set(2048, 2048)
      // Sesgo NEGATIVO y pequeño: con el positivo por defecto la sombra se
      // despega del cuerpo y la umbra se parte en bandas.
      light.shadow.bias = -0.0008
    }
  }, [light, distance, shadows])
  return <primitive object={light} />
}

/** Tope de luces con sombra. Cada una cuesta un mapa CÚBICO — seis renders de
 *  la escena por frame —, así que un sistema con cinco estrellas las apagaría
 *  todas sin este límite. */
const MAX_SHADOW_LIGHTS = 2

/** Luz de una estrella, montada dentro del grupo del cuerpo para que viaje
 *  con él. */
function StarLight({ target, shadows }: { target: THREE.Group; shadows: boolean }) {
  const light = useMemo(() => {
    const l = new THREE.PointLight('#fff4de', 3.2)
    // `decay = 0` a propósito, y esto NO es un descuido físico. Las distancias
    // de la escena no son las reales: el preset `solar` COMPRIME los radios en
    // logaritmo para que el sistema interior no quede en cuatro píxeles. Una
    // caída con el cuadrado sobre distancias falsas no produce el brillo real,
    // produce un número sin significado — y en la práctica dejaba Neptuno
    // completamente negro. Iluminación uniforme desde la dirección de la
    // estrella es lo que hace un planetario, y es lo honesto aquí.
    l.decay = 0
    l.distance = 0
    return l
  }, [])

  useEffect(() => {
    light.castShadow = shadows
    if (shadows) {
      light.shadow.mapSize.set(1024, 1024)
      // El `far` por defecto de la cámara de sombra no llega a los planetas
      // exteriores, y una sombra que no alcanza al objeto no se dibuja: la
      // Luna nunca entraría en el cono de la Tierra.
      light.shadow.camera.near = 0.05
      light.shadow.camera.far = 200
      light.shadow.bias = -0.0015
    }
  }, [light, shadows])

  useEffect(() => {
    target.add(light)
    return () => { target.remove(light); light.dispose() }
  }, [target, light])

  return null
}

/** Writes per-instance colours once the mesh exists. */
function BodyColors({ mesh, colors }: {
  mesh: React.RefObject<THREE.InstancedMesh | null>; colors: string[]
}) {
  useEffect(() => {
    const m = mesh.current
    if (!m) return
    const c = new THREE.Color()
    for (let i = 0; i < colors.length; i++) m.setColorAt(i, c.set(colors[i]))
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [mesh, colors])
  return null
}

const OVERLAY_COLORS: Record<VectorOverlay, string> = {
  velocity: '#7cff6b',
  acceleration: '#ff8a80',
  force: '#ffd700',
  momentum: '#c8a4ff',
}

function pickOverlay(
  kind: VectorOverlay, vel: Float32Array | undefined, acc: Float32Array | undefined,
  mass: number, scratch: Float32Array,
): Float32Array | null {
  if (kind === 'velocity') return vel ?? null
  if (kind === 'acceleration') return acc ?? null
  // F = ma and p = mv differ from a and v only by the mass factor, so scaling
  // by m is what makes the arrows comparable ACROSS particles of different mass.
  const src = kind === 'force' ? acc : vel
  if (!src) return null
  if (mass === 1) return src
  const n = Math.min(src.length, scratch.length)
  for (let i = 0; i < n; i++) scratch[i] = src[i] * mass
  return scratch
}

/** Picks an arrow scale so the longest vector is a readable fraction of the
 *  scene rather than a screen-crossing spike. */
function autoVectorScale(vel?: Float32Array): number {
  if (!vel || !vel.length) return 1
  let max = 0
  for (let i = 0; i < vel.length; i += 3) {
    const m = Math.hypot(vel[i], vel[i + 1], vel[i + 2])
    if (m > max) max = m
  }
  return max > 1e-9 ? 1.2 / max : 1
}
