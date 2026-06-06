/**
 * Model3DViewer — full-screen overlay that renders a 3D model.
 * Driven by model3dStore (same pattern as DisplayCard).
 * Gestures: pinch = zoom (dolly), grab = multi-axis rotate (roll=Z, horizontal=Y,
 * vertical=X), 1:1 angular, persists on release.
 * Kinds: parametric surfaces, N-D polytopes (4D auto-rotates), implicit surfaces
 * (marching cubes; optional Brillouin-zone clip for Fermi surfaces).
 */

import { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useGestureStore } from '../state/gestureStore'
import { create, all } from 'mathjs'
import { useModel3dStore, type Model3DSpec, type ParametricSpec, type PolytopeSpec, type ImplicitSpec } from '../state/model3dStore'
import { evaluateParametricSurface } from '../lib/geometry/parametricMath'
import { buildHypercube, buildCross, rotateInPlane, projectToR3 } from '../lib/geometry/polytopeMath'
import { marchingCubes } from '../lib/geometry/implicitMath'
import { brillouinZonePlanes } from '../lib/geometry/brillouinZone'

const mathImplicit = create(all)

// Hand-position → rotation gain. deltaX/deltaY are wrist displacement from grab
// onset normalized by palm size; ~1 = one palm-width of travel. ROTATE_GAIN maps
// that to radians (≈ 4.0 → one palm-width ≈ 229°). Tune for comfort.
const ROTATE_GAIN = 4.0
// EMA smoothing factor for rotation deltas. Lower = smoother but more lag.
// 0.18 ≈ 93ms time-constant at 60fps — removes MediaPipe landmark jitter.
const EMA_ROT = 0.18

/* ---- Parametric surface object ---- */

function ParametricObject({ spec }: { spec: ParametricSpec }) {
  const gestureOutput = useGestureStore(s => s.output)
  const groupRef = useRef<THREE.Group>(null)
  const grabbing = useRef(false)
  const baseRot = useRef({ x: 0, y: 0, z: 0 })
  const smoothDX = useRef(0)
  const smoothDY = useRef(0)
  const smoothDA = useRef(0)

  const geometry = useMemo(() => {
    const { positions, indices } = evaluateParametricSurface(spec)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    return geo
  }, [spec])

  useFrame((state) => {
    const g = groupRef.current
    if (!g) return
    // Multi-axis 1:1 rotation. Capture base on grab onset; while grabbing:
    //   Z (roll)  ← palm roll (deltaAngle), hand rotates 20° → figure 20°
    //   Y (yaw)   ← horizontal hand travel (deltaX)
    //   X (pitch) ← vertical hand travel (deltaY)
    // Release keeps it (base only re-captured on next grab) — no snap-back.
    const grab = gestureOutput.grab
    if (grab.active) {
      if (!grabbing.current) {
        grabbing.current = true
        baseRot.current = { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z }
        smoothDX.current = 0
        smoothDY.current = 0
        smoothDA.current = 0
      }
      smoothDX.current += (grab.deltaX - smoothDX.current) * EMA_ROT
      smoothDY.current += (grab.deltaY - smoothDY.current) * EMA_ROT
      smoothDA.current += (grab.deltaAngle - smoothDA.current) * EMA_ROT
      g.rotation.z = baseRot.current.z + smoothDA.current
      g.rotation.y = baseRot.current.y + smoothDX.current * ROTATE_GAIN
      g.rotation.x = baseRot.current.x + smoothDY.current * ROTATE_GAIN
    } else {
      grabbing.current = false
    }
    if (gestureOutput.pinch.active) {
      state.camera.position.z = Math.max(2, Math.min(35, 12 / gestureOutput.pinch.zoom))
    }
  })

  const color = spec.color ?? '#38d5ff'
  return (
    <group ref={groupRef}>
      <mesh geometry={geometry}>
        <meshStandardMaterial color={color} side={THREE.DoubleSide} wireframe transparent opacity={0.85} emissive={color} emissiveIntensity={0.3} />
      </mesh>
    </group>
  )
}

/* ---- N-dimensional polytope object ---- */

