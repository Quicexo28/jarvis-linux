import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { CosmicBackground } from '../components/CosmicBackground'

interface RingProps {
  radius: number
  tiltX: number
  tiltZ: number
  speed: number
  voiceActive: boolean
}

function OrbitalRing({ radius, tiltX, tiltZ, speed, voiceActive }: RingProps) {
  const groupRef = useRef<THREE.Group>(null)
  const angles = useRef([0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2])

  useFrame((_, delta) => {
    const s = voiceActive ? speed * 3.5 : speed
    angles.current = angles.current.map((a) => a + s * delta)
    const g = groupRef.current
    if (!g) return
    for (let i = 1; i < g.children.length; i++) {
      const angle = angles.current[i - 1]
      if (angle !== undefined) {
        g.children[i].position.x = Math.cos(angle) * radius
        g.children[i].position.z = Math.sin(angle) * radius
      }
    }
  })

  return (
    <group ref={groupRef} rotation={[tiltX, 0, tiltZ]}>
      <mesh>
        <torusGeometry args={[radius, 0.008, 8, 120]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.55} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[radius, 0, 0]}>
          <sphereGeometry args={[0.04, 8, 8]} />
          <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={3} />
        </mesh>
      ))}
    </group>
  )
}

function Nucleus({ voiceActive }: { voiceActive: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame((_, delta) => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.MeshStandardMaterial
    const target = voiceActive ? 3.5 : 2
    mat.emissiveIntensity += (target - mat.emissiveIntensity) * delta * 3
  })

  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.4, 32, 32]} />
        <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={2} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.46, 16, 16]} />
        <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.15} />
      </mesh>
    </group>
  )
}

function Scene({ voiceActive }: { voiceActive: boolean }) {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      <Nucleus voiceActive={voiceActive} />
      <OrbitalRing radius={1.2} tiltX={0}           tiltZ={0}           speed={0.4} voiceActive={voiceActive} />
      <OrbitalRing radius={1.6} tiltX={Math.PI / 3} tiltZ={0}           speed={0.3} voiceActive={voiceActive} />
      <OrbitalRing radius={2.0} tiltX={Math.PI / 2} tiltZ={Math.PI / 4} speed={0.2} voiceActive={voiceActive} />
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.1}
        maxPolarAngle={Math.PI * 0.65} minPolarAngle={Math.PI * 0.35}
      />
    </>
  )
}

export function AtomicNucleusScene({ voiceActive = false }: { voiceActive?: boolean }) {
  return (
    <Canvas camera={{ position: [0, 0.5, 7], fov: 38 }} style={{ background: '#03080d' }}>
      <Scene voiceActive={voiceActive} />
    </Canvas>
  )
}
