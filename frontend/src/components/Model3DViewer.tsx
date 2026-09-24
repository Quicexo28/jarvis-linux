/**
 * Model3DViewer — full-screen overlay rendering a multi-object 3D scene.
 * Driven by model3dStore (same pattern as DisplayCard).
 *
 * Objects (each with position/rotation/scale/color/opacity): parametric
 * surfaces, N-D polytopes (auto-rotating, w-colored, translucent 2-faces),
 * implicit isosurfaces, exact primitives (sphere/box/cylinder/cone/torus),
 * parametric curves, function graphs y=f(x) / z=f(x,y), n-D vectors (+span),
 * analytic planes and lines. Optional labeled axes + reference grid.
 *
 * Everything renders inside a math frame (z up); specs use math coordinates.
 * Gestures: pinch = zoom (dolly), grab = multi-axis rotate of the whole scene
 * (roll=Z, horizontal=Y, vertical=X), 1:1 angular, persists on release.
 */

import React, { Component, useRef, useMemo, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useGestureStore } from '../state/gestureStore'
import { create, all } from 'mathjs'
import {
  useModel3dStore,
  type Model3DSpec, type SceneOptions,
  type ParametricSpec, type PolytopeSpec, type ImplicitSpec, type PrimitiveSpec,
  type CurveSpec, type GraphSpec, type VectorsSpec, type PlaneSpec, type LineSpec,
  type PolygonSpec, type SimulationSpec,
} from '../state/model3dStore'
import { SimulationObject } from './sim/SimulationObject'
import { resolveSceneLook } from '../lib/sim/scene'
import { useSimStore, SIM_SPEEDS } from '../state/simStore'
import { evaluateParametricSurface } from '../lib/geometry/parametricMath'
import { buildHypercube, buildCross, buildHypercubeFaces, rotateInPlane, projectToR3 } from '../lib/geometry/polytopeMath'
import { marchingCubes } from '../lib/geometry/implicitMath'
import { brillouinZonePlanes } from '../lib/geometry/brillouinZone'
import {
  freeSymbols, sampleCurve3D, sampleGraph1D, sampleSurface,
  planeBasis, spanLatticeLines, vectorsToR3, bestFitPlane,
} from '../lib/geometry/analyticMath'

const mathImplicit = create(all)

// Rotación por ORIENTACIÓN del puño, 1:1: el giro de la figura corresponde al
// giro real de la mano ("como si la cogieras y la giraras con la mano"). Para
// más de ±60-80° (límite de muñeca): soltar, re-agarrar y seguir (ratchet).
const ROT_GAIN = 1.0
// Sentido de giro por eje (verificado con la mano, 07-23). Cada uno es un flip
// de una línea si alguno vuelve a sentirse al revés.
const ROT_SIGN_YAW = -1    // eje VERTICAL: girar la palma izq/der
const ROT_SIGN_PITCH = 1   // eje horizontal: subir/bajar la mano (ver abajo)
const ROT_SIGN_ROLL = 1    // roll de la muñeca (como un volante)
/** El pitch NO sale del ángulo de la muñeca sino del DESPLAZAMIENTO vertical de
 * la mano (pedido del usuario: inclinar los nudillos arriba/abajo era incómodo
 * y el rango útil de la muñeca es pequeño). deltaY viene normalizado por el
 * tamaño de palma (~±0.3 de recorrido cómodo) → 5.0 rad/unidad ≈ 85° de figura
 * por recorrido completo. Convención: deltaY>0 = mano ABAJO. */
const PITCH_DRAG_GAIN = 5.0
/** Suavizado exponencial POR TIEMPO (no por frame): alpha = 1 − e^(−dt/τ). Con
 * la inferencia a ~20 fps y el render a 60, esto interpola entre muestras — el
 * movimiento se ve continuo sin añadir el lag de un EMA por-frame fijo (que
 * además cambiaba de comportamiento según los fps). τ pequeño = más ceñido. */
const SMOOTH_TAU_MS = 45
/** El zoom tolera más suavizado que el giro (gesto lento) y así no tiembla. */
const ZOOM_TAU_MS = 110
const BASE_CAM_DIST = 12

/** Coeficiente de EMA independiente del framerate. */
function tauAlpha(dtSec: number, tauMs: number): number {
  return 1 - Math.exp(-(dtSec * 1000) / tauMs)
}

/** Distinct colors auto-assigned to objects without an explicit color.
 *  HUD family — matches the app's dominant #00f0ff cyan aesthetic. */
const PALETTE = ['#00f0ff', '#64ffda', '#ffd700', '#c8f4ff', '#0059ff', '#ff8a80', '#38d5ff', '#7fa6b8']

/** Extra-dimension gradient endpoint for w-colored polytopes (HUD gold). */
const W_COLOR_FAR = '#ffd700'

/** Kinds that are meaningless without a coordinate frame → axes auto-on.
 *  Plain shapes (primitive/parametric/curve/...) stay frameless unless
 *  scene.axes is set explicitly — exact positions are the user's call. */
const ANALYTIC_KINDS = new Set(['graph', 'vectors', 'plane', 'line', 'polygon'])

type Vec3 = [number, number, number]

function kindLabel(spec: Model3DSpec): string {
  switch (spec.kind) {
    case 'parametric': return 'Superficie'
    case 'polytope': return `${spec.dimension}D ${spec.type === 'hypercube' ? 'hipercubo' : 'ortoplex'}`
    case 'implicit': return 'Isosuperficie'
    case 'primitive': return ({ sphere: 'Esfera', box: 'Caja', cylinder: 'Cilindro', cone: 'Cono', torus: 'Toro' })[spec.shape] ?? 'Sólido'
    case 'curve': return 'Curva'
    case 'graph': return 'Gráfica'
    case 'vectors': return 'Vectores'
    case 'plane': return 'Plano'
    case 'line': return 'Recta'
    case 'polygon': return (spec.height ?? 0) > 0 ? 'Sólido' : 'Polígono'
    case 'simulation': return ({
      nbody: 'Simulación orbital', blackhole: 'Agujero negro',
      dynamics: 'Dinámica', field: 'Campo vectorial', ode: 'Sistema dinámico',
    })[spec.system] ?? 'Simulación'
  }
}

/* ---- Gesture rig: one grab/pinch controller for the whole scene ---- */

