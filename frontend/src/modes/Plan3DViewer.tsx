import { useState, useMemo, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useGestureStore } from '../state/gestureStore'
import type { SavedPlan, EntityKind, SceneEntity, Viewpoint } from '../types'
import { GRID_CELLS, CELL_METERS, PLAN3D_ENTITY_STORAGE_KEY, PLAN3D_VIEWPOINT_STORAGE_KEY } from '../constants'
import { loadSavedPlans } from './Plan2DEditor'

const SKILL_OPTIONS = ['none', 'tv', 'lights', 'climate', 'security', 'media', 'energy', 'custom'] as const
const ACTION_OPTIONS: Record<string, string[]> = {
  none: ['none'],
  tv: ['toggle', 'power_on', 'power_off', 'volume_up', 'volume_down', 'mute', 'input_hdmi1'],
  lights: ['toggle', 'on', 'off', 'brightness_up', 'brightness_down', 'scene_relax'],
  climate: ['toggle', 'on', 'off', 'temp_up', 'temp_down', 'mode_cool', 'mode_heat'],
  security: ['arm', 'disarm', 'snapshot', 'record'],
  media: ['play', 'pause', 'next', 'previous', 'volume_up', 'volume_down'],
  energy: ['status', 'on', 'off'],
  custom: ['toggle', 'run'],
}

const ENTITY_PRESETS: Record<EntityKind, Omit<SceneEntity, 'id' | 'x' | 'y' | 'z' | 'rotY'>> = {
  sofa: { kind: 'sofa', category: 'furniture', width: 2.0, height: 0.85, depth: 0.9, color: '#ff9b7a', label: 'Sofá' },
  bed: { kind: 'bed', category: 'furniture', width: 2.0, height: 0.55, depth: 1.6, color: '#b6a4ff', label: 'Cama' },
  table: { kind: 'table', category: 'furniture', width: 1.4, height: 0.75, depth: 0.9, color: '#e9c28b', label: 'Mesa' },
  tv: { kind: 'tv', category: 'furniture', width: 1.6, height: 0.9, depth: 0.08, color: '#8ff4ff', label: 'TV' },
  lamp: { kind: 'lamp', category: 'furniture', width: 0.3, height: 1.7, depth: 0.3, color: '#ffe9a8', label: 'Lámpara' },
  router: { kind: 'router', category: 'device', width: 0.28, height: 0.08, depth: 0.2, color: '#78d6ff', label: 'Router' },
  camera: { kind: 'camera', category: 'device', width: 0.15, height: 0.12, depth: 0.15, color: '#a8f4ff', label: 'Cámara' },
  switch: { kind: 'switch', category: 'device', width: 0.12, height: 0.12, depth: 0.04, color: '#d8e4ff', label: 'Switch' },
  sensor: { kind: 'sensor', category: 'device', width: 0.1, height: 0.1, depth: 0.1, color: '#b9ffc8', label: 'Sensor' },
}

export function loadEntityStore(): Record<string, SceneEntity[]> {
  try {
    const raw = localStorage.getItem(PLAN3D_ENTITY_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, SceneEntity[]>) : {}
  } catch {
    return {}
  }
}

export function loadViewpointStore(): Record<string, Viewpoint> {
  try {
    const raw = localStorage.getItem(PLAN3D_VIEWPOINT_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, Viewpoint>) : {}
  } catch {
    return {}
  }
}

function PinchCameraZoom() {
  const pinch = useGestureStore(s => s.output.pinch)
  const { camera } = useThree()

  useFrame(() => {
    if (!pinch.active) return
    const cam = camera as THREE.PerspectiveCamera
    cam.zoom = pinch.zoom
    cam.updateProjectionMatrix()
  })

  return null
}

