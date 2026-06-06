import { useRef, useMemo, useState, Suspense, Component } from 'react'
import type { ReactNode } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Float, Html, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { useJarvisStore } from '../state/jarvisStore'
import { useSystemStore } from '../state/systemStore'
import { PINCH_SCALE_MULTIPLIER, PINCH_APPROACH_DISTANCE, PINCH_DISSOLVE_START } from '../gestures/config'
import { modeMeta } from '../constants'
import type { Mode } from '../types'

/* ─────────────────────────────────────────────────────────────
   Carousel layout
   - Camera fixed at origin, looking down -Z, fov=72.
   - Holograms ride a single rotating <group>; per-frame each
     hologram derives its radius/scale/opacity from how close its
     slot is to the front (focus = max(0, cos(angleFromFront))).
───────────────────────────────────────────────────────────── */

const R_ACTIVE = 4
const R_IDLE   = 7

const MAIN_ORDER: Mode[] = ['home', 'house', 'system', 'cloud', 'utils']
const SUB_ORDER:  Mode[] = ['plan3d', 'space', 'plan2d']
const UTILS_SUB_ORDER: Mode[] = ['timer', 'chrono']

// Snap angle (radians, clockwise from front) for each main slot.
// 5 slots equally spaced (2π/5) — adding utils redistributed the existing 4.
const TAU_5 = (2 * Math.PI) / 5
const MAIN_ANGLES: Record<Mode, number> = {
  home:   0,
  house:  TAU_5,
  system: 2 * TAU_5,
  cloud:  3 * TAU_5,
  utils:  4 * TAU_5,
  plan3d: 0, plan2d: 0, space: 0, // unused at main level
  mobile: 0, timer: 0, chrono: 0, // unused at main level
}
const SUB_ANGLES: Record<'plan3d'|'space'|'plan2d', number> = {
  plan3d: 0,
  space:  (2 * Math.PI) / 3,
  plan2d: (4 * Math.PI) / 3,
}
// Utils sub-ring: 2 slots facing front-back so the camera rotation feels
// like flipping a coin between timer and chrono.
const UTILS_ANGLES: Record<'timer'|'chrono', number> = {
  timer:  0,
  chrono: Math.PI,
}

// Wrap an angle into [-π, π] so abs() gives shortest-path delta.
function wrapPi(a: number): number {
  const TAU = Math.PI * 2
  let r = a % TAU
  if (r >  Math.PI) r -= TAU
  if (r < -Math.PI) r += TAU
  return r
}

/* ─────────────────────────────────────────────────────────────
   Cosmic background — 800 star particles
───────────────────────────────────────────────────────────── */
function CosmicBackground() {
  const ref = useRef<THREE.Points>(null)
  const positions = useMemo(() => {
    const arr = new Float32Array(800 * 3)
    for (let i = 0; i < 800; i++) {
      const r = 22 + Math.random() * 10
      const θ = Math.random() * Math.PI * 2
      const φ = Math.acos(2 * Math.random() - 1)
      arr[i * 3]     = r * Math.sin(φ) * Math.cos(θ)
      arr[i * 3 + 1] = r * Math.sin(φ) * Math.sin(θ)
      arr[i * 3 + 2] = r * Math.cos(φ)
    }
    return arr
  }, [])

  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += 0.00015 * delta * 60
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#00f0ff" size={0.018} transparent opacity={0.38} sizeAttenuation />
    </points>
  )
}

/* ─────────────────────────────────────────────────────────────
   HOME — Neural Fire Network
   48 nodes on a Fibonacci sphere; firing propagates through edges.
   Firing rate scales with AI workload from systemStore.
───────────────────────────────────────────────────────────── */
const N_NODES = 48