function PolytopeObject({ spec }: { spec: PolytopeSpec }) {
  const gestureOutput = useGestureStore(s => s.output)
  const groupRef = useRef<THREE.Group>(null)
  const linesRef = useRef<THREE.LineSegments>(null)
  const spheresRef = useRef<THREE.InstancedMesh>(null)
  const ndAngles = useRef({ xw: 0, yw: 0, zw: 0 })
  const grabbing = useRef(false)
  const baseRot = useRef({ x: 0, y: 0, z: 0 })
  const smoothDX = useRef(0)
  const smoothDY = useRef(0)
  const smoothDA = useRef(0)

  const { vertices: baseVertices, edges } = useMemo(() =>
    spec.type === 'hypercube' ? buildHypercube(spec.dimension) : buildCross(spec.dimension),
  [spec])

  const lineGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(edges.length * 2 * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return geo
  }, [edges])

  useFrame((state, delta) => {
    const group = groupRef.current
    const lines = linesRef.current
    if (!group || !lines) return

    if (spec.dimension >= 4) {
      ndAngles.current.xw += delta * 0.28
      ndAngles.current.yw += delta * 0.19
    }
    if (spec.dimension >= 5) {
      ndAngles.current.zw += delta * 0.13
    }

    // Multi-axis 1:1 rotation (Z=palm roll, Y=horizontal travel, X=vertical
    // travel); persists on release. The 4D auto-rotation above keeps animating
    // the inner structure independently of this outer 3D orientation.
    const grab = gestureOutput.grab
    if (grab.active) {
      if (!grabbing.current) {
        grabbing.current = true
        baseRot.current = { x: group.rotation.x, y: group.rotation.y, z: group.rotation.z }
        smoothDX.current = 0
        smoothDY.current = 0
        smoothDA.current = 0
      }
      smoothDX.current += (grab.deltaX - smoothDX.current) * EMA_ROT
      smoothDY.current += (grab.deltaY - smoothDY.current) * EMA_ROT
      smoothDA.current += (grab.deltaAngle - smoothDA.current) * EMA_ROT
      group.rotation.z = baseRot.current.z + smoothDA.current
      group.rotation.y = baseRot.current.y + smoothDX.current * ROTATE_GAIN
      group.rotation.x = baseRot.current.x + smoothDY.current * ROTATE_GAIN
    } else {
      grabbing.current = false
    }

    if (gestureOutput.pinch.active) {
      state.camera.position.z = Math.max(2, Math.min(35, 12 / gestureOutput.pinch.zoom))
    }

    let verts = baseVertices
    if (spec.dimension >= 4) {
      verts = rotateInPlane(verts, 0, 3, ndAngles.current.xw)
      verts = rotateInPlane(verts, 1, 3, ndAngles.current.yw)
    }
    if (spec.dimension >= 5) {
      verts = rotateInPlane(verts, 2, 4, ndAngles.current.zw)
    }

    const projected = projectToR3(verts)

    const posAttr = lines.geometry.attributes.position as THREE.BufferAttribute
    edges.forEach(([i, j], k) => {
      const p = projected[i]
      const q = projected[j]
      posAttr.setXYZ(k * 2,     p[0], p[1], p[2])
      posAttr.setXYZ(k * 2 + 1, q[0], q[1], q[2])
    })
    posAttr.needsUpdate = true

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
    <group ref={groupRef}>
      <lineSegments ref={linesRef} geometry={lineGeo}>
        <lineBasicMaterial color="#38d5ff" transparent opacity={0.75} />
      </lineSegments>
      <instancedMesh ref={spheresRef} args={[undefined, undefined, baseVertices.length]}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshBasicMaterial color="#38d5ff" />
      </instancedMesh>
    </group>
  )
}

/* ---- Implicit surface object (marching cubes + optional Brillouin-zone clip) ---- */