function GestureRig({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  // getState() dentro de useFrame, NUNCA una suscripción: el engine publica un
  // objeto `output` nuevo ~20 veces/s y suscribirse re-renderizaba TODA la
  // escena (este componente envuelve los children) en cada frame de gesto —
  // era la mayor parte de la sensación de "pesado" del visor con gestos.
  const groupRef = useRef<THREE.Group>(null)
  const grabbing = useRef(false)
  const baseRot = useRef({ x: 0, y: 0, z: 0 })
  const smoothDX = useRef(0)
  const smoothDY = useRef(0)
  const smoothDA = useRef(0)
  const smoothDist = useRef(BASE_CAM_DIST)

  useFrame((state, delta) => {
    const g = groupRef.current
    if (!g) return
    const gestureOutput = useGestureStore.getState().output
    // Gesture pipeline off → hands off. gestureStore.output is NOT reset when
    // the pipeline is disabled, so a stale grab/pinch 'active' flag would
    // otherwise hijack the scene rotation and fight OrbitControls' zoom.
    if (!enabled) { grabbing.current = false; return }
    // Control del puño, base capturada al enganchar (al soltar se queda, sin
    // snap-back). Mezcla deliberada de orientación y desplazamiento:
    //   Z (roll)  ← roll de la palma (deltaAngle), 1:1 · ROT_SIGN_ROLL
    //   Y (yaw)   ← girar la palma izq/der (rotYaw), 1:1 · ROT_SIGN_YAW
    //   X (pitch) ← SUBIR/BAJAR la mano (deltaY · PITCH_DRAG_GAIN)
    // Roll y yaw son 1:1 (ROT_GAIN=1.0): 20° de mano = 20° de figura; para
    // vueltas completas, soltar, re-agarrar y seguir (ratchet). El pitch va por
    // desplazamiento porque inclinar la muñeca es incómodo y da poco rango.
    const grab = gestureOutput.grab
    const aRot = tauAlpha(delta, SMOOTH_TAU_MS)
    if (grab.active) {
      if (!grabbing.current) {
        grabbing.current = true
        baseRot.current = { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z }
        smoothDX.current = 0
        smoothDY.current = 0
        smoothDA.current = 0
      }
      smoothDX.current += (grab.rotYaw - smoothDX.current) * aRot
      smoothDY.current += (grab.deltaY * PITCH_DRAG_GAIN - smoothDY.current) * aRot
      smoothDA.current += (grab.deltaAngle - smoothDA.current) * aRot
      g.rotation.z = baseRot.current.z + ROT_SIGN_ROLL * smoothDA.current
      g.rotation.y = baseRot.current.y + ROT_SIGN_YAW * smoothDX.current * ROT_GAIN
      g.rotation.x = baseRot.current.x + ROT_SIGN_PITCH * smoothDY.current
    } else {
      grabbing.current = false
    }
    // Zoom: la distancia se interpola hacia el objetivo en vez de saltar al
    // valor crudo de cada muestra — sin esto el temblor del pulgar (a 20 Hz)
    // se veía como vibración de la cámara.
    if (gestureOutput.pinch.active) {
      const target = THREE.MathUtils.clamp(BASE_CAM_DIST / gestureOutput.pinch.zoom, 2, 35)
      smoothDist.current += (target - smoothDist.current) * tauAlpha(delta, ZOOM_TAU_MS)
      state.camera.position.setLength(smoothDist.current)
    } else {
      smoothDist.current = state.camera.position.length()
    }
  })

  return <group ref={groupRef}>{children}</group>
}

/* ---- Text label sprite (canvas texture — self-contained, no font assets) ---- */

export function TextLabel({ position, text, color, size = 0.55 }: { position: Vec3; text: string; color: string; size?: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    const w = 48 + text.length * 30
    canvas.width = w
    canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.font = '44px "JetBrains Mono", monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    ctx.fillText(text, 10, 34)
    const tex = new THREE.CanvasTexture(canvas)
    tex.anisotropy = 4
    return tex
  }, [text, color])

  const aspect = (texture.image as HTMLCanvasElement).width / 64
  return (
    <sprite position={position} scale={[size * aspect, size, 1]} renderOrder={999}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  )
}

/* ---- Arrow (shaft + optional head), local +Y aligned to the direction ---- */

function ArrowMesh({ from, to, color, radius = 0.035, head = true, opacity = 1 }: {
  from: Vec3; to: Vec3; color: string; radius?: number; head?: boolean; opacity?: number
}) {
  const { quat, len } = useMemo(() => {
    const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2])
    const len = dir.length()
    const quat = new THREE.Quaternion()
    if (len > 1e-6) quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
    return { quat, len }
  }, [from, to])

  if (len < 1e-6) return null
  const headLen = head ? Math.min(0.4, len * 0.2) : 0
  const shaftLen = len - headLen
  return (
    <group position={from} quaternion={quat}>
      <mesh position={[0, shaftLen / 2, 0]}>
        <cylinderGeometry args={[radius, radius, shaftLen, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} transparent={opacity < 1} opacity={opacity} />
      </mesh>
      {head && (
        <mesh position={[0, shaftLen + headLen / 2, 0]}>
          <coneGeometry args={[radius * 2.8, headLen, 14]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      )}
    </group>
  )
}

/* ---- Axes + reference grid (math frame: z up) ---- */

const AXES: { dir: Vec3; color: string; label: string }[] = [
  { dir: [1, 0, 0], color: '#00f0ff', label: 'x' },
  { dir: [0, 1, 0], color: '#64ffda', label: 'y' },
  { dir: [0, 0, 1], color: '#c8f4ff', label: 'z' },
]

function AxesObject({ length }: { length: number }) {
  return (
    <group>
      {AXES.map(({ dir, color, label }) => (
        <group key={label}>
          <ArrowMesh
            from={[-dir[0] * length, -dir[1] * length, -dir[2] * length]}
            to={[dir[0] * length, dir[1] * length, dir[2] * length]}
            color={color} radius={0.02} opacity={0.85}
          />
          <TextLabel position={[dir[0] * length * 1.09, dir[1] * length * 1.09, dir[2] * length * 1.09]} text={label} color={color} size={0.5} />
        </group>
      ))}
    </group>
  )
}

function GridObject({ plane, size }: { plane: 'xy' | 'xz' | 'yz'; size: number }) {
  // three's gridHelper spans the local XZ plane; rotate it onto the target math plane.
  const rotation: Vec3 = plane === 'xy' ? [Math.PI / 2, 0, 0] : plane === 'yz' ? [0, 0, Math.PI / 2] : [0, 0, 0]
  return <gridHelper args={[size, size, '#0d3a47', '#082530']} rotation={rotation} />
}

/* ---- Parametric surface ---- */

function ParametricObject({ spec, color }: { spec: ParametricSpec; color: string }) {
  const geometry = useMemo(() => {
    try {
      const { positions, indices } = evaluateParametricSurface(spec)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1))
      geo.computeVertexNormals()
      return geo
    } catch (err) {
      console.warn('[model3d] parametric inválida:', err)
      return null
    }
  }, [spec])

  if (!geometry) return null
  const wireframe = spec.wireframe ?? true
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial
        color={color} side={THREE.DoubleSide} wireframe={wireframe}
        transparent opacity={spec.opacity ?? 0.85}
        emissive={color} emissiveIntensity={0.3}
      />
    </mesh>
  )
}

/** Constantes vacías compartidas: identidad estable para que los `useMemo` de
 *  abajo no se invaliden en cada render cuando la figura no se pudo construir. */
const EMPTY_VERTICES: number[][] = []
const EMPTY_EDGES: [number, number][] = []
const EMPTY_QUADS: [number, number, number, number][] = []

