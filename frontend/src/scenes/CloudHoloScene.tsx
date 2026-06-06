import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Float, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { CosmicBackground } from '../components/CosmicBackground'

const SAT_POS: [number, number, number][] = [
  [-2, 1, -1], [2, 0.5, -0.5], [-1, -1, 1],
  [1.5, -0.8, 0.5], [-2.5, -0.4, -0.5], [0, 1.5, -2],
]

function NetworkNode({ position, central }: { position: [number, number, number]; central?: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)
  useFrame(() => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = (central ? 2 : 0.8) + Math.sin(Date.now() * 0.002 + position[0]) * 0.4
  })
  return (
    <Float speed={0.6} floatIntensity={0.2} rotationIntensity={0}>
      <mesh ref={meshRef} position={position}>
        <sphereGeometry args={central ? [0.3, 16, 16] : [0.12, 12, 12]} />
        <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={central ? 2 : 0.8} />
      </mesh>
    </Float>
  )
}

function ConnectionLines() {
  const origin = new THREE.Vector3(0, 0, 0)
  return (
    <>
      {SAT_POS.map((pos, i) => {
        const geo = new THREE.BufferGeometry().setFromPoints([origin, new THREE.Vector3(...pos)])
        const mat = new THREE.LineBasicMaterial({ color: '#00f0ff', transparent: true, opacity: 0.25 })
        const lineObj = new THREE.Line(geo, mat)
        return <primitive key={i} object={lineObj} />
      })}
    </>
  )
}

function Scene() {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      <NetworkNode position={[0, 0, 0]} central />
      {SAT_POS.map((pos, i) => <NetworkNode key={i} position={pos} />)}
      <ConnectionLines />
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.12}
        maxPolarAngle={Math.PI * 0.65} minPolarAngle={Math.PI * 0.35}
      />
    </>
  )
}

export function CloudHoloScene() {
  return (
    <Canvas camera={{ position: [0, 0.5, 7], fov: 45 }} style={{ background: '#03080d' }}>
      <Scene />
    </Canvas>
  )
}