function ImplicitObject({ spec }: { spec: ImplicitSpec }) {
  const gestureOutput = useGestureStore(s => s.output)
  const groupRef = useRef<THREE.Group>(null)
  const grabbing = useRef(false)
  const baseRot = useRef({ x: 0, y: 0, z: 0 })
  const smoothDX = useRef(0)
  const smoothDY = useRef(0)
  const smoothDA = useRef(0)

  // Build the isosurface mesh once per spec. mathjs compiles f(x,y,z); marching
  // cubes samples it on a grid and extracts triangles. Clipping planes (if a
  // Brillouin zone is given) trim the render to the 1st BZ — no mesh cutting.
  const { geometry, clipPlanes } = useMemo(() => {
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
  }, [spec])

  useFrame((state) => {
    const g = groupRef.current
    if (!g) return
    const grab = gestureOutput.grab
    if (grab.active) {
      if (!grabbing.current) {
        grabbing.current = true
        baseRot.current = { x: g.rotation.x, y: g.rotation.y, z: g.rotation.z }
        smoothDX.current = 0
        smoothDY.current = 0
        smoothDA.current = 0
      }
      smoothDX.current += (grab.deltaX - smoothDX.current) * EMA_ROT
      smoothDY.current += (grab.deltaY - smoothDY.current) * EMA_ROT
      smoothDA.current += (grab.deltaAngle - smoothDA.current) * EMA_ROT
      g.rotation.z = baseRot.current.z + smoothDA.current
      g.rotation.y = baseRot.current.y + smoothDX.current * ROTATE_GAIN
      g.rotation.x = baseRot.current.x + smoothDY.current * ROTATE_GAIN
    } else {
      grabbing.current = false
    }
    if (gestureOutput.pinch.active) {
      state.camera.position.z = Math.max(2, Math.min(35, 12 / gestureOutput.pinch.zoom))
    }
  })

  const color = spec.color ?? '#ffb347'
  return (
    <group ref={groupRef}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.25}
          side={THREE.DoubleSide}
          metalness={0.3}
          roughness={0.45}
          clippingPlanes={clipPlanes}
          clipShadows
        />
      </mesh>
    </group>
  )
}

/* ---- Scene wrapper ---- */

function Scene({ spec }: { spec: Model3DSpec }) {
  return (
    <>
      <color attach="background" args={['#060d12']} />
      <ambientLight intensity={0.4} color="#38d5ff" />
      <pointLight position={[5, 5, 5]} intensity={1.2} color="#ffffff" />
      <pointLight position={[-5, -3, -5]} intensity={0.6} color="#0059ff" />
      {spec.kind === 'parametric' && <ParametricObject spec={spec} />}
      {spec.kind === 'polytope' && <PolytopeObject spec={spec} />}
      {spec.kind === 'implicit' && <ImplicitObject spec={spec} />}
    </>
  )
}

/* ---- Overlay wrapper ---- */

export function Model3DViewer() {
  const open = useModel3dStore(s => s.open)
  const spec = useModel3dStore(s => s.spec)
  const hide = useModel3dStore(s => s.hide)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hide])

  if (!open || !spec) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 5000,
      background: 'rgba(4, 10, 16, 0.96)',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px', color: '#38d5ff', fontSize: 13, letterSpacing: 1,
        textTransform: 'uppercase', borderBottom: '1px solid rgba(56,213,255,0.2)',
      }}>
        <span>{spec.title ?? (spec.kind === 'polytope' ? `${spec.dimension}D ${spec.type}` : spec.kind === 'implicit' ? 'Isosuperficie' : 'Superficie')}</span>
        <button
          onClick={hide}
          style={{ background: 'transparent', border: 'none', color: '#7fa6b8', cursor: 'pointer', fontSize: 20 }}
          aria-label="Cerrar"
        >×</button>
      </div>
      <div style={{ flex: 1 }}>
        <Canvas camera={{ position: [0, 0, 12], fov: 40 }} gl={{ localClippingEnabled: true }}>
          <Scene spec={spec} />
        </Canvas>
      </div>
      <div style={{
        padding: '6px 20px', color: 'rgba(56,213,255,0.4)', fontSize: 11,
        borderTop: '1px solid rgba(56,213,255,0.1)',
        textAlign: 'center',
      }}>
        Puño cerrado: rotar · Pinch: zoom · Esc: cerrar
      </div>
    </div>
  )
}