/**
 * Aísla cada figura del resto de la escena.
 *
 * Una spec que lanza (fórmula imposible, dimensión fuera de rango) tumbaba el
 * árbol de React entero: la ventana quedaba EN BLANCO y el único rastro era una
 * línea `CONSOLE JS ERROR` en journald. En la pared del proyector eso es peor
 * aún, porque nadie está mirando una consola. Con el límite aquí, la figura mala
 * simplemente no se dibuja y el resto de la escena sigue viva.
 */
export class Model3DErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: Error) { console.warn('[model3d] figura descartada:', err.message) }
  render() { return this.state.failed ? null : this.props.children }
}

/* ---- N-dimensional polytope (auto-rotating, w-colored, translucent faces) ---- */

function PolytopeObject({ spec, color }: { spec: PolytopeSpec; color: string }) {
  const linesRef = useRef<THREE.LineSegments>(null)
  const facesRef = useRef<THREE.Mesh>(null)
  const spheresRef = useRef<THREE.InstancedMesh>(null)
  const ndAngles = useRef({ xw: 0, yw: 0, zw: 0 })

  const dim = spec.dimension
  const spin = spec.spin ?? dim >= 4
  const speed = spec.speed ?? 1
  const colorByW = spec.colorByW ?? dim >= 4
  const showFaces = spec.faces ?? (spec.type === 'hypercube' && dim >= 4)

  // Los constructores LANZAN fuera de 2–7 dimensiones, y el modelo pide "20
  // dimensiones" cada tanto. Sin este catch la excepción sube por el árbol de
  // React y deja la ventana ENTERA en blanco — en la pared eso es el proyector
  // mostrando nada. Degradar a figura vacía es la misma regla que ya siguen las
  // superficies paramétricas.
  const built = useMemo(() => {
    try {
      return spec.type === 'hypercube' ? buildHypercube(dim) : buildCross(dim)
    } catch (err) {
      console.warn('[model3d] politopo inválido:', err)
      return null
    }
  }, [spec.type, dim])
  const baseVertices = built?.vertices ?? EMPTY_VERTICES
  const edges = built?.edges ?? EMPTY_EDGES

  const faceQuads = useMemo(() => {
    if (!built || !showFaces || spec.type !== 'hypercube') return EMPTY_QUADS
    try {
      return buildHypercubeFaces(dim)
    } catch (err) {
      console.warn('[model3d] caras inválidas:', err)
      return EMPTY_QUADS
    }
  }, [built, showFaces, spec.type, dim])

  const lineGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edges.length * 2 * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(edges.length * 2 * 3), 3))
    return geo
  }, [edges])

  const faceGeo = useMemo(() => {
    if (!faceQuads.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(baseVertices.length * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(baseVertices.length * 3), 3))
    const indices: number[] = []
    faceQuads.forEach(([a, b, c, d]) => { indices.push(a, b, c, a, c, d) })
    geo.setIndex(new THREE.Uint16BufferAttribute(indices, 1))
    return geo
  }, [faceQuads, baseVertices.length])

  // Reused scratch colors — avoids per-frame allocation.
  const colorNear = useMemo(() => new THREE.Color(color), [color])
  const colorFar = useMemo(() => new THREE.Color(W_COLOR_FAR), [])
  const tmpColor = useMemo(() => new THREE.Color(), [])

  useFrame((_state, delta) => {
    const lines = linesRef.current
    if (!lines) return

    // Auto-spin 4D+ pausado mientras los gestos están activos: pelea contra la
    // rotación por puño (la figura "se escapa" de la mano). getState() dentro
    // de useFrame — sin suscripción, se evalúa por frame.
    const spinLive = spin && !useGestureStore.getState().enabled
    if (spinLive && dim >= 4) {
      ndAngles.current.xw += delta * 0.28 * speed
      ndAngles.current.yw += delta * 0.19 * speed
    }
    if (spinLive && dim >= 5) {
      ndAngles.current.zw += delta * 0.13 * speed
    }

    let verts = baseVertices
    if (dim >= 4) {
      verts = rotateInPlane(verts, 0, 3, ndAngles.current.xw)
      verts = rotateInPlane(verts, 1, 3, ndAngles.current.yw)
    }
    if (dim >= 5) {
      verts = rotateInPlane(verts, 2, 4, ndAngles.current.zw)
    }

    const projected = projectToR3(verts)

    // Per-vertex color from the (rotated) 4th coordinate — the extra-dimension
    // depth cue that makes a tesseract readable: near-w keeps the base color,
    // far-w shifts toward magenta.
    const vertColors: [number, number, number][] = verts.map((v) => {
      const t = colorByW && dim >= 4 ? THREE.MathUtils.clamp((v[3] / 1.6 + 1) / 2, 0, 1) : 0
      tmpColor.copy(colorNear).lerp(colorFar, t)
      return [tmpColor.r, tmpColor.g, tmpColor.b]
    })

    const posAttr = lines.geometry.attributes.position as THREE.BufferAttribute
    const colAttr = lines.geometry.attributes.color as THREE.BufferAttribute
    edges.forEach(([i, j], k) => {
      const p = projected[i]
      const q = projected[j]
      posAttr.setXYZ(k * 2, p[0], p[1], p[2])
      posAttr.setXYZ(k * 2 + 1, q[0], q[1], q[2])
      colAttr.setXYZ(k * 2, ...vertColors[i])
      colAttr.setXYZ(k * 2 + 1, ...vertColors[j])
    })
    posAttr.needsUpdate = true
    colAttr.needsUpdate = true

    const faces = facesRef.current
    if (faces && faceGeo) {
      const fPos = faceGeo.attributes.position as THREE.BufferAttribute
      const fCol = faceGeo.attributes.color as THREE.BufferAttribute
      projected.forEach(([x, y, z], i) => {
        fPos.setXYZ(i, x, y, z)
        fCol.setXYZ(i, ...vertColors[i])
      })
      fPos.needsUpdate = true
      fCol.needsUpdate = true
    }

    const spheres = spheresRef.current
    if (spheres) {
      const dummy = new THREE.Object3D()
      projected.forEach(([x, y, z], i) => {
        dummy.position.set(x, y, z)
        dummy.updateMatrix()
        spheres.setMatrixAt(i, dummy.matrix)
      })
      spheres.instanceMatrix.needsUpdate = true
    }
  })

  // Todos los hooks ya corrieron: aquí sí se puede salir sin romper su orden.
  if (!built) return null

  return (
    <group>
      <lineSegments ref={linesRef} geometry={lineGeo}>
        <lineBasicMaterial vertexColors transparent opacity={0.8} />
      </lineSegments>
      {faceGeo && (
        <mesh ref={facesRef} geometry={faceGeo}>
          <meshBasicMaterial
            vertexColors transparent opacity={spec.opacity ?? 0.14}
            side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}
      <instancedMesh ref={spheresRef} args={[undefined, undefined, baseVertices.length]}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshBasicMaterial color={color} />
      </instancedMesh>
    </group>
  )
}