export function EntityPrimitive({ entity, focused }: { entity: SceneEntity; focused?: boolean }) {
  const lineColor = entity.category === 'device'
    ? (focused ? '#ecfff8' : '#47ffd8')
    : (focused ? '#d2e6ff' : '#8fb6ff')
  const auraColor = entity.category === 'device'
    ? (focused ? '#6bffe2' : '#35e9c3')
    : (focused ? '#8fc2ff' : '#5c87ff')

  return (
    <group position={[entity.x, entity.y + entity.height * 0.5, entity.z]} rotation={[0, -entity.rotY * (Math.PI / 180), 0]}>
      {(entity.kind === 'sofa' || entity.kind === 'bed' || entity.kind === 'table' || entity.kind === 'tv') && (
        <mesh>
          <boxGeometry args={[entity.width, entity.height, entity.depth]} />
          <meshBasicMaterial color={lineColor} wireframe />
        </mesh>
      )}

      {entity.kind === 'lamp' && (
        <group>
          <mesh position={[0, -entity.height * 0.2, 0]}>
            <cylinderGeometry args={[0.03, 0.03, entity.height * 0.8, 12]} />
            <meshBasicMaterial color={lineColor} wireframe />
          </mesh>
          <mesh position={[0, entity.height * 0.25, 0]}>
            <coneGeometry args={[Math.max(0.08, entity.width * 0.5), entity.height * 0.35, 12]} />
            <meshBasicMaterial color={lineColor} wireframe />
          </mesh>
        </group>
      )}

      {entity.kind === 'router' && (
        <group>
          <mesh>
            <boxGeometry args={[entity.width, entity.height, entity.depth]} />
            <meshBasicMaterial color={lineColor} wireframe />
          </mesh>
          <mesh position={[-entity.width * 0.25, entity.height * 0.65, 0]}>
            <cylinderGeometry args={[0.01, 0.01, entity.height * 0.8, 8]} />
            <meshBasicMaterial color={lineColor} wireframe />
          </mesh>
          <mesh position={[entity.width * 0.25, entity.height * 0.65, 0]}>
            <cylinderGeometry args={[0.01, 0.01, entity.height * 0.8, 8]} />
            <meshBasicMaterial color={lineColor} wireframe />
          </mesh>
        </group>
      )}

      {entity.kind === 'camera' && (
        <group>
          <mesh>
            <sphereGeometry args={[Math.max(0.05, entity.width * 0.5), 12, 12]} />
            <meshBasicMaterial color={lineColor} wireframe />
          </mesh>
          <mesh position={[0, -Math.max(0.06, entity.height * 0.55), 0]}>
            <cylinderGeometry args={[0.02, 0.03, 0.08, 10]} />
            <meshBasicMaterial color={lineColor} wireframe />
          </mesh>
        </group>
      )}

      {entity.kind === 'switch' && (
        <mesh>
          <boxGeometry args={[entity.width, entity.height, entity.depth]} />
          <meshBasicMaterial color={lineColor} wireframe />
        </mesh>
      )}

      {entity.kind === 'sensor' && (
        <mesh>
          <octahedronGeometry args={[Math.max(0.05, entity.width * 0.6), 0]} />
          <meshBasicMaterial color={lineColor} wireframe />
        </mesh>
      )}

      <mesh>
        <boxGeometry args={[entity.width * 1.08, entity.height * 1.08, entity.depth * 1.08]} />
        <meshBasicMaterial color={auraColor} transparent opacity={focused ? 0.2 : 0.1} />
      </mesh>
    </group>
  )
}

