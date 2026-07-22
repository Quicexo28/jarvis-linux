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

import { useRef, useMemo, useEffect, useState, type ReactNode } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useGestureStore } from '../state/gestureStore'
import { create, all } from 'mathjs'
import {
  useModel3dStore,
  type Model3DSpec, type SceneOptions,
  type ParametricSpec, type PolytopeSpec, type ImplicitSpec, type PrimitiveSpec,
  type CurveSpec, type GraphSpec, type VectorsSpec, type PlaneSpec, type LineSpec,
} from '../state/model3dStore'
import { evaluateParametricSurface } from '../lib/geometry/parametricMath'
import { buildHypercube, buildCross, buildHypercubeFaces, rotateInPlane, projectToR3 } from '../lib/geometry/polytopeMath'
import { marchingCubes } from '../lib/geometry/implicitMath'
import { brillouinZonePlanes } from '../lib/geometry/brillouinZone'
import {
  freeSymbols, sampleCurve3D, sampleGraph1D, sampleSurface,
  planeBasis, spanLatticeLines, vectorsToR3,
} from '../lib/geometry/analyticMath'

const mathImplicit = create(all)

// Rotación por ORIENTACIÓN del puño, 1:1: el giro de la figura corresponde al
// giro real de la mano ("como si la cogieras y la giraras con la mano"). Para
// más de ±60-80° (límite de muñeca): soltar, re-agarrar y seguir (ratchet).
const ROT_GAIN = 1.0
// Sentido de giro por eje. Pedido del usuario: INVERTIR el giro — la figura
// giraba al revés de la mano (yaw/pitch salen del frame world con y-hacia-abajo
// de imagen y se aplican en Three con y-hacia-arriba → sentido opuesto; el roll
// ya venía negado por espejo). Cada eje es un flip de una línea si alguno queda
// al revés al probar con la mano.
const ROT_SIGN_YAW = -1   // girar la palma izq/der
const ROT_SIGN_PITCH = 1  // inclinar los nudillos arriba/abajo (invertido a petición)
const ROT_SIGN_ROLL = -1  // roll de la muñeca (como un volante)
// EMA de las deltas de rotación. Más alto = seguimiento más CEÑIDO al ángulo de
// la mano (menos lag). El engine ya filtra yaw/pitch con One-Euro, así que este
// segundo paso en serie sumaba lag; 0.8 (τ ~37 ms @33fps) lo minimiza sin
// reintroducir jitter perceptible (0.4 dejaba ~90 ms, 0.6 ~50 ms).
const EMA_ROT = 0.8

/** Distinct colors auto-assigned to objects without an explicit color.
 *  HUD family — matches the app's dominant #00f0ff cyan aesthetic. */
const PALETTE = ['#00f0ff', '#64ffda', '#ffd700', '#c8f4ff', '#0059ff', '#ff8a80', '#38d5ff', '#7fa6b8']

/** Extra-dimension gradient endpoint for w-colored polytopes (HUD gold). */
const W_COLOR_FAR = '#ffd700'

/** Kinds that are meaningless without a coordinate frame → axes auto-on.
 *  Plain shapes (primitive/parametric/curve/...) stay frameless unless
 *  scene.axes is set explicitly — exact positions are the user's call. */
const ANALYTIC_KINDS = new Set(['graph', 'vectors', 'plane', 'line'])

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
  }
}

/* ---- Gesture rig: one grab/pinch controller for the whole scene ---- */