/* ---- Implicit surface (marching cubes + optional Brillouin-zone clip) ---- */

function ImplicitObject({ spec, color }: { spec: ImplicitSpec; color: string }) {
  // Build the isosurface mesh once per spec. mathjs compiles f(x,y,z); marching
  // cubes samples it on a grid and extracts triangles. Clipping planes (if a
  // Brillouin zone is given) trim the render to the 1st BZ — no mesh cutting.
  const built = useMemo(() => {
    try {
      const bounds = spec.bounds ?? [-Math.PI, Math.PI]
      const compiled = mathImplicit.compile(spec.f)
      const field = (x: number, y: number, z: number) => {
        const v = compiled.evaluate({ x, y, z }) as number
        return typeof v === 'number' ? v : NaN
      }
      const { positions } = marchingCubes(field, spec.isoValue, bounds, spec.resolution ?? 40)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geo.computeVertexNormals()

      const scale = bounds[1]
      const clipPlanes = spec.brillouinZone
        ? brillouinZonePlanes(spec.brillouinZone, scale).map(
            (p) => new THREE.Plane(new THREE.Vector3(p.normal[0], p.normal[1], p.normal[2]), p.constant))
        : []
      return { geometry: geo, clipPlanes }
    } catch (err) {
      console.warn('[model3d] implicit inválida:', err)
      return null
    }
  }, [spec])

  if (!built) return null
  return (
    <mesh geometry={built.geometry}>
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.25}
        side={THREE.DoubleSide}
        metalness={0.3}
        roughness={0.45}
        transparent={(spec.opacity ?? 1) < 1}
        opacity={spec.opacity ?? 1}
        clippingPlanes={built.clipPlanes}
        clipShadows
      />
    </mesh>
  )
}

/* ---- Exact primitives — compositions with precise tangency/containment ---- */

function PrimitiveObject({ spec, color }: { spec: PrimitiveSpec; color: string }) {
  // Holographic HUD look: faint volumetric fill + bright structural edge lines.
  // Fill uses a high-segment geometry (smooth silhouette); the edge overlay is
  // extracted from a LOW-segment copy so it reads as a clean lat/long scaffold.
  // EdgesGeometry with an 8° threshold drops coplanar quad diagonals.
  const built = useMemo(() => {
    const r = spec.radius ?? 1
    const h = spec.height ?? 2
    const tube = spec.tube ?? 0.35
    const size: Vec3 = typeof spec.size === 'number'
      ? [spec.size, spec.size, spec.size]
      : spec.size ?? [1.5, 1.5, 1.5]
    let fill: THREE.BufferGeometry
    let wireSrc: THREE.BufferGeometry
    switch (spec.shape) {
      case 'sphere':
        fill = new THREE.SphereGeometry(r, 48, 32)
        wireSrc = new THREE.SphereGeometry(r, 20, 12)
        break
      case 'box':
        fill = new THREE.BoxGeometry(...size)
        wireSrc = fill
        break
      case 'cylinder':
        fill = new THREE.CylinderGeometry(r, r, h, 48)
        wireSrc = new THREE.CylinderGeometry(r, r, h, 16)
        break
      case 'cone':
        fill = new THREE.ConeGeometry(r, h, 48)
        wireSrc = new THREE.ConeGeometry(r, h, 16)
        break
      case 'torus':
        fill = new THREE.TorusGeometry(r, tube, 12, 48)
        wireSrc = new THREE.TorusGeometry(r, tube, 8, 24)
        break
    }
    return { fill, edges: new THREE.EdgesGeometry(wireSrc, 8) }
  }, [spec.shape, spec.radius, spec.height, spec.tube, spec.size])

  // Cylinder/cone axis is local +Y in three; rotate to math z (vertical).
  const axisFix: Vec3 = spec.shape === 'cylinder' || spec.shape === 'cone' ? [Math.PI / 2, 0, 0] : [0, 0, 0]

  // spec.opacity keeps its "how solid is this figure" meaning; the hologram
  // splits it between the faint fill and the edge scaffold.
  const fillOpacity = (spec.opacity ?? 0.3) * 0.55
  return (
    <group rotation={axisFix}>
      {!spec.wireframe && (
        <mesh geometry={built.fill}>
          <meshStandardMaterial
            color={color} emissive={color} emissiveIntensity={0.5}
            metalness={0} roughness={1}
            transparent opacity={fillOpacity}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      <lineSegments geometry={built.edges}>
        <lineBasicMaterial color={color} transparent opacity={spec.wireframe ? 0.9 : 0.7} />
      </lineSegments>
    </group>
  )
}

/* ---- Curves and function graphs ---- */

function CurveSegments({ segments, color, radius = 0.05, opacity = 1 }: {
  segments: Float32Array[]; color: string; radius?: number; opacity?: number
}) {
  const tubes = useMemo(() => segments.map((seg) => {
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < seg.length; i += 3) pts.push(new THREE.Vector3(seg[i], seg[i + 1], seg[i + 2]))
    if (pts.length < 2) return null
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1)
    return new THREE.TubeGeometry(curve, Math.min(pts.length * 2, 480), radius, 8, false)
  }).filter((g): g is THREE.TubeGeometry => g !== null), [segments, radius])

  return (
    <group>
      {tubes.map((geo, i) => (
        <mesh key={i} geometry={geo}>
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      ))}
    </group>
  )
}

function CurveObject({ spec, color }: { spec: CurveSpec; color: string }) {
  const segments = useMemo(() => {
    try {
      return sampleCurve3D({ x: spec.x, y: spec.y, z: spec.z, tRange: spec.tRange, samples: spec.samples })
    } catch (err) {
      console.warn('[model3d] curva inválida:', err)
      return []
    }
  }, [spec])
  return <CurveSegments segments={segments} color={color} opacity={spec.opacity ?? 1} />
}

function GraphObject({ spec, color }: { spec: GraphSpec; color: string }) {
  const xRange = spec.xRange ?? [-6, 6]
  const yRange = spec.yRange ?? spec.xRange ?? [-6, 6]

  const built = useMemo(() => {
    try {
      if (freeSymbols(spec.f).has('y')) {
        const { positions, indices } = sampleSurface(spec.f, xRange, yRange, spec.segments ?? 56)
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1))
        geo.computeVertexNormals()
        return { surface: geo, segments: null }
      }
      return { surface: null, segments: sampleGraph1D(spec.f, xRange, spec.samples) }
    } catch (err) {
      console.warn('[model3d] gráfica inválida:', err)
      return { surface: null, segments: [] as Float32Array[] }
    }
  }, [spec, xRange[0], xRange[1], yRange[0], yRange[1]])

  if (built.surface) {
    // Holo surface: faint emissive fill + dim wireframe mesh on top.
    return (
      <group>
        {!spec.wireframe && (
          <mesh geometry={built.surface}>
            <meshStandardMaterial
              color={color} emissive={color} emissiveIntensity={0.4}
              metalness={0} roughness={1}
              side={THREE.DoubleSide}
              transparent opacity={(spec.opacity ?? 0.5) * 0.6}
              depthWrite={false}
            />
          </mesh>
        )}
        <mesh geometry={built.surface}>
          <meshStandardMaterial
            color={color} emissive={color} emissiveIntensity={0.5}
            side={THREE.DoubleSide}
            transparent opacity={spec.wireframe ? 0.85 : 0.18}
            depthWrite={false}
            wireframe
          />
        </mesh>
      </group>
    )
  }
  return <CurveSegments segments={built.segments ?? []} color={color} radius={0.06} opacity={spec.opacity ?? 1} />
}

