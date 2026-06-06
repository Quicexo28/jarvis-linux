import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { CosmicBackground } from '../components/CosmicBackground'
import type { SystemTelemetry } from '../types'

function SystemRings({ telemetry }: { telemetry?: SystemTelemetry }) {
  const ringA = useRef<THREE.Mesh>(null)
  const ringB = useRef<THREE.Mesh>(null)
  const ringC = useRef<THREE.Mesh>(null)

  const cpu = telemetry?.host?.cpu?.usagePct ?? 20
  const gpu = telemetry?.host?.gpu?.avgUtilizationPct ?? 15
  const net = Math.min(100, (telemetry?.host?.network?.rxMbps ?? 0) * 3)

  useFrame((_, delta) => {
    if (ringA.current) ringA.current.rotation.z += (0.005 + cpu / 1200) * delta * 60
    if (ringB.current) ringB.current.rotation.x += (0.003 + gpu / 1200) * delta * 60
    if (ringC.current) {
      ringC.current.rotation.y += (0.002 + net / 1200) * delta * 60
      ringC.current.rotation.z += (0.001 + net / 2400) * delta * 60
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[0.5, 24, 24]} />
        <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={1.5} />
      </mesh>
      <mesh ref={ringA} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.1, 0.012, 8, 100]} />
        <meshBasicMaterial color="#00f0ff" />
      </mesh>
      <mesh ref={ringB} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[1.6, 0.01, 8, 100]} />
        <meshBasicMaterial color="#0059ff" transparent opacity={0.8} />
      </mesh>
      <mesh ref={ringC} rotation={[Math.PI / 3, 0, Math.PI / 6]}>
        <torusGeometry args={[2.2, 0.008, 8, 100]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.45} />
      </mesh>
    </group>
  )
}

function Scene({ telemetry }: { telemetry?: SystemTelemetry }) {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      <SystemRings telemetry={telemetry} />
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.1}
        maxPolarAngle={Math.PI * 0.65} minPolarAngle={Math.PI * 0.35}
      />
    </>
  )
}

export function SystemHoloScene({ telemetry }: { telemetry?: SystemTelemetry }) {
  return (
    <Canvas camera={{ position: [0, 0.3, 7.5], fov: 38 }} style={{ background: '#03080d' }}>
      <Scene telemetry={telemetry} />
    </Canvas>
  )
}