function NeuralFireGeo({ active }: { active: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const instRef  = useRef<THREE.InstancedMesh>(null)
  const dummy    = useMemo(() => new THREE.Object3D(), [])
  const color    = useMemo(() => new THREE.Color(), [])

  const tokensWindow5h = useSystemStore(s => s.tokensWindow5h)
  const activeModel    = useSystemStore(s => s.activeModel)
  const modelStats     = useSystemStore(s => s.modelStats)

  const fireInterval = useMemo(() => {
    const tokens      = tokensWindow5h ?? 0
    const tokenFactor = Math.min(1.0, tokens / 100000)
    const name        = activeModel.toLowerCase()
    const modelWeight = name.includes('opus')   ? 1.0
      : name.includes('sonnet') ? 0.6
      : name.includes('haiku')  ? 0.3 : 0.15
    const reqFactor = Math.min(1.0, (modelStats.requestsPerHour ?? 0) / 100)
    const load      = Math.max(tokenFactor, modelWeight * 0.5, reqFactor)
    return Math.max(0.25, 3.0 - load * 2.75)
  }, [tokensWindow5h, activeModel, modelStats.requestsPerHour])

  const nodes = useMemo(() => {
    const goldenAngle = Math.PI * (3 - Math.sqrt(5))
    return Array.from({ length: N_NODES }, (_, i) => {
      const y      = 1 - (i / (N_NODES - 1)) * 2
      const radius = Math.sqrt(Math.max(0, 1 - y * y))
      const theta  = goldenAngle * i
      return new THREE.Vector3(
        Math.cos(theta) * radius * 1.15,
        y * 1.15,
        Math.sin(theta) * radius * 1.15
      )
    })
  }, [])

  const edges = useMemo(() => {
    const result: [number, number][] = []
    for (let i = 0; i < N_NODES; i++) {
      for (let j = i + 1; j < N_NODES; j++) {
        if (nodes[i].distanceTo(nodes[j]) < 0.82) result.push([i, j])
      }
    }
    return result
  }, [nodes])

  const edgeLinesObj = useMemo(() => {
    const positions: number[] = []
    edges.forEach(([a, b]) => {
      positions.push(nodes[a].x, nodes[a].y, nodes[a].z)
      positions.push(nodes[b].x, nodes[b].y, nodes[b].z)
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: '#00f0ff', transparent: true, opacity: 0.12 })
    )
  }, [edges, nodes])

  const firingTime   = useRef<number[]>(Array(N_NODES).fill(-Infinity))
  const pendingFires = useRef<{ idx: number; at: number }[]>([])
  const nextFireAt   = useRef(1.0)
  const FIRE_DURATION = 0.45

  useFrame((state, delta) => {
    if (!groupRef.current || !instRef.current) return

    groupRef.current.rotation.y += 0.003 * delta * 60

    const t    = state.clock.elapsedTime
    const rotY = groupRef.current.rotation.y
    const cosR = Math.cos(rotY)
    const sinR = Math.sin(rotY)

    pendingFires.current = pendingFires.current.filter(f => {
      if (t >= f.at) { firingTime.current[f.idx] = t; return false }
      return true
    })

    if (t > nextFireAt.current) {
      const idx = Math.floor(Math.random() * N_NODES)
      firingTime.current[idx] = t
      edges.forEach(([a, b]) => {
        if (a === idx || b === idx) {
          const neighbor = a === idx ? b : a
          pendingFires.current.push({ idx: neighbor, at: t + 0.08 + Math.random() * 0.14 })
        }
      })
      nextFireAt.current = t + (active ? fireInterval * 0.55 : fireInterval)
    }

    for (let i = 0; i < N_NODES; i++) {
      const age      = t - firingTime.current[i]
      const isFiring = age < FIRE_DURATION
      const fireFrac = isFiring ? Math.max(0, 1 - age / FIRE_DURATION) : 0

      // Depth scale: nodes closer to camera (positive rotated-Z) appear larger.
      const localZ   = -nodes[i].x * sinR + nodes[i].z * cosR
      const depthMod = 1.0 + localZ * 0.14

      const baseScale = isFiring ? 0.55 + 0.55 * fireFrac : 0.38
      dummy.position.copy(nodes[i])
      dummy.scale.setScalar(baseScale * Math.max(0.4, depthMod))
      dummy.updateMatrix()
      instRef.current.setMatrixAt(i, dummy.matrix)

      if (isFiring) {
        color.setRGB(0.5 + 0.5 * fireFrac, 1.0, 1.0)
      } else {
        color.setRGB(0.03, 0.28 + localZ * 0.04, 0.38 + localZ * 0.05)
      }
      instRef.current.setColorAt(i, color)
    }

    instRef.current.instanceMatrix.needsUpdate = true
    if (instRef.current.instanceColor) instRef.current.instanceColor.needsUpdate = true
  })

  return (
    <group ref={groupRef}>
      <primitive object={edgeLinesObj} />
      <instancedMesh ref={instRef} args={[undefined, undefined, N_NODES]}>
        <sphereGeometry args={[0.055, 8, 8]} />
        <meshStandardMaterial color="#ffffff" emissive="#00f0ff" emissiveIntensity={1.4} toneMapped={false} />
      </instancedMesh>
      <mesh>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.18} />
      </mesh>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   HOUSE — Tower GLB with hologram material
   Falls back to a wireframe box if the model is unavailable.
───────────────────────────────────────────────────────────── */
function HouseGeoFallback({ active }: { active: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const win1 = useRef<THREE.Mesh>(null)
  const win2 = useRef<THREE.Mesh>(null)

  useFrame((state, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += 0.006 * delta * 60
    const pulse = 1.5 + Math.sin(state.clock.elapsedTime * 2.2) * 0.8 + (active ? 1.5 : 0)
    if (win1.current) (win1.current.material as THREE.MeshStandardMaterial).emissiveIntensity = pulse
    if (win2.current) (win2.current.material as THREE.MeshStandardMaterial).emissiveIntensity = pulse
  })

  return (
    <group ref={groupRef}>
      <mesh>
        <boxGeometry args={[2.8, 1.6, 2.0]} />
        <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.45} />
      </mesh>
      <mesh position={[0, 1.4, 0]} rotation={[0, Math.PI / 4, 0]}>
        <coneGeometry args={[2.1, 1.2, 4, 1, true]} />
        <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.38} />
      </mesh>
      <mesh ref={win1} position={[-0.6, 0.2, 1.01]}>
        <planeGeometry args={[0.55, 0.45]} />
        <meshStandardMaterial emissive="#00aaff" emissiveIntensity={1.5} color="#001830" transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={win2} position={[0.6, 0.2, 1.01]}>
        <planeGeometry args={[0.55, 0.45]} />
        <meshStandardMaterial emissive="#00aaff" emissiveIntensity={1.5} color="#001830" transparent opacity={0.9} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

// Relative URL (no leading slash) so it resolves against index.html in both
// dev and the packaged .exe. A leading slash would resolve to the file://
// drive root in production (file:///C:/models/...) and 404.
const TOWER_MODEL_URL = 'models/tower.glb'

function TowerGeoInner({ active }: { active: boolean }) {
  const { scene } = useGLTF(TOWER_MODEL_URL)
  const groupRef  = useRef<THREE.Group>(null)

  const { cloned, materials } = useMemo(() => {
    const cloned    = scene.clone(true)
    const materials: THREE.MeshStandardMaterial[] = []

    const box    = new THREE.Box3().setFromObject(cloned)
    const size   = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const scale  = 2.4 / Math.max(size.x, size.y, size.z, 0.01)

    cloned.scale.setScalar(scale)
    cloned.position.set(-center.x * scale, -center.y * scale, -center.z * scale)

    cloned.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        const mat = new THREE.MeshStandardMaterial({
          emissive:          new THREE.Color('#00aaff'),
          emissiveIntensity: 1.8,
          color:             new THREE.Color('#001a30'),
          transparent:       true,
          opacity:           0.88,
        })
        obj.material = mat
        materials.push(mat)
      }
    })
    return { cloned, materials }
  }, [scene])

  useFrame((state, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += 0.005 * delta * 60
    const pulse = 1.8 + Math.sin(state.clock.elapsedTime * 1.8) * 0.6 + (active ? 1.2 : 0)
    materials.forEach(m => { m.emissiveIntensity = pulse })
  })

  return (
    <group ref={groupRef}>
      <primitive object={cloned} />
    </group>
  )
}