/* ---- Vectors (n-D projected) with optional span(v1,v2) lattice ---- */

function VectorsObject({ spec, color }: { spec: VectorsSpec; color: string }) {
  const origin: Vec3 = spec.origin ?? [0, 0, 0]
  const vecs = useMemo(() => vectorsToR3(spec.vectors ?? []), [spec.vectors])

  const span = useMemo(() => {
    if (!spec.showSpan || vecs.length < 2) return null
    const [v1, v2] = vecs
    const lattice = spanLatticeLines(v1, v2, 3, origin)
    const quad = new Float32Array([
      // two triangles over the parallelogram (o, v1, v1+v2, v2), scaled ×3 to read as a plane
      ...origin,
      origin[0] + 3 * v1[0], origin[1] + 3 * v1[1], origin[2] + 3 * v1[2],
      origin[0] + 3 * (v1[0] + v2[0]), origin[1] + 3 * (v1[1] + v2[1]), origin[2] + 3 * (v1[2] + v2[2]),
      ...origin,
      origin[0] + 3 * (v1[0] + v2[0]), origin[1] + 3 * (v1[1] + v2[1]), origin[2] + 3 * (v1[2] + v2[2]),
      origin[0] + 3 * v2[0], origin[1] + 3 * v2[1], origin[2] + 3 * v2[2],
    ])
    const latticeGeo = new THREE.BufferGeometry()
    latticeGeo.setAttribute('position', new THREE.BufferAttribute(lattice, 3))
    const quadGeo = new THREE.BufferGeometry()
    quadGeo.setAttribute('position', new THREE.BufferAttribute(quad, 3))
    quadGeo.computeVertexNormals()
    return { latticeGeo, quadGeo }
  }, [spec.showSpan, vecs, origin])

  const nDim = Math.max(0, ...(spec.vectors ?? []).map((v) => v.length))

  return (
    <group>
      {vecs.map((v, i) => {
        const c = spec.colors?.[i] ?? (i === 0 ? color : PALETTE[(i + 1) % PALETTE.length])
        const tip: Vec3 = [origin[0] + v[0], origin[1] + v[1], origin[2] + v[2]]
        const label = spec.labels?.[i] ?? (nDim > 3 ? `v${i + 1}∈ℝ${nDim}` : `v${i + 1}`)
        return (
          <group key={i}>
            <ArrowMesh from={origin} to={tip} color={c} radius={0.045} />
            <TextLabel position={[origin[0] + v[0] * 1.12, origin[1] + v[1] * 1.12, origin[2] + v[2] * 1.12]} text={label} color={c} size={0.45} />
          </group>
        )
      })}
      {span && (
        <group>
          <lineSegments geometry={span.latticeGeo}>
            <lineBasicMaterial color={color} transparent opacity={0.28} />
          </lineSegments>
          <mesh geometry={span.quadGeo}>
            <meshBasicMaterial color={color} transparent opacity={0.1} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        </group>
      )}
    </group>
  )
}

/* ---- Analytic plane and infinite line ---- */

function PlaneObject({ spec, color }: { spec: PlaneSpec; color: string }) {
  const built = useMemo(() => {
    const p: Vec3 = spec.point ?? [0, 0, 0]
    const S = spec.size ?? 8
    let u: Vec3, v: Vec3
    if (spec.u && spec.v) {
      u = spec.u; v = spec.v
    } else {
      const basis = planeBasis(spec.normal ?? [0, 0, 1])
      u = basis.u; v = basis.v
    }
    const at = (a: number, b: number): Vec3 => [
      p[0] + a * u[0] + b * v[0],
      p[1] + a * u[1] + b * v[1],
      p[2] + a * u[2] + b * v[2],
    ]
    const hs = S / 2
    const c00 = at(-hs, -hs), c10 = at(hs, -hs), c11 = at(hs, hs), c01 = at(-hs, hs)
    const quad = new Float32Array([...c00, ...c10, ...c11, ...c00, ...c11, ...c01])
    const quadGeo = new THREE.BufferGeometry()
    quadGeo.setAttribute('position', new THREE.BufferAttribute(quad, 3))
    quadGeo.computeVertexNormals()

    const lines: number[] = []
    const DIV = 10
    for (let k = 0; k <= DIV; k++) {
      const off = -hs + (k / DIV) * S
      lines.push(...at(off, -hs), ...at(off, hs))
      lines.push(...at(-hs, off), ...at(hs, off))
    }
    const gridGeo = new THREE.BufferGeometry()
    gridGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3))
    return { quadGeo, gridGeo }
  }, [spec])

  return (
    <group>
      <mesh geometry={built.quadGeo}>
        <meshBasicMaterial color={color} transparent opacity={spec.opacity ?? 0.08} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={built.gridGeo}>
        <lineBasicMaterial color={color} transparent opacity={0.3} />
      </lineSegments>
    </group>
  )
}

function LineObject({ spec, color }: { spec: LineSpec; color: string }) {
  const p: Vec3 = spec.point ?? [0, 0, 0]
  const L = spec.length ?? 24
  const d = useMemo(() => {
    const v = new THREE.Vector3(...spec.direction)
    return v.lengthSq() < 1e-12 ? new THREE.Vector3(1, 0, 0) : v.normalize()
  }, [spec.direction])
  const from: Vec3 = [p[0] - d.x * L / 2, p[1] - d.y * L / 2, p[2] - d.z * L / 2]
  const to: Vec3 = [p[0] + d.x * L / 2, p[1] + d.y * L / 2, p[2] + d.z * L / 2]
  return <ArrowMesh from={from} to={to} color={color} radius={0.035} head={spec.arrow ?? false} opacity={spec.opacity ?? 1} />
}

/* ---- Explicit vertex polygon (hand capture) ---- */

/**
 * Vertex-list figure, optionally extruded along its best-fit plane normal.
 *
 * The face is triangulated as a fan around the CENTROID, not around vertex 0:
 * hand-made polygons come out star-shaped around their centre but are often
 * non-convex, and a vertex-0 fan folds over itself on those.
 *
 * `capScale: 0` collapses the top ring to a single apex, so the same spec
 * covers prism → pyramid and cylinder → cone.
 */