export function Plan3DViewer({ initialSelectedKey }: { initialSelectedKey?: string }) {
  const [savedPlans] = useState<SavedPlan[]>(() => loadSavedPlans())
  const [selectedKey, setSelectedKey] = useState<string>(initialSelectedKey ?? '')
  const [kindToAdd, setKindToAdd] = useState<EntityKind>('sofa')
  const [entityStore, setEntityStore] = useState<Record<string, SceneEntity[]>>(() => loadEntityStore())
  const [viewpointStore, setViewpointStore] = useState<Record<string, Viewpoint>>(() => loadViewpointStore())
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  useEffect(() => {
    if (initialSelectedKey) setSelectedKey(initialSelectedKey)
  }, [initialSelectedKey])

  const activePlan = useMemo(() => {
    if (!savedPlans.length) return null
    if (!selectedKey) return savedPlans[0]
    return savedPlans.find((p) => `${p.room}::${p.name}` === selectedKey) ?? savedPlans[0]
  }, [savedPlans, selectedKey])

  const activePlanKey = activePlan ? `${activePlan.room}::${activePlan.name}` : ''
  const entities = activePlanKey ? (entityStore[activePlanKey] ?? []) : []
  const selectedEntity = entities.find((e) => e.id === selectedEntityId) ?? null
  const activeViewpoint = activePlanKey ? (viewpointStore[activePlanKey] ?? { x: 0, y: 1.6, z: 4, yawDeg: 180 }) : { x: 0, y: 1.6, z: 4, yawDeg: 180 }

  const persistEntityStore = (next: Record<string, SceneEntity[]>) => {
    setEntityStore(next)
    localStorage.setItem(PLAN3D_ENTITY_STORAGE_KEY, JSON.stringify(next))
  }

  const patchViewpoint = (patch: Partial<Viewpoint>) => {
    if (!activePlanKey) return
    const nextVp = { ...activeViewpoint, ...patch }
    const next = { ...viewpointStore, [activePlanKey]: nextVp }
    setViewpointStore(next)
    localStorage.setItem(PLAN3D_VIEWPOINT_STORAGE_KEY, JSON.stringify(next))
  }

  const addEntity = () => {
    if (!activePlanKey) return
    const preset = ENTITY_PRESETS[kindToAdd]
    const id = `${kindToAdd}-${Math.random().toString(36).slice(2, 8)}`
    const entity: SceneEntity = {
      id,
      ...preset,
      x: 0,
      y: preset.kind === 'tv' || preset.kind === 'camera' || preset.kind === 'switch' ? 1.4 : 0,
      z: 0,
      rotY: 0,
    }
    const next = { ...entityStore, [activePlanKey]: [...entities, entity] }
    persistEntityStore(next)
    setSelectedEntityId(id)
  }

  const patchSelectedEntity = (patch: Partial<SceneEntity>) => {
    if (!activePlanKey || !selectedEntity) return
    const nextEntities = entities.map((e) => e.id === selectedEntity.id ? { ...e, ...patch } : e)
    persistEntityStore({ ...entityStore, [activePlanKey]: nextEntities })
  }

  const removeSelectedEntity = () => {
    if (!activePlanKey || !selectedEntity) return
    const nextEntities = entities.filter((e) => e.id !== selectedEntity.id)
    persistEntityStore({ ...entityStore, [activePlanKey]: nextEntities })
    setSelectedEntityId(null)
  }

  return (
    <div className="plan3d-overlay">
      <div className="glass plan3d-panel">
        <div className="label">Construcción 3D</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
          Altura muro: 2.4m · Grosor: 10cm
        </div>
        <select className="select" value={selectedKey} onChange={(e) => { setSelectedKey(e.target.value); setSelectedEntityId(null) }}>
          {savedPlans.length === 0 && <option value="">Sin planos guardados</option>}
          {savedPlans.map((p) => (
            <option key={`${p.room}-${p.name}`} value={`${p.room}::${p.name}`}>
              {p.room} · {p.name}
            </option>
          ))}
        </select>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <select className="select" value={kindToAdd} onChange={(e) => setKindToAdd(e.target.value as EntityKind)}>
            <option value="sofa">Sofá</option>
            <option value="bed">Cama</option>
            <option value="table">Mesa</option>
            <option value="tv">TV</option>
            <option value="lamp">Lámpara</option>
            <option value="router">Router</option>
            <option value="camera">Cámara</option>
            <option value="switch">Switch</option>
            <option value="sensor">Sensor</option>
          </select>
          <button className="btn" onClick={addEntity} disabled={!activePlanKey}>Agregar</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="label">Punto de vista</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            X:{activeViewpoint.x.toFixed(2)} Y:{activeViewpoint.y.toFixed(2)} Z:{activeViewpoint.z.toFixed(2)} Yaw:{activeViewpoint.yawDeg.toFixed(0)}°
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <button className="btn" onClick={() => patchViewpoint({ x: activeViewpoint.x - 0.25 })}>X−</button>
            <button className="btn" onClick={() => patchViewpoint({ x: activeViewpoint.x + 0.25 })}>X+</button>
            <button className="btn" onClick={() => patchViewpoint({ z: activeViewpoint.z - 0.25 })}>Z−</button>
            <button className="btn" onClick={() => patchViewpoint({ z: activeViewpoint.z + 0.25 })}>Z+</button>
            <button className="btn" onClick={() => patchViewpoint({ y: Math.max(0.5, activeViewpoint.y - 0.25) })}>↓</button>
            <button className="btn" onClick={() => patchViewpoint({ y: activeViewpoint.y + 0.25 })}>↑</button>
            <button className="btn" onClick={() => patchViewpoint({ yawDeg: activeViewpoint.yawDeg - 15 })}>↺</button>
            <button className="btn" onClick={() => patchViewpoint({ yawDeg: activeViewpoint.yawDeg + 15 })}>↻</button>
          </div>
        </div>

        {entities.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <select className="select" value={selectedEntityId ?? ''} onChange={(e) => setSelectedEntityId(e.target.value || null)}>
              <option value="">Seleccionar elemento</option>
              {entities.map((e) => <option key={e.id} value={e.id}>{e.label} · {e.id}</option>)}
            </select>
            {selectedEntity && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>{selectedEntity.label} ({selectedEntity.category})</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  <button className="btn" onClick={() => patchSelectedEntity({ x: selectedEntity.x - 0.25 })}>X−</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ x: selectedEntity.x + 0.25 })}>X+</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ z: selectedEntity.z - 0.25 })}>Z−</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ z: selectedEntity.z + 0.25 })}>Z+</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ rotY: selectedEntity.rotY + 90 })}>↻ 90°</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ y: Math.max(0, selectedEntity.y - 0.25) })}>↓</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ y: selectedEntity.y + 0.25 })}>↑</button>
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                  {selectedEntity.width.toFixed(2)}m × {selectedEntity.depth.toFixed(2)}m × {selectedEntity.height.toFixed(2)}m
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  <button className="btn" onClick={() => patchSelectedEntity({ width: Math.max(0.1, selectedEntity.width - 0.25) })}>W−</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ width: selectedEntity.width + 0.25 })}>W+</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ depth: Math.max(0.1, selectedEntity.depth - 0.25) })}>D−</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ depth: selectedEntity.depth + 0.25 })}>D+</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ height: Math.max(0.1, selectedEntity.height - 0.25) })}>H−</button>
                  <button className="btn" onClick={() => patchSelectedEntity({ height: selectedEntity.height + 0.25 })}>H+</button>
                  <button className="btn" onClick={removeSelectedEntity}>✕</button>
                </div>
                <select
                  className="select"
                  value={selectedEntity.skillName || 'none'}
                  onChange={(e) => {
                    const nextSkill = e.target.value
                    const candidates = (ACTION_OPTIONS[nextSkill] ?? []).filter((a) => a !== 'none')
                    patchSelectedEntity({
                      skillName: nextSkill === 'none' ? '' : nextSkill,
                      skillAction: candidates[0] ?? '',
                      skillActions: candidates.length ? [candidates[0]] : [],
                    })
                  }}
                >
                  {SKILL_OPTIONS.map((skill) => <option key={skill} value={skill}>{skill}</option>)}
                </select>
                <div className="action-chip-wrap" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {(ACTION_OPTIONS[selectedEntity.skillName || 'none'] ?? ['none']).filter((action) => action !== 'none').map((action) => {
                    const selected = (selectedEntity.skillActions ?? []).includes(action)
                    return (
                      <button
                        key={action}
                        className={`action-chip ${selected ? 'active' : ''}`}
                        onClick={() => {
                          const current = selectedEntity.skillActions ?? []
                          const next = selected ? current.filter((a) => a !== action) : [...current, action]
                          patchSelectedEntity({ skillActions: next, skillAction: next[0] ?? '' })
                        }}
                      >
                        {action}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="plan3d-canvas-wrap">
        <Canvas camera={{ position: [5, 6, 8], fov: 50 }}>
          <color attach="background" args={['#03080d']} />
          <ambientLight color="#00f0ff" intensity={0.2} />
          <pointLight position={[5, 7, 5]} intensity={0.8} color="#0059ff" />
          <gridHelper args={[12, 48, '#00f0ff22', '#00f0ff44']} position={[0, 0, 0]} />

          {activePlan?.segments.map((s, idx) => {
            const x1 = (s.x1 - GRID_CELLS / 2) * CELL_METERS
            const z1 = (s.y1 - GRID_CELLS / 2) * CELL_METERS
            const x2 = (s.x2 - GRID_CELLS / 2) * CELL_METERS
            const z2 = (s.y2 - GRID_CELLS / 2) * CELL_METERS
            const cx = (x1 + x2) / 2
            const cz = (z1 + z2) / 2
            const length = Math.max(0.05, Math.hypot(x2 - x1, z2 - z1))
            const angle = Math.atan2(z2 - z1, x2 - x1)
            const h = s.wallType === 'low' ? 0.9 : 2.4
            return (
              <group key={idx} position={[cx, h * 0.5, cz]} rotation={[0, -angle, 0]}>
                <mesh>
                  <boxGeometry args={[length, h, 0.1]} />
                  <meshStandardMaterial color="#001a2a" emissive="#003040" emissiveIntensity={0.5} transparent opacity={0.88} />
                </mesh>
                <mesh>
                  <boxGeometry args={[length, h, 0.1]} />
                  <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.18} />
                </mesh>
              </group>
            )
          })}

          {entities.map((entity) => (
            <EntityPrimitive key={entity.id} entity={entity} focused={entity.id === selectedEntityId} />
          ))}

          <group position={[activeViewpoint.x, activeViewpoint.y, activeViewpoint.z]}>
            <mesh>
              <cylinderGeometry args={[0.08, 0.08, 0.18, 18]} />
              <meshStandardMaterial color="#00f0ff" emissive="#00f0ff" emissiveIntensity={0.5} />
            </mesh>
            <mesh position={[Math.cos((activeViewpoint.yawDeg * Math.PI) / 180) * 0.28, 0, Math.sin((activeViewpoint.yawDeg * Math.PI) / 180) * 0.28]} rotation={[Math.PI / 2, 0, -(activeViewpoint.yawDeg * Math.PI) / 180]}>
              <coneGeometry args={[0.07, 0.22, 10]} />
              <meshStandardMaterial color="#00f0ff" emissive="#00f0ff" emissiveIntensity={0.5} />
            </mesh>
          </group>

          <PinchCameraZoom />
          <OrbitControls enablePan enableZoom enableRotate />
        </Canvas>
      </div>
    </div>
  )
}