function GestureRig({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const gestureOutput = useGestureStore(s => s.output)
  const groupRef = useRef<THREE.Group>(null)
  const grabbing = useRef(false)
  const baseRot = useRef({ x: 0, y: 0, z: 0 })
  const smoothDX = useRef(0)
  const smoothDY = useRef(0)
  const smoothDA = useRef(0)

  useFrame((state) => {
    const g = groupRef.current
    if (!g) return
    // Gesture pipeline off → hands off. gestureStore.output is NOT reset when
    // the pipeline is disabled, so a stale grab/pinch 'active' flag would
    // otherwise hijack the scene rotation and fight OrbitControls' zoom.
    if (!enabled) { grabbing.current = false; return }
    // Rotación por ORIENTACIÓN del puño (no por desplazamiento): la figura gira
    // como si la tuvieras agarrada. Base capturada al enganchar; al soltar se
    // queda (sin snap-back).
    //   Z (roll)  ← roll de la palma (deltaAngle), 1:1 · ROT_SIGN_ROLL
    //   Y (yaw)   ← girar la palma izq/der (rotYaw), 1:1 · ROT_SIGN_YAW
    //   X (pitch) ← inclinar los nudillos (rotPitch), 1:1 · ROT_SIGN_PITCH
    // 1:1 real (ROT_GAIN=1.0): 20° de mano = 20° de figura. La muñeca da ±60-80°
    // cómodos; para vueltas completas, soltar, re-agarrar y seguir (ratchet).
    const grab = gestureOutput.grab
    if (grab.active) {
      if (!grabbing.current) {
        grabbing.current = true
        baseRot.current = { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z }
        smoothDX.current = 0
        smoothDY.current = 0
        smoothDA.current = 0
      }
      smoothDX.current += (grab.rotYaw - smoothDX.current) * EMA_ROT
      smoothDY.current += (grab.rotPitch - smoothDY.current) * EMA_ROT
      smoothDA.current += (grab.deltaAngle - smoothDA.current) * EMA_ROT
      g.rotation.z = baseRot.current.z + ROT_SIGN_ROLL * smoothDA.current
      g.rotation.y = baseRot.current.y + ROT_SIGN_YAW * smoothDX.current * ROT_GAIN
      g.rotation.x = baseRot.current.x + ROT_SIGN_PITCH * smoothDY.current * ROT_GAIN
    } else {
      grabbing.current = false
    }
    if (gestureOutput.pinch.active) {
      const dist = THREE.MathUtils.clamp(12 / gestureOutput.pinch.zoom, 2, 35)
      state.camera.position.setLength(dist)
    }
  })

  return <group ref={groupRef}>{children}</group>
}

/* ---- Text label sprite (canvas texture — self-contained, no font assets) ---- */

function TextLabel({ position, text, color, size = 0.55 }: { position: Vec3; text: string; color: string; size?: number }) {
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

  const { vertices: baseVertices, edges } = useMemo(() =>
    spec.type === 'hypercube' ? buildHypercube(dim) : buildCross(dim),
  [spec.type, dim])

  const faceQuads = useMemo(() =>
    showFaces && spec.type === 'hypercube' ? buildHypercubeFaces(dim) : [],
  [showFaces, spec.type, dim])

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

/* ---- Per-object dispatcher (position/rotation/scale wrapper) ---- */

function SceneObjectView({ spec, color }: { spec: Model3DSpec; color: string }) {
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
    </group>
  )
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

  return (
    <>
      <color attach="background" args={[sceneOpts.background ?? '#03080d']} />
      <ambientLight intensity={0.45} color="#00f0ff" />
      <pointLight position={[5, 8, 5]} intensity={1.2} color="#ffffff" />
      <pointLight position={[-5, -3, -5]} intensity={0.6} color="#0059ff" />
      {!gestureEnabled && <OrbitControls makeDefault enablePan={true} />}
      <GestureRig enabled={gestureEnabled}>
        {/* Math frame: math z becomes screen-up. All specs are math coordinates. */}
        <group rotation={[-Math.PI / 2, 0, 0]}>
          {showAxes && <AxesObject length={axisLength} />}
          {gridPlane && <GridObject plane={gridPlane} size={Math.ceil(axisLength) * 2} />}
          {objects.filter((o) => !hiddenIds.has(o.id!)).map((o) => (
            <SceneObjectView key={o.id} spec={o} color={colors.get(o.id!) ?? PALETTE[0]} />
          ))}
        </group>
      </GestureRig>
    </>
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
        {gestureEnabled
          ? 'Puño cerrado: rotar · Pinch: zoom · Esc: cerrar'
          : 'Arrastra: rotar · Scroll: zoom · Esc: cerrar'}
      </div>
    </div>
  )
}