function PolygonObject({ spec, color }: { spec: PolygonSpec; color: string }) {
  const built = useMemo(() => {
    try {
      const verts: Vec3[] = (spec.vertices ?? []).map((v) => [v[0], v[1], v[2]])
      if (verts.length < 2) return null
      const n = verts.length
      const closed = spec.closed ?? true
      const height = spec.height ?? 0
      const capScale = spec.capScale ?? 1
      const solid = height > 1e-6 && n >= 3

      const centroid: Vec3 = [0, 0, 0]
      for (const v of verts) { centroid[0] += v[0]; centroid[1] += v[1]; centroid[2] += v[2] }
      centroid[0] /= n; centroid[1] /= n; centroid[2] /= n

      const normal = bestFitPlane(verts).normal
      const lift = (v: Vec3): Vec3 => [
        centroid[0] + capScale * (v[0] - centroid[0]) + normal[0] * height,
        centroid[1] + capScale * (v[1] - centroid[1]) + normal[1] * height,
        centroid[2] + capScale * (v[2] - centroid[2]) + normal[2] * height,
      ]
      const top: Vec3[] = solid ? verts.map(lift) : []
      const apex = capScale < 1e-6

      const lines: number[] = []
      const edgeCount = closed ? n : n - 1
      for (let i = 0; i < edgeCount; i++) {
        const j = (i + 1) % n
        lines.push(...verts[i], ...verts[j])
        if (solid) {
          if (!apex) lines.push(...top[i], ...top[j])
          lines.push(...verts[i], ...top[i])
        }
      }

      const tris: number[] = []
      const fan = (ring: Vec3[], flip: boolean) => {
        const c: Vec3 = [0, 0, 0]
        for (const v of ring) { c[0] += v[0]; c[1] += v[1]; c[2] += v[2] }
        c[0] /= ring.length; c[1] /= ring.length; c[2] /= ring.length
        for (let i = 0; i < ring.length; i++) {
          const j = (i + 1) % ring.length
          if (flip) tris.push(...c, ...ring[j], ...ring[i])
          else tris.push(...c, ...ring[i], ...ring[j])
        }
      }

      if (n >= 3 && (spec.fill ?? true)) {
        fan(verts, false)
        if (solid && !apex) fan(top, true)
      }
      if (solid) {
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n
          if (apex) {
            tris.push(...verts[i], ...verts[j], ...top[i])
          } else {
            tris.push(...verts[i], ...verts[j], ...top[j])
            tris.push(...verts[i], ...top[j], ...top[i])
          }
        }
      }

      const lineGeo = new THREE.BufferGeometry()
      lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3))
      let faceGeo: THREE.BufferGeometry | null = null
      if (tris.length) {
        faceGeo = new THREE.BufferGeometry()
        faceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris), 3))
        faceGeo.computeVertexNormals()
      }
      return { lineGeo, faceGeo, points: solid ? [...verts, ...top] : verts }
    } catch (err) {
      console.warn('[model3d] polígono inválido:', err)
      return null
    }
  }, [spec])

  if (!built) return null
  const opacity = spec.opacity ?? 0.35

  return (
    <group>
      {built.faceGeo && !spec.wireframe && (
        <mesh geometry={built.faceGeo}>
          <meshStandardMaterial
            color={color} emissive={color} emissiveIntensity={0.18}
            transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false}
          />
        </mesh>
      )}
      <lineSegments geometry={built.lineGeo}>
        <lineBasicMaterial color={color} transparent opacity={0.95} />
      </lineSegments>
      {built.points.map((v, i) => (
        <mesh key={i} position={v}>
          <sphereGeometry args={[0.06, 10, 10]} />
          <meshBasicMaterial color={color} />
        </mesh>
      ))}
    </group>
  )
}

/* ---- Per-object dispatcher (position/rotation/scale wrapper) ---- */

export function SceneObjectView({ spec, color }: { spec: Model3DSpec; color: string }) {
  const scale: Vec3 = typeof spec.scale === 'number'
    ? [spec.scale, spec.scale, spec.scale]
    : spec.scale ?? [1, 1, 1]
  return (
    <group position={spec.position ?? [0, 0, 0]} rotation={spec.rotation ?? [0, 0, 0]} scale={scale}>
      {spec.kind === 'parametric' && <ParametricObject spec={spec} color={color} />}
      {spec.kind === 'polytope' && <PolytopeObject spec={spec} color={color} />}
      {spec.kind === 'implicit' && <ImplicitObject spec={spec} color={color} />}
      {spec.kind === 'primitive' && <PrimitiveObject spec={spec} color={color} />}
      {spec.kind === 'curve' && <CurveObject spec={spec} color={color} />}
      {spec.kind === 'graph' && <GraphObject spec={spec} color={color} />}
      {spec.kind === 'vectors' && <VectorsObject spec={spec} color={color} />}
      {spec.kind === 'plane' && <PlaneObject spec={spec} color={color} />}
      {spec.kind === 'line' && <LineObject spec={spec} color={color} />}
      {spec.kind === 'polygon' && <PolygonObject spec={spec} color={color} />}
      {spec.kind === 'simulation' && <SimulationObject spec={spec as SimulationSpec} />}
    </group>
  )
}

/* ---- Modo realista: fondo de estrellas + tone mapping físico ---- */

/** Equirectangular de la Vía Láctea, servida desde `public/textures/`. Ruta
 *  RELATIVA a propósito: el bundle va con `base: './'` y esta página se sirve
 *  tanto desde el protocolo de Tauri como desde el backend por Tailscale
 *  (misma convención que el modelo de MediaPipe en `gestures/landmarker.ts`).
 *  Nada de CDNs: esta máquina trabaja offline. */
const STARFIELD_URL = 'textures/2k_stars_milky_way.jpg'

/** Fondo mientras la textura carga, y si no llega. No es negro PURO: el cielo
 *  real tiene un suelo tenue de luz zodiacal y estelar. */
const SPACE_BG = '#05070d'

/**
 * Fondo del modo realista. Va como `scene.background` con mapeo
 * equirectangular, NUNCA como una esfera gigante invertida: una esfera entra en
 * el raycast de R3F y se traga los clics del usuario.
 *
 * La textura se carga A MANO y no con `useLoader` para no SUSPENDER el árbol
 * del Canvas —aquí no hay `Suspense` que sostenga la escena— y para que un
 * fallo de carga degrade a negro en vez de tumbar el visor. No se crea ningún
 * contexto WebGL nuevo: WebKitGTK sobre esta iGPU mata el segundo.
 */
