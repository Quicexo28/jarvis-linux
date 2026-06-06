import { Canvas } from '@react-three/fiber'
import { Float, OrbitControls } from '@react-three/drei'
import { CosmicBackground } from '../components/CosmicBackground'
import type { SavedPlan } from '../types'
import { CELL_METERS } from '../constants'

const SLOTS: [number, number, number][] = [
  [-2.5, 0, 0], [2.5, 0, 0], [0, 0, -2.5], [-2.5, 0, -2.5], [2.5, 0, -2.5],
]

function MiniaturePlan({ plan, position }: { plan: SavedPlan; position: [number, number, number] }) {
  const SCALE = 0.18
  return (
    <Float speed={0.7} floatIntensity={0.25} rotationIntensity={0.04}>
      <group position={position} scale={SCALE}>
        {plan.segments.map((seg, i) => {
          const x1 = seg.x1 * CELL_METERS
          const z1 = seg.y1 * CELL_METERS
          const x2 = seg.x2 * CELL_METERS
          const z2 = seg.y2 * CELL_METERS
          const len = Math.hypot(x2 - x1, z2 - z1)
          if (len < 0.001) return null
          const h = seg.wallType === 'low' ? 0.9 : 2.4
          return (
            <mesh
              key={i}
              position={[(x1 + x2) / 2, h * 0.5, (z1 + z2) / 2]}
              rotation={[0, -Math.atan2(z2 - z1, x2 - x1), 0]}
            >
              <boxGeometry args={[len, h, 0.1]} />
              <meshBasicMaterial color="#00f0ff" transparent opacity={0.55} wireframe />
            </mesh>
          )
        })}
      </group>
    </Float>
  )
}

function Scene({ plans }: { plans: SavedPlan[] }) {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      {plans.slice(0, 5).map((plan, i) => (
        <MiniaturePlan
          key={`${plan.room}-${plan.name}`}
          plan={plan}
          position={SLOTS[i] ?? [i * 2, 0, 0]}
        />
      ))}
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.08}
        maxPolarAngle={Math.PI * 0.6} minPolarAngle={Math.PI * 0.4}
      />
    </>
  )
}

export function HouseHoloScene({ plans }: { plans: SavedPlan[] }) {
  return (
    <Canvas camera={{ position: [0, 2, 9], fov: 45 }} style={{ background: '#03080d' }}>
      <Scene plans={plans} />
    </Canvas>
  )
}