// drei's useGLTF throws synchronously when the model 404s, and Suspense only
// catches loading promises — not thrown errors. Without this boundary a
// missing/corrupt .glb crashes the whole React tree (transparent window).
class GltfErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: Error) { console.warn('[gltf] load failed, using fallback:', err.message) }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function TowerGeo({ active }: { active: boolean }) {
  const fallback = <HouseGeoFallback active={active} />
  return (
    <GltfErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <TowerGeoInner active={active} />
      </Suspense>
    </GltfErrorBoundary>
  )
}

/* ─────────────────────────────────────────────────────────────
   PLAN2D — Living Blueprint (unchanged)
───────────────────────────────────────────────────────────── */
function Plan2DGeo({ active }: { active: boolean }) {
  const gridGeoRef = useRef<THREE.BufferGeometry>(null)
  const groupRef   = useRef<THREE.Group>(null)
  const N = 18

  const basePositions = useMemo(() => {
    const arr = new Float32Array(N * N * 3)
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const idx = (i * N + j) * 3
      arr[idx]     = (i / (N - 1) - 0.5) * 4.2
      arr[idx + 1] = 0
      arr[idx + 2] = (j / (N - 1) - 0.5) * 4.2
    }
    return arr
  }, [])

  const animPositions = useMemo(() => new Float32Array(N * N * 3), [])

  useFrame((state, delta) => {
    if (!gridGeoRef.current) return
    if (groupRef.current) groupRef.current.rotation.y += 0.004 * delta * 60

    const t = state.clock.elapsedTime
    const amp = active ? 0.22 : 0.12
    for (let i = 0; i < N * N; i++) {
      const x = basePositions[i * 3]
      const z = basePositions[i * 3 + 2]
      animPositions[i * 3]     = x
      animPositions[i * 3 + 1] = amp * Math.sin(x * 1.8 + t * 0.9) * Math.cos(z * 1.4 + t * 0.7)
      animPositions[i * 3 + 2] = z
    }
    gridGeoRef.current.setAttribute('position', new THREE.BufferAttribute(animPositions, 3))
    gridGeoRef.current.attributes.position.needsUpdate = true
  })

  const wallLines = useMemo(() => [
    [new THREE.Vector3(-1.5, 0, -1), new THREE.Vector3(1.5, 0, -1)],
    [new THREE.Vector3(1.5, 0, -1), new THREE.Vector3(1.5, 0, 0.8)],
    [new THREE.Vector3(-1.5, 0, -1), new THREE.Vector3(-1.5, 0, 0.8)],
    [new THREE.Vector3(-0.2, 0, 0.8), new THREE.Vector3(1.5, 0, 0.8)],
  ].map(pts => new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: '#00f0ff', linewidth: 2 })
  )), [])

  return (
    <group ref={groupRef} rotation={[0.25, 0, 0]}>
      <points>
        <bufferGeometry ref={gridGeoRef}>
          <bufferAttribute attach="attributes-position" args={[basePositions, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#00f0ff" size={0.055} transparent opacity={0.7} sizeAttenuation />
      </points>
      {wallLines.map((ln, i) => <primitive key={i} object={ln} />)}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[4.5, 4.5]} />
        <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.08} />
      </mesh>
      {[[-2.25, 0, 0], [2.25, 0, 0], [0, 0, -2.25], [0, 0, 2.25]].map((pos, i) => (
        <mesh key={i} position={pos as [number,number,number]}
          rotation={[0, i < 2 ? Math.PI / 2 : 0, 0]}>
          <boxGeometry args={[4.5, 0.02, 0.02]} />
          <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={1.5} color="#000" />
        </mesh>
      ))}
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   PLAN3D — Architecture Stack (unchanged)
───────────────────────────────────────────────────────────── */
function Plan3DGeo({ active }: { active: boolean }) {
  const groupRef   = useRef<THREE.Group>(null)
  const wallsRef   = useRef<THREE.Group>(null)
  const scaleRef   = useRef(0)

  useFrame((state, delta) => {
    if (!groupRef.current || !wallsRef.current) return
    groupRef.current.rotation.y += 0.007 * delta * 60

    scaleRef.current = (scaleRef.current + delta * (active ? 0.45 : 0.25)) % 1.0
    const wallScale = scaleRef.current < 0.85 ? scaleRef.current / 0.85 : 1 - (scaleRef.current - 0.85) / 0.15
    wallsRef.current.scale.setY(wallScale)

    wallsRef.current.children.forEach((child, i) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial
        if (mat.emissive) {
          mat.emissiveIntensity = 0.8 + 0.4 * Math.sin(state.clock.elapsedTime * 2 + i * 0.8)
        }
      }
    })
  })

  const floors = [-0.9, 0, 0.9]

  return (
    <group ref={groupRef}>
      {floors.map((y, i) => (
        <group key={i}>
          <mesh position={[0, y, 0]}>
            <boxGeometry args={[2.4, 0.06, 1.8]} />
            <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={0.6} color="#001520" transparent opacity={0.7} />
          </mesh>
          <mesh position={[0, y, 0]}>
            <boxGeometry args={[2.4, 0.07, 1.8]} />
            <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.5} />
          </mesh>
        </group>
      ))}
      <group ref={wallsRef} position={[0, -0.9, 0]}>
        {[[-1.17, 0.9], [1.17, 0.9], [-1.17, -0.9 + 0.03], [1.17, -0.9 + 0.03]].map(([x, z], i) => (
          <mesh key={i} position={[x as number, 0.9, z as number]}>
            <boxGeometry args={[0.06, 1.86, 0.06]} />
            <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={1} color="#001520" />
          </mesh>
        ))}
        {[
          { pos: [0, 0.9, 0.9] as [number,number,number], rot: [0,0,0] as [number,number,number], w: 2.4, h: 1.86 },
          { pos: [0, 0.9,-0.9] as [number,number,number], rot: [0,0,0] as [number,number,number], w: 2.4, h: 1.86 },
          { pos: [-1.2, 0.9, 0] as [number,number,number], rot: [0,Math.PI/2,0] as [number,number,number], w: 1.86, h: 1.86 },
          { pos: [ 1.2, 0.9, 0] as [number,number,number], rot: [0,Math.PI/2,0] as [number,number,number], w: 1.86, h: 1.86 },
        ].map(({ pos, rot, w, h }, i) => (
          <mesh key={i} position={pos} rotation={rot}>
            <planeGeometry args={[w, h, 4, 4]} />
            <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.25} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   SPACE — Infinity Portal (unchanged)
───────────────────────────────────────────────────────────── */
function SpaceGeo({ active }: { active: boolean }) {
  const ringRef   = useRef<THREE.Mesh>(null)
  const arcRef    = useRef<THREE.Mesh>(null)
  const instRef   = useRef<THREE.InstancedMesh>(null)
  const dummy     = useMemo(() => new THREE.Object3D(), [])
  const angles    = useRef(Array.from({ length: 60 }, (_, i) => (i / 60) * Math.PI * 2))

  useFrame((state, delta) => {
    if (!ringRef.current) return
    ringRef.current.rotation.z += 0.008 * delta * 60 * (active ? 1.8 : 1)
    if (arcRef.current) arcRef.current.rotation.z -= 0.015 * delta * 60

    const mat = ringRef.current.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = (active ? 4 : 2.5) + Math.sin(state.clock.elapsedTime * 2) * 0.5

    if (instRef.current) {
      const spd = active ? 1.4 : 0.6
      angles.current = angles.current.map(a => a + spd * delta)
      angles.current.forEach((a, i) => {
        const r = 1.05 + (i % 3) * 0.06
        const tilt = (i % 5) * 0.08
        dummy.position.set(Math.cos(a) * r, Math.sin(a) * r * Math.cos(tilt), Math.sin(a) * r * Math.sin(tilt))
        dummy.updateMatrix()
        instRef.current!.setMatrixAt(i, dummy.matrix)
      })
      instRef.current.instanceMatrix.needsUpdate = true
    }
  })

  return (
    <group rotation={[0.25, 0, 0]}>
      <mesh ref={ringRef}>
        <torusGeometry args={[1.1, 0.065, 20, 140]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={3} color="#001520" />
      </mesh>
      <mesh>
        <circleGeometry args={[1.03, 64]} />
        <meshBasicMaterial color="#0044aa" transparent opacity={0.18} side={THREE.DoubleSide} />
      </mesh>
      <mesh>
        <circleGeometry args={[0.6, 32]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.06} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={arcRef}>
        <torusGeometry args={[0.95, 0.008, 8, 80]} />
        <meshBasicMaterial color="#0059ff" transparent opacity={0.5} />
      </mesh>
      <instancedMesh ref={instRef} args={[undefined, undefined, 60]}>
        <sphereGeometry args={[0.022, 6, 6]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={5} color="#001520" />
      </instancedMesh>
      {[0, Math.PI / 2].map((rot, i) => (
        <mesh key={i} rotation={[0, 0, rot]}>
          <boxGeometry args={[2.5, 0.008, 0.008]} />
          <meshBasicMaterial color="#00f0ff" transparent opacity={0.15} />
        </mesh>
      ))}
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   CLOUD — Hex Torus Ring
   Two hexagonal-section tori + orbital particle bands + nodes.
───────────────────────────────────────────────────────────── */
function HexTorusGeo({ active }: { active: boolean }) {
  const ring1Ref = useRef<THREE.Mesh>(null)
  const ring2Ref = useRef<THREE.Mesh>(null)
  const instRef  = useRef<THREE.InstancedMesh>(null)
  const dummy    = useMemo(() => new THREE.Object3D(), [])

  const N_PART = 120
  const partAngles = useRef(Array.from({ length: N_PART }, (_, i) => (i / N_PART) * Math.PI * 2))

  useFrame((state, delta) => {
    const spd = active ? 1.5 : 0.6
    if (ring1Ref.current) ring1Ref.current.rotation.z += 0.006 * spd * delta * 60
    if (ring2Ref.current) ring2Ref.current.rotation.x += 0.004 * spd * delta * 60

    if (instRef.current) {
      partAngles.current = partAngles.current.map(a => a + 0.35 * spd * delta)
      partAngles.current.forEach((a, i) => {
        if (i < 60) {
          // Band 0: orbit in XZ plane.
          const r = 0.95
          dummy.position.set(Math.cos(a) * r, 0, Math.sin(a) * r)
        } else {
          // Band 1: orbit tilted 60° around X axis.
          const r  = 0.70
          const lx = Math.cos(a) * r
          const ly = Math.sin(a) * r
          dummy.position.set(lx, ly * 0.5, ly * 0.866)
        }
        const s = 0.045 + 0.02 * Math.sin(state.clock.elapsedTime * 3 + i * 0.25)
        dummy.scale.setScalar(s)
        dummy.updateMatrix()
        instRef.current!.setMatrixAt(i, dummy.matrix)
      })
      instRef.current.instanceMatrix.needsUpdate = true
    }
  })

  const nodePos = useMemo(() =>
    Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2
      return [Math.cos(a) * 0.96, 0, Math.sin(a) * 0.96] as [number, number, number]
    }), [])

  return (
    <group>
      <mesh ref={ring1Ref}>
        <torusGeometry args={[0.9, 0.06, 6, 24]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={active ? 3.5 : 2.0} color="#001520" />
      </mesh>
      <mesh ref={ring2Ref} rotation={[Math.PI / 3, 0, 0]}>
        <torusGeometry args={[0.65, 0.03, 6, 18]} />
        <meshBasicMaterial color="#0059ff" transparent opacity={0.55} />
      </mesh>
      {nodePos.map((pos, i) => (
        <mesh key={i} position={pos}>
          <octahedronGeometry args={[0.06, 0]} />
          <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={2.2} color="#001520" />
        </mesh>
      ))}
      <instancedMesh ref={instRef} args={[undefined, undefined, N_PART]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={4.5} color="#001520" />
      </instancedMesh>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   UTILS — Concentric Rings (placeholder for sub-ring entrance).
   A subtle stack of co-axial rings that rotate around each other —
   reads as "tools / utilities" without competing with the others.
───────────────────────────────────────────────────────────── */
function UtilsGeo({ active }: { active: boolean }) {
  const r1 = useRef<THREE.Mesh>(null)
  const r2 = useRef<THREE.Mesh>(null)
  const r3 = useRef<THREE.Mesh>(null)
  const coreRef = useRef<THREE.Mesh>(null)

  useFrame((state, delta) => {
    const spd = active ? 1.8 : 0.9
    if (r1.current) r1.current.rotation.x += 0.010 * spd * delta * 60
    if (r2.current) r2.current.rotation.y += 0.012 * spd * delta * 60
    if (r3.current) r3.current.rotation.z += 0.008 * spd * delta * 60
    if (coreRef.current) {
      const mat = coreRef.current.material as THREE.MeshStandardMaterial
      mat.emissiveIntensity = (active ? 3.5 : 2.0) + Math.sin(state.clock.elapsedTime * 2) * 0.5
    }
  })

  return (
    <group>
      <mesh ref={coreRef}>
        <icosahedronGeometry args={[0.4, 0]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={2.5} color="#001520" wireframe />
      </mesh>
      <mesh ref={r1}>
        <torusGeometry args={[0.85, 0.014, 8, 60]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.55} />
      </mesh>
      <mesh ref={r2} rotation={[0, 0, Math.PI / 3]}>
        <torusGeometry args={[1.10, 0.011, 8, 60]} />
        <meshBasicMaterial color="#0059ff" transparent opacity={0.45} />
      </mesh>
      <mesh ref={r3} rotation={[Math.PI / 4, 0, 0]}>
        <torusGeometry args={[1.40, 0.009, 8, 60]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.30} />
      </mesh>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   TIMER — Clock face with sweeping hand.
   Bezel of tick marks + a single radial line rotating at variable speed.
───────────────────────────────────────────────────────────── */
function TimerGeo({ active }: { active: boolean }) {
  const handRef = useRef<THREE.Mesh>(null)
  const ringRef = useRef<THREE.Mesh>(null)

  const tickLines = useMemo(() => Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    const r1 = 0.95
    const r2 = i % 3 === 0 ? 1.15 : 1.05
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * r1, Math.sin(a) * r1, 0),
        new THREE.Vector3(Math.cos(a) * r2, Math.sin(a) * r2, 0),
      ]),
      new THREE.LineBasicMaterial({ color: '#00f0ff', transparent: true, opacity: i % 3 === 0 ? 0.9 : 0.45 })
    )
  }), [])

  useFrame((state, delta) => {
    const spd = active ? 1.6 : 0.7
    if (handRef.current) handRef.current.rotation.z -= 0.5 * spd * delta
    if (ringRef.current) {
      const mat = ringRef.current.material as THREE.MeshStandardMaterial
      mat.emissiveIntensity = (active ? 3.5 : 2.0) + Math.sin(state.clock.elapsedTime * 2.5) * 0.4
    }
  })

  return (
    <group rotation={[0.15, 0, 0]}>
      <mesh ref={ringRef}>
        <torusGeometry args={[1.0, 0.05, 12, 64]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={2.5} color="#001520" />
      </mesh>
      <mesh>
        <circleGeometry args={[0.95, 64]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.07} side={THREE.DoubleSide} />
      </mesh>
      {tickLines.map((ln, i) => <primitive key={i} object={ln} />)}
      <mesh ref={handRef}>
        <boxGeometry args={[0.05, 0.85, 0.02]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={4.5} color="#001520" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.08, 16, 16]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={4} color="#001520" />
      </mesh>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   CHRONO — Stopwatch with split rings and a fast-spinning hand.
───────────────────────────────────────────────────────────── */
function ChronoGeo({ active }: { active: boolean }) {
  const handRef = useRef<THREE.Mesh>(null)
  const innerRef = useRef<THREE.Mesh>(null)

  const subTicks = useMemo(() => Array.from({ length: 60 }, (_, i) => {
    const a = (i / 60) * Math.PI * 2
    const r1 = 0.84
    const r2 = i % 5 === 0 ? 0.97 : 0.91
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * r1, Math.sin(a) * r1, 0),
        new THREE.Vector3(Math.cos(a) * r2, Math.sin(a) * r2, 0),
      ]),
      new THREE.LineBasicMaterial({ color: '#00f0ff', transparent: true, opacity: i % 5 === 0 ? 0.85 : 0.30 })
    )
  }), [])

  useFrame((state, delta) => {
    const spd = active ? 3.5 : 1.4
    if (handRef.current) handRef.current.rotation.z -= 2.4 * spd * delta
    if (innerRef.current) {
      const mat = innerRef.current.material as THREE.MeshStandardMaterial
      mat.emissiveIntensity = (active ? 4.0 : 2.2) + Math.sin(state.clock.elapsedTime * 4) * 0.6
    }
  })

  return (
    <group rotation={[0.15, 0, 0]}>
      <mesh position={[0, 1.1, 0]}>
        <boxGeometry args={[0.25, 0.18, 0.05]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={2.5} color="#001520" />
      </mesh>
      <mesh ref={innerRef}>
        <torusGeometry args={[0.95, 0.06, 12, 64]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={3} color="#001520" />
      </mesh>
      <mesh>
        <torusGeometry args={[1.05, 0.012, 6, 64]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.45} />
      </mesh>
      {subTicks.map((ln, i) => <primitive key={i} object={ln} />)}
      <mesh ref={handRef}>
        <boxGeometry args={[0.04, 0.78, 0.02]} />
        <meshStandardMaterial emissive="#ff8a00" emissiveIntensity={5} color="#1a0a00" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshStandardMaterial emissive="#ff8a00" emissiveIntensity={4} color="#1a0a00" />
      </mesh>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   SYSTEM — Hex Die Core
   Central hex plate + 3 nested hex frames + pins + orbital tori.
───────────────────────────────────────────────────────────── */
function HexDieGeo({ active }: { active: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const dieRef   = useRef<THREE.Mesh>(null)
  const ring1Ref = useRef<THREE.Mesh>(null)
  const ring2Ref = useRef<THREE.Mesh>(null)
  const microRef = useRef<THREE.InstancedMesh>(null)
  const dummy    = useMemo(() => new THREE.Object3D(), [])

  const hexFrames = useMemo(() => [0.65, 1.05, 1.45].map((r, i) => {
    const geo   = new THREE.CylinderGeometry(r, r, 0.02, 6)
    const edges = new THREE.EdgesGeometry(geo)
    return new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: '#00f0ff', transparent: true, opacity: 0.55 - i * 0.1 })
    )
  }), [])

  const pinLines = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const angle = (i / 6) * Math.PI * 2
    const end   = new THREE.Vector3(Math.cos(angle) * 1.4, 0, Math.sin(angle) * 1.4)
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), end]),
      new THREE.LineBasicMaterial({ color: '#00f0ff', transparent: true, opacity: 0.38 })
    )
  }), [])

  useFrame((state, delta) => {
    const spd = active ? 2.0 : 1.0
    if (groupRef.current) groupRef.current.rotation.y += 0.007 * spd * delta * 60
    if (ring1Ref.current) ring1Ref.current.rotation.z += 0.012 * spd * delta * 60
    if (ring2Ref.current) ring2Ref.current.rotation.x += 0.008 * spd * delta * 60

    if (dieRef.current) {
      const mat = dieRef.current.material as THREE.MeshStandardMaterial
      const t   = state.clock.elapsedTime
      const dig = Math.floor(t * 3) % 2 === 0 ? 3.5 : 1.8
      mat.emissiveIntensity = THREE.MathUtils.lerp(mat.emissiveIntensity, active ? 5.5 : dig, delta * 7)
    }

    if (microRef.current) {
      const t = state.clock.elapsedTime
      for (let i = 0; i < 12; i++) {
        const angle = ((i % 6) / 6) * Math.PI * 2
        const r     = i < 6 ? 1.4 : 1.05
        dummy.position.set(Math.cos(angle) * r, 0, Math.sin(angle) * r)
        dummy.scale.setScalar(0.055 + 0.02 * Math.sin(t * 4 + i * 0.6))
        dummy.updateMatrix()
        microRef.current.setMatrixAt(i, dummy.matrix)
      }
      microRef.current.instanceMatrix.needsUpdate = true
    }
  })

  return (
    <group ref={groupRef} rotation={[Math.PI / 8, 0, 0]}>
      <mesh ref={dieRef}>
        <cylinderGeometry args={[0.38, 0.38, 0.07, 6]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={2.5} color="#001520" />
      </mesh>
      <mesh>
        <cylinderGeometry args={[0.40, 0.40, 0.085, 6]} />
        <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.45} />
      </mesh>
      {hexFrames.map((ln, i) => <primitive key={i} object={ln} />)}
      {pinLines.map((ln, i) => <primitive key={i} object={ln} />)}
      <instancedMesh ref={microRef} args={[undefined, undefined, 12]}>
        <boxGeometry args={[0.07, 0.07, 0.07]} />
        <meshStandardMaterial emissive="#00f0ff" emissiveIntensity={3} color="#001520" />
      </instancedMesh>
      <mesh ref={ring1Ref}>
        <torusGeometry args={[1.1, 0.012, 6, 48]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.55} />
      </mesh>
      <mesh ref={ring2Ref} rotation={[Math.PI / 3, 0, 0]}>
        <torusGeometry args={[1.55, 0.009, 6, 48]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.35} />
      </mesh>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   RingGroup — owns the lerped rotation.y. Children render at
   fixed local angles; the group spins them past the camera.
───────────────────────────────────────────────────────────── */
interface RingGroupProps {
  targetAngle: number
  initialAngle?: number
  children: React.ReactNode
}
function RingGroup({ targetAngle, initialAngle, children }: RingGroupProps) {
  const groupRef = useRef<THREE.Group>(null)
  const angleRef = useRef(initialAngle ?? targetAngle)

  useFrame((_, delta) => {
    if (!groupRef.current) return
    // Damping pattern from the original CameraController, multiplied for a ~350ms settle.
    const k = 1 - Math.pow(0.005, delta)
    // Choose the shortest-path delta so we never spin the long way around.
    const diff = wrapPi(targetAngle - angleRef.current)
    angleRef.current += diff * k * 6
    groupRef.current.rotation.y = angleRef.current
  })

  return <group ref={groupRef}>{children}</group>
}

/* ─────────────────────────────────────────────────────────────
   RingHologram — wraps a single geometry inside a RingGroup.
   Per-frame computes focus from how close its slot is to front,
   then sets position/scale/opacity/visibility.

   The slotAngle is the hologram's fixed angle inside the rotating
   container. Front of camera is at container-local angle 0.
───────────────────────────────────────────────────────────── */
interface RingHologramProps {
  mode: Mode
  slotAngle: number
  containerAngleRef: { current: number }
  // When true, lerps in from origin (0,0,0) on mount. Used by sub-ring entrance.
  springEntrance?: boolean
  onSelect: (mode: Mode) => void
  onActivate: (mode: Mode) => void
  isActive: boolean
  children: React.ReactNode
}
function RingHologram({
  mode, slotAngle, containerAngleRef,
  springEntrance, onSelect, onActivate, isActive, children,
}: RingHologramProps) {
  const groupRef = useRef<THREE.Group>(null)
  const matRef = useRef<{ scale: number }>({ scale: springEntrance ? 0.1 : 0.65 })
  const [hovered, setHovered] = useState(false)
  const pinchZoomProgress = useJarvisStore(s => s.pinchZoomProgress)
  // For the sub-ring spring entrance we lerp in from origin to the slot.
  const springRef = useRef(new THREE.Vector3(0, 0, 0))
  const springStartedRef = useRef(!springEntrance)

  useFrame((_, delta) => {
    if (!groupRef.current) return

    // Slot at local angle α + container Y-rotation β puts the hologram at world
    // angle (α - β) from -Z (see derivation in RingController). Front sits at 0,
    // so angleFromFront = |wrapPi(slotAngle - containerAngle)|.
    const worldSlotAngle = wrapPi(slotAngle - containerAngleRef.current)
    const angleFromFront = Math.abs(worldSlotAngle)
    const focus = Math.max(0, Math.cos(angleFromFront))
    const r = R_IDLE + (R_ACTIVE - R_IDLE) * focus
    let targetScale = 0.65 + 0.55 * focus
    const visible = angleFromFront < (100 * Math.PI / 180)

    // Pinch zoom: scale up and approach camera when active + focused
    let pinchZ = 0
    if (isActive && pinchZoomProgress > 0) {
      targetScale *= (1 + pinchZoomProgress * PINCH_SCALE_MULTIPLIER)
      pinchZ = pinchZoomProgress * PINCH_APPROACH_DISTANCE
    }

    // Slot at angle α sits at local position (r·sin α, 0, -r·cos α). Front (α=0)
    // lands at (0, 0, -r) in front of the camera.
    const desiredX = r * Math.sin(slotAngle)
    const desiredZ = -r * Math.cos(slotAngle) + pinchZ

    if (springEntrance && !springStartedRef.current) {
      // Spring entrance from origin → slot position.
      const k = 1 - Math.pow(0.005, delta)
      springRef.current.x += (desiredX - springRef.current.x) * k * 5
      springRef.current.y += (0        - springRef.current.y) * k * 5
      springRef.current.z += (desiredZ - springRef.current.z) * k * 5
      groupRef.current.position.copy(springRef.current)
      // Once close enough, snap-track exact target on subsequent frames.
      if (Math.abs(springRef.current.x - desiredX) < 0.05 && Math.abs(springRef.current.z - desiredZ) < 0.05) {
        springStartedRef.current = true
      }
    } else {
      groupRef.current.position.set(desiredX, 0, desiredZ)
      springRef.current.set(desiredX, 0, desiredZ)
    }

    const k = 1 - Math.pow(0.005, delta)
    matRef.current.scale = THREE.MathUtils.lerp(matRef.current.scale, targetScale, k * 6)
    const finalScale = matRef.current.scale * (hovered && isActive ? 1.05 : 1)
    groupRef.current.scale.setScalar(finalScale)
    groupRef.current.visible = visible

    // Dissolve: reduce child material opacity when approaching threshold
    if (isActive && pinchZoomProgress > PINCH_DISSOLVE_START) {
      const dissolve = (pinchZoomProgress - PINCH_DISSOLVE_START) / (1 - PINCH_DISSOLVE_START)
      groupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.Material & { opacity: number }
          if (child.userData._origOpacity === undefined) {
            child.userData._origOpacity = mat.opacity
          }
          mat.opacity = child.userData._origOpacity * (1 - dissolve * 0.8)
        }
      })
    } else if (groupRef.current) {
      groupRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh && child.userData._origOpacity !== undefined) {
          ;(child.material as any).opacity = child.userData._origOpacity
          delete child.userData._origOpacity
        }
      })
    }
  })

  return (
    <group
      ref={groupRef}
      onClick={e => {
        e.stopPropagation()
        if (isActive) onActivate(mode)
        else onSelect(mode)
      }}
      onPointerOver={e => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
      onPointerOut={e => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'auto' }}
    >
      <Float speed={0.9} floatIntensity={0.28} rotationIntensity={0.04}>
        {children}
      </Float>
      <Html center distanceFactor={10} zIndexRange={[0, 0]}
        style={{ pointerEvents: 'none', opacity: isActive || hovered ? 1 : 0, transition: 'opacity 0.18s' }}>
        <span className="hologram-label">{modeMeta[mode].label}</span>
      </Html>
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   RingController — bridges the store to RingGroup + holograms.
   Owns the targetAngle (derived from activeRingMode) and the
   click handlers. Renders the right ring depending on ringLevel.
───────────────────────────────────────────────────────────── */
function RingController() {
  const ringLevel       = useJarvisStore(s => s.ringLevel)
  const activeRingMode  = useJarvisStore(s => s.activeRingMode)
  const zoomedMode      = useJarvisStore(s => s.zoomedMode)
  const setActiveRingMode = useJarvisStore(s => s.setActiveRingMode)
  const setRingLevel    = useJarvisStore(s => s.setRingLevel)
  const setZoomedMode   = useJarvisStore(s => s.setZoomedMode)

  // For a hologram at local position (sin α, 0, -cos α), a Y-rotation β on the
  // container puts it at world angle (α - β) measured from -Z. To bring the
  // active slot to the front (world angle 0), set containerAngle β = slotAngle α.
  const activeSlot = ringLevel === 'house-sub'
    ? SUB_ANGLES[activeRingMode as 'plan3d'|'space'|'plan2d'] ?? 0
    : ringLevel === 'utils-sub'
      ? UTILS_ANGLES[activeRingMode as 'timer'|'chrono'] ?? 0
      : MAIN_ANGLES[activeRingMode] ?? 0
  const targetAngle = activeSlot

  // Shared ref so each RingHologram reads the live container rotation
  // without a useThree traversal each frame.
  const containerAngleRef = useRef(targetAngle)

  // Click-on-adjacent → rotate one snap toward it. Click-on-active → enter.
  const handleSelect = (mode: Mode) => {
    setActiveRingMode(mode)
  }
  const handleActivate = (mode: Mode) => {
    if (zoomedMode) return
    if (ringLevel === 'main' && mode === 'house') {
      setRingLevel('house-sub')
    } else if (ringLevel === 'main' && mode === 'utils') {
      setRingLevel('utils-sub')
    } else {
      setZoomedMode(mode)
    }
  }

  if (ringLevel === 'house-sub') {
    return (
      <HouseSubRing
        targetAngle={targetAngle}
        containerAngleRef={containerAngleRef}
        activeRingMode={activeRingMode}
        zoomedMode={zoomedMode}
        onSelect={handleSelect}
        onActivate={handleActivate}
      />
    )
  }

  if (ringLevel === 'utils-sub') {
    return (
      <UtilsSubRing
        targetAngle={targetAngle}
        containerAngleRef={containerAngleRef}
        activeRingMode={activeRingMode}
        zoomedMode={zoomedMode}
        onSelect={handleSelect}
        onActivate={handleActivate}
      />
    )
  }

  return (
    <MainRing
      targetAngle={targetAngle}
      containerAngleRef={containerAngleRef}
      activeRingMode={activeRingMode}
      zoomedMode={zoomedMode}
      onSelect={handleSelect}
      onActivate={handleActivate}
    />
  )
}

/* ─────────────────────────────────────────────────────────────
   RingAngleProbe — reads the parent group's rotation.y per frame
   and writes it into containerAngleRef so each RingHologram can
   derive its own focus without a separate traversal.
───────────────────────────────────────────────────────────── */
function RingAngleProbe({ containerAngleRef }: { containerAngleRef: { current: number } }) {
  const probeRef = useRef<THREE.Group>(null)
  useFrame(() => {
    if (probeRef.current && probeRef.current.parent) {
      containerAngleRef.current = probeRef.current.parent.rotation.y
    }
  })
  return <group ref={probeRef} />
}

/* ─────────────────────────────────────────────────────────────
   MainRing — 4 main holograms inside a RingGroup.
───────────────────────────────────────────────────────────── */
interface RingProps {
  targetAngle: number
  containerAngleRef: { current: number }
  activeRingMode: Mode
  zoomedMode: Mode | null
  onSelect: (mode: Mode) => void
  onActivate: (mode: Mode) => void
}
function MainRing({ targetAngle, containerAngleRef, activeRingMode, zoomedMode, onSelect, onActivate }: RingProps) {
  const geoFor = (mode: Mode, active: boolean): React.ReactNode => {
    switch (mode) {
      case 'home':   return <NeuralFireGeo active={active} />
      case 'house':  return <TowerGeo      active={active} />
      case 'system': return <HexDieGeo     active={active} />
      case 'cloud':  return <HexTorusGeo   active={active} />
      case 'utils':  return <UtilsGeo      active={active} />
      default:       return null
    }
  }

  return (
    <RingGroup targetAngle={targetAngle}>
      <RingAngleProbe containerAngleRef={containerAngleRef} />
      {MAIN_ORDER.map(mode => {
        const isActive = activeRingMode === mode && !zoomedMode
        return (
          <RingHologram
            key={mode}
            mode={mode}
            slotAngle={MAIN_ANGLES[mode]}
            containerAngleRef={containerAngleRef}
            isActive={isActive}
            onSelect={onSelect}
            onActivate={onActivate}
          >
            {geoFor(mode, isActive)}
          </RingHologram>
        )
      })}
    </RingGroup>
  )
}

/* ─────────────────────────────────────────────────────────────
   HouseSubRing — 3 sub-mode holograms inside a RingGroup.
   Mounts only when ringLevel === 'house-sub'. Uses spring entrance
   (handled inside RingHologram via springTarget).
───────────────────────────────────────────────────────────── */
function HouseSubRing({ targetAngle, containerAngleRef, activeRingMode, zoomedMode, onSelect, onActivate }: RingProps) {
  const geoFor = (mode: Mode, active: boolean): React.ReactNode => {
    switch (mode) {
      case 'plan3d': return <Plan3DGeo active={active} />
      case 'plan2d': return <Plan2DGeo active={active} />
      case 'space':  return <SpaceGeo  active={active} />
      default:       return null
    }
  }

  return (
    <RingGroup targetAngle={targetAngle}>
      <RingAngleProbe containerAngleRef={containerAngleRef} />
      {SUB_ORDER.map(mode => {
        const isActive = activeRingMode === mode && !zoomedMode
        return (
          <RingHologram
            key={mode}
            mode={mode}
            slotAngle={SUB_ANGLES[mode as 'plan3d'|'space'|'plan2d']}
            containerAngleRef={containerAngleRef}
            isActive={isActive}
            springEntrance
            onSelect={onSelect}
            onActivate={onActivate}
          >
            {geoFor(mode, isActive)}
          </RingHologram>
        )
      })}
    </RingGroup>
  )
}

/* ─────────────────────────────────────────────────────────────
   UtilsSubRing — timer / chrono holograms inside a RingGroup.
   Mounts only when ringLevel === 'utils-sub'.
───────────────────────────────────────────────────────────── */
function UtilsSubRing({ targetAngle, containerAngleRef, activeRingMode, zoomedMode, onSelect, onActivate }: RingProps) {
  const geoFor = (mode: Mode, active: boolean): React.ReactNode => {
    switch (mode) {
      case 'timer':  return <TimerGeo  active={active} />
      case 'chrono': return <ChronoGeo active={active} />
      default:       return null
    }
  }

  return (
    <RingGroup targetAngle={targetAngle}>
      <RingAngleProbe containerAngleRef={containerAngleRef} />
      {UTILS_SUB_ORDER.map(mode => {
        const isActive = activeRingMode === mode && !zoomedMode
        return (
          <RingHologram
            key={mode}
            mode={mode}
            slotAngle={UTILS_ANGLES[mode as 'timer'|'chrono']}
            containerAngleRef={containerAngleRef}
            isActive={isActive}
            springEntrance
            onSelect={onSelect}
            onActivate={onActivate}
          >
            {geoFor(mode, isActive)}
          </RingHologram>
        )
      })}
    </RingGroup>
  )
}

/* ─────────────────────────────────────────────────────────────
   Main scene content (inside Canvas)
───────────────────────────────────────────────────────────── */
function SceneContent() {
  return (
    <>
      <CosmicBackground />
      <ambientLight color="#00f0ff" intensity={0.12} />
      <pointLight position={[0, 8, -4]} color="#0059ff" intensity={1.2} />
      <pointLight position={[0, -5, -8]} color="#00f0ff" intensity={0.4} />
      <RingController />
    </>
  )
}

/* ─────────────────────────────────────────────────────────────
   Exported component
───────────────────────────────────────────────────────────── */
export function WorldScene() {
  return (
    <Canvas
      camera={{ position: [0, 0, 0], fov: 72, near: 0.1, far: 200 }}
      style={{ position: 'fixed', inset: 0, background: '#03080d' }}
      gl={{ antialias: true, alpha: false }}
    >
      <SceneContent />
    </Canvas>
  )
}

// Preload tower model so it's ready when the HOUSE hologram first renders.
useGLTF.preload(TOWER_MODEL_URL)