function SpaceBackdrop({ starfield, fallback }: { starfield: boolean; fallback: string }) {
  const scene = useThree((s) => s.scene)

  useLayoutEffect(() => {
    const prev = scene.background
    const plain = new THREE.Color(fallback)
    scene.background = plain

    let tex: THREE.Texture | null = null
    let cancelled = false

    if (starfield) {
      new THREE.TextureLoader().load(
        STARFIELD_URL,
        (t) => {
          if (cancelled) { t.dispose(); return }
          t.mapping = THREE.EquirectangularReflectionMapping
          // Es una FOTO: sin marcarla sRGB el renderer la trata como lineal y
          // la Vía Láctea sale lavada.
          t.colorSpace = THREE.SRGBColorSpace
          tex = t
          scene.background = t
        },
        undefined,
        () => { /* sin estrellas nos quedamos con el negro: un fondo no rompe la escena */ },
      )
    }

    return () => {
      cancelled = true
      // Solo devolvemos el fondo si sigue siendo NUESTRO. Al salir del modo
      // realista, el `<color attach="background">` del modo holográfico puede
      // haberse montado ya (el orden entre su attach y esta limpieza no está
      // garantizado), y pisarlo dejaría el visor en negro.
      if (scene.background === plain || (tex !== null && scene.background === tex)) {
        scene.background = prev
      }
      tex?.dispose()
    }
  }, [scene, starfield, fallback])

  return null
}

/**
 * Tone mapping físico, SOLO en modo realista. Con luz de estrella y un Sol
 * emisivo el rango dinámico se sale de [0,1]: sin ACES el Sol clipa a un disco
 * blanco plano (la misma cicatriz que el núcleo emisivo del holograma
 * `VaultGeo`). Se restaura el valor anterior al desmontar — un ajuste de
 * renderer que no se revierte deja las figuras abstractas lavadas para siempre.
 */
function PhysicalToneMapping() {
  const gl = useThree((s) => s.gl)

  useLayoutEffect(() => {
    const prevTone = gl.toneMapping
    const prevExposure = gl.toneMappingExposure
    const prevColorSpace = gl.outputColorSpace
    gl.toneMapping = THREE.ACESFilmicToneMapping
    // Ligeramente por encima de 1: ACES oscurece los medios y el espacio ya es
    // oscuro de por sí. Este es el mando de brillo de la escena realista.
    gl.toneMappingExposure = 1.1
    gl.outputColorSpace = THREE.SRGBColorSpace   // el default de three, explícito
    return () => {
      gl.toneMapping = prevTone
      gl.toneMappingExposure = prevExposure
      gl.outputColorSpace = prevColorSpace
    }
  }, [gl])

  return null
}

/* ---- Scene wrapper ---- */

function Scene({ objects, colors, sceneOpts, hiddenIds, gestureEnabled }: {
  objects: Model3DSpec[]
  colors: Map<string, string>
  sceneOpts: SceneOptions
  hiddenIds: Set<string>
  gestureEnabled: boolean
}) {
  const showAxes = sceneOpts.axes ?? objects.some((o) => ANALYTIC_KINDS.has(o.kind))
  const gridPlane = sceneOpts.grid === true
    ? 'xy'
    : sceneOpts.grid || (sceneOpts.grid !== false && objects.some((o) => o.kind === 'graph') ? 'xy' : null)
  const axisLength = sceneOpts.axisLength ?? 6

  /* Holográfico o físico. La condición es estricta (una simulación con look
   * realista) y vive en `lib/sim/scene.ts`, pura y con tests. Si la escena
   * MEZCLA una simulación realista con figuras abstractas gana el realista: una
   * figura holográfica bajo luz física sigue leyéndose (pierde el tinte cyan),
   * mientras que un planeta bajo ambiente cyan no vuelve a ser un planeta. */
  const look = useMemo(() => resolveSceneLook(objects), [objects])

  return (
    <>
      {look.realistic ? (
        <>
          {/* La luz la pone la ESTRELLA, desde dentro de la simulación. Aquí
              solo queda un suelo tenue y BLANCO —el espacio no es negro puro:
              hay luz zodiacal y estelar, pero es débil y neutra—, y ni una de
              las dos pointLights decorativas: el ambiente cyan teñía de azul
              todo lo que tocaba (un Marte rojo salía malva, la Luna celeste). */}
          <SpaceBackdrop starfield={look.starfield} fallback={sceneOpts.background ?? SPACE_BG} />
          <PhysicalToneMapping />
          <ambientLight intensity={0.05} color="#ffffff" />
          {/* Relleno solo para los sistemas que NO traen luz propia (dynamics,
              field, ode): sus cuerpos son `meshStandardMaterial` sin ninguna
              luz cerca, así que sin el ambiente cyan quedarían negros. */}
          {look.keyLight && <directionalLight position={[5, 8, 5]} intensity={1.8} color="#ffffff" />}
        </>
      ) : (
        <>
          <color attach="background" args={[sceneOpts.background ?? '#03080d']} />
          <ambientLight intensity={0.45} color="#00f0ff" />
          <pointLight position={[5, 8, 5]} intensity={1.2} color="#ffffff" />
          <pointLight position={[-5, -3, -5]} intensity={0.6} color="#0059ff" />
        </>
      )}
      {!gestureEnabled && <OrbitControls makeDefault enablePan={true} />}
      <GestureRig enabled={gestureEnabled}>
        {/* Math frame: math z becomes screen-up. All specs are math coordinates. */}
        <group rotation={[-Math.PI / 2, 0, 0]}>
          {showAxes && <AxesObject length={axisLength} />}
          {gridPlane && <GridObject plane={gridPlane} size={Math.ceil(axisLength) * 2} />}
          {objects.filter((o) => !hiddenIds.has(o.id!)).map((o) => (
            <Model3DErrorBoundary key={o.id}>
              <SceneObjectView spec={o} color={colors.get(o.id!) ?? PALETTE[0]} />
            </Model3DErrorBoundary>
          ))}
        </group>
      </GestureRig>
    </>
  )
}

/* ---- Simulation HUD + transport ---- */

/** Physics readout and transport controls. Mounted outside the Canvas so the
 *  render loop never triggers a React re-render of the 3D tree: the engine
 *  pushes text into simStore at ~4 Hz and only this panel re-renders. */
function SimHud() {
  const active = useSimStore(s => s.active)
  const playing = useSimStore(s => s.playing)
  const speed = useSimStore(s => s.speed)
  const readout = useSimStore(s => s.readout)
  const title = useSimStore(s => s.title)
  const toggle = useSimStore(s => s.toggle)
  const setSpeed = useSimStore(s => s.setSpeed)
  const reset = useSimStore(s => s.reset)

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') { e.preventDefault(); toggle() }
      else if (e.key === 'r' || e.key === 'R') reset()
      else if (e.key === '+' || e.key === '=') setSpeed(useSimStore.getState().speed * 2)
      else if (e.key === '-') setSpeed(useSimStore.getState().speed / 2)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, toggle, reset, setSpeed])

  if (!active) return null

  const btn: React.CSSProperties = {
    background: 'rgba(0,240,255,0.10)', border: '1px solid rgba(0,240,255,0.42)',
    borderRadius: 4, color: '#00f0ff', cursor: 'pointer', padding: '3px 10px', fontSize: 11,
  }

  return (
    <div style={{
      position: 'absolute', left: 14, bottom: 14,
      background: 'rgba(3, 10, 18, 0.86)', border: '1px solid rgba(0,240,255,0.22)',
      borderRadius: 8, padding: '10px 12px', minWidth: 240, maxWidth: 380,
      display: 'flex', flexDirection: 'column', gap: 8,
      backdropFilter: 'blur(8px)', fontSize: 12, color: '#ccd6f6',
    }}>
      {title && (
        <div style={{ color: '#00f0ff', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' }}>
          {title}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={toggle} style={btn} title="Espacio">{playing ? '❚❚' : '▶'}</button>
        <button onClick={reset} style={btn} title="R">↺</button>
        <span style={{ color: '#7fa6b8', fontSize: 11 }}>×</span>
        {SIM_SPEEDS.map((v) => (
          <button
            key={v}
            onClick={() => setSpeed(v)}
            style={{
              ...btn,
              padding: '2px 6px',
              opacity: Math.abs(speed - v) < 1e-6 ? 1 : 0.42,
              borderColor: Math.abs(speed - v) < 1e-6 ? 'rgba(0,240,255,0.8)' : 'rgba(0,240,255,0.25)',
            }}
          >{v}</button>
        ))}
      </div>

      {readout.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
          {readout.map(([k, v]) => (
            <React.Fragment key={k}>
              <span style={{ color: '#7fa6b8', whiteSpace: 'nowrap' }}>{k}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---- Overlay wrapper ---- */

export function Model3DViewer() {
  const open = useModel3dStore(s => s.open)
  const objects = useModel3dStore(s => s.objects)
  const sceneOpts = useModel3dStore(s => s.scene)
  const hide = useModel3dStore(s => s.hide)
  const removeObject = useModel3dStore(s => s.remove)
  const gestureEnabled = useGestureStore(s => s.enabled)
  const setGestureEnabled = useGestureStore(s => s.setEnabled)
  const [showGesturePrompt, setShowGesturePrompt] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hide])

  // On open: if gestures are off, prompt to activate them.
  // gestureEnabled intentionally excluded from deps — we only want to trigger
  // on viewer open, not every time gesture state changes externally.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open && !gestureEnabled) {
      setShowGesturePrompt(true)
    }
    if (open) setHiddenIds(new Set())
  }, [open])

  // Stable palette assignment by index in the FULL object list (hiding one
  // object must not recolor the rest).
  const colors = useMemo(() => {
    const map = new Map<string, string>()
    objects.forEach((o, i) => map.set(o.id!, o.color ?? PALETTE[i % PALETTE.length]))
    return map
  }, [objects])

  if (!open || objects.length === 0) return null

  const title = sceneOpts.title
    ?? (objects.length === 1 ? (objects[0].title ?? kindLabel(objects[0])) : `${objects.length} figuras`)
  const hasSimulation = objects.some((o) => o.kind === 'simulation')

  const toggleHidden = (id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 5000,
      background: 'rgba(3, 8, 13, 0.96)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px', color: '#00f0ff', fontSize: 13, letterSpacing: 1,
        textTransform: 'uppercase', borderBottom: '1px solid rgba(0,240,255,0.18)',
      }}>
        <span>{title}</span>
        <button
          onClick={hide}
          style={{ background: 'transparent', border: 'none', color: '#7fa6b8', cursor: 'pointer', fontSize: 20 }}
          aria-label="Cerrar"
        >×</button>
      </div>

      {/* 3D canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas camera={{ position: [7, 5.5, 9], fov: 40 }} gl={{ localClippingEnabled: true }}>
          <Scene
            objects={objects}
            colors={colors}
            sceneOpts={sceneOpts}
            hiddenIds={hiddenIds}
            gestureEnabled={gestureEnabled}
          />
        </Canvas>

        {/* Legend — one row per object: color, name, visibility toggle, remove */}
        {objects.length > 1 && (
          <div style={{
            position: 'absolute', top: 14, right: 14,
            background: 'rgba(3, 10, 18, 0.85)', border: '1px solid rgba(0,240,255,0.22)',
            borderRadius: 8, padding: '8px 10px', minWidth: 150,
            display: 'flex', flexDirection: 'column', gap: 6,
            backdropFilter: 'blur(8px)', fontSize: 12, color: '#ccd6f6',
          }}>
            {objects.map((o) => {
              const isHidden = hiddenIds.has(o.id!)
              return (
                <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: isHidden ? 0.4 : 1 }}>
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                    background: colors.get(o.id!),
                    boxShadow: `0 0 6px ${colors.get(o.id!)}`,
                  }} />
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 160 }}>
                    {o.title ?? kindLabel(o)}
                  </span>
                  <button
                    onClick={() => toggleHidden(o.id!)}
                    title={isHidden ? 'Mostrar' : 'Ocultar'}
                    style={{ background: 'transparent', border: 'none', color: '#7fa6b8', cursor: 'pointer', fontSize: 12, padding: 0 }}
                  >{isHidden ? '○' : '●'}</button>
                  <button
                    onClick={() => removeObject(o.id!)}
                    title="Quitar"
                    style={{ background: 'transparent', border: 'none', color: '#7fa6b8', cursor: 'pointer', fontSize: 13, padding: 0 }}
                  >×</button>
                </div>
              )
            })}
          </div>
        )}

        <SimHud />

        {/* Gesture activation prompt */}
        {showGesturePrompt && (
          <div style={{
            position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(3, 10, 18, 0.92)', border: '1px solid rgba(0,240,255,0.4)',
            borderRadius: 8, padding: '10px 18px',
            color: '#ccd6f6', fontSize: 12, letterSpacing: 0.5,
            display: 'flex', alignItems: 'center', gap: 12,
            backdropFilter: 'blur(8px)',
          }}>
            <span>¿Activar gestos para el visor 3D?</span>
            <button
              onClick={() => { setGestureEnabled(true); setShowGesturePrompt(false) }}
              style={{ background: 'rgba(0,240,255,0.12)', border: '1px solid rgba(0,240,255,0.5)', borderRadius: 4, color: '#00f0ff', cursor: 'pointer', padding: '3px 10px', fontSize: 11 }}
            >Sí</button>
            <button
              onClick={() => setShowGesturePrompt(false)}
              style={{ background: 'transparent', border: '1px solid rgba(100,130,150,0.4)', borderRadius: 4, color: '#7fa6b8', cursor: 'pointer', padding: '3px 10px', fontSize: 11 }}
            >No</button>
          </div>
        )}
      </div>

      {/* Footer hint — changes by control mode */}
      <div style={{
        padding: '6px 20px', color: 'rgba(0,240,255,0.4)', fontSize: 11,
        borderTop: '1px solid rgba(0,240,255,0.1)',
        textAlign: 'center',
      }}>
        {(gestureEnabled
          ? 'Puño cerrado: rotar · Pinch: zoom · Esc: cerrar'
          : 'Arrastra: rotar · Scroll: zoom · Esc: cerrar')
          + (hasSimulation ? ' · Espacio: pausa · R: reiniciar · ±: velocidad' : '')}
      </div>
    </div>
  )
}
