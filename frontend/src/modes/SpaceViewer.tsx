import { useState, useMemo, useEffect, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, PointerLockControls } from '@react-three/drei'
import * as THREE from 'three'
import type { SavedPlan, SceneEntity, Viewpoint } from '../types'
import { GRID_CELLS, CELL_METERS } from '../constants'
import { loadSavedPlans } from './Plan2DEditor'
import { loadEntityStore, loadViewpointStore, EntityPrimitive } from './Plan3DViewer'
import { useGestureStore } from '../state/gestureStore'
import { getApiBase } from '../api/client'

function ImmersiveFirstPersonController({ viewpoint }: { viewpoint: Viewpoint }) {
  const { camera } = useThree()

  useEffect(() => {
    camera.position.set(viewpoint.x, viewpoint.y, viewpoint.z)
    const yaw = (viewpoint.yawDeg * Math.PI) / 180
    camera.lookAt(viewpoint.x + Math.cos(yaw), viewpoint.y, viewpoint.z + Math.sin(yaw))
  }, [camera, viewpoint.x, viewpoint.y, viewpoint.z, viewpoint.yawDeg])

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!('fov' in camera)) return
      const cam = camera as THREE.PerspectiveCamera
      cam.fov = THREE.MathUtils.clamp(cam.fov + (e.deltaY > 0 ? 2 : -2), 60, 110)
      cam.updateProjectionMatrix()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [camera])

  useFrame(() => {
    camera.position.set(viewpoint.x, viewpoint.y, viewpoint.z)
  })

  return null
}

function PinchFOVControl() {
  const pinch = useGestureStore(s => s.output.pinch)
  const { camera } = useThree()

  useFrame(() => {
    if (!pinch.active) return
    const cam = camera as THREE.PerspectiveCamera
    const t = (pinch.zoom - 0.5) / 2.5
    cam.fov = 110 - t * 50
    cam.updateProjectionMatrix()
  })

  return null
}

function GazeDetector({ entities, onFocus, locked, currentFocusId }: { entities: SceneEntity[]; onFocus: (id: string | null) => void; locked?: boolean; currentFocusId?: string | null }) {
  const { camera } = useThree()
  const forward = useMemo(() => new THREE.Vector3(), [])
  const toEntity = useMemo(() => new THREE.Vector3(), [])
  const worldPos = useMemo(() => new THREE.Vector3(), [])
  const [candidateId, setCandidateId] = useState<string | null>(null)
  const [candidateSince, setCandidateSince] = useState<number>(0)
  const lastEmittedRef = useRef<string | null>(null)

  useFrame(() => {
    if (locked && currentFocusId) {
      if (lastEmittedRef.current !== currentFocusId) {
        onFocus(currentFocusId)
        lastEmittedRef.current = currentFocusId
      }
      return
    }

    camera.getWorldDirection(forward)
    const camPos = camera.position

    let bestId: string | null = null
    let bestScore = Number.POSITIVE_INFINITY

    for (const entity of entities) {
      toEntity.set(entity.x - camPos.x, (entity.y + entity.height * 0.5) - camPos.y, entity.z - camPos.z)
      const distance = toEntity.length()
      if (distance > 6) continue
      toEntity.normalize()
      const angle = Math.acos(THREE.MathUtils.clamp(forward.dot(toEntity), -1, 1))
      if (angle > 0.28) continue

      worldPos.set(entity.x, entity.y + entity.height * 0.5, entity.z).project(camera)
      if (worldPos.z < -1 || worldPos.z > 1) continue
      const centerDist = Math.hypot(worldPos.x, worldPos.y)
      const score = centerDist * 1.4 + distance * 0.02 + angle * 0.5

      if (score < bestScore) {
        bestScore = score
        bestId = entity.id
      }
    }

    const now = performance.now()
    if (bestId !== candidateId) {
      setCandidateId(bestId)
      setCandidateSince(now)
      return
    }

    if (bestId) {
      if (now - candidateSince > 350 && lastEmittedRef.current !== bestId) {
        onFocus(bestId)
        lastEmittedRef.current = bestId
      }
    } else {
      if (now - candidateSince > 1800 && lastEmittedRef.current !== null) {
        onFocus(null)
        lastEmittedRef.current = null
      }
    }
  })

  return null
}

export function SpaceViewer({ initialSelectedKey }: { initialSelectedKey?: string }) {
  const [savedPlans] = useState<SavedPlan[]>(() => loadSavedPlans())
  const [selectedKey, setSelectedKey] = useState<string>(initialSelectedKey ?? '')
  const [entityStore] = useState<Record<string, SceneEntity[]>>(() => loadEntityStore())
  const [viewpointStore] = useState<Record<string, Viewpoint>>(() => loadViewpointStore())
  const [focusedEntityId, setFocusedEntityId] = useState<string | null>(null)
  const [popupHover, setPopupHover] = useState(false)
  const [popupCenterLock, setPopupCenterLock] = useState(false)
  const [selectedActionIdx, setSelectedActionIdx] = useState(0)
  const popupRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (initialSelectedKey) setSelectedKey(initialSelectedKey)
  }, [initialSelectedKey])
  const immersiveWrapRef = useRef<HTMLDivElement | null>(null)

  const activePlan = useMemo(() => {
    if (!savedPlans.length) return null
    if (!selectedKey) return savedPlans[0]
    return savedPlans.find((p) => `${p.room}::${p.name}` === selectedKey) ?? savedPlans[0]
  }, [savedPlans, selectedKey])

  const activePlanKey = activePlan ? `${activePlan.room}::${activePlan.name}` : ''
  const entities = activePlanKey ? (entityStore[activePlanKey] ?? []) : []
  const vp = activePlanKey ? (viewpointStore[activePlanKey] ?? { x: 0, y: 1.6, z: 4, yawDeg: 180 }) : { x: 0, y: 1.6, z: 4, yawDeg: 180 }
  const focusedEntity = entities.find((e) => e.id === focusedEntityId) ?? null
  const availableActions = useMemo(() => {
    if (!focusedEntity) return [] as string[]
    return (focusedEntity.skillActions && focusedEntity.skillActions.length > 0
      ? focusedEntity.skillActions
      : [focusedEntity.skillAction || '']).filter(Boolean)
  }, [focusedEntity])
  const popupPos = useMemo(() => {
    if (!focusedEntity) return null
    const targetX = focusedEntity.x
    const targetY = focusedEntity.y + focusedEntity.height * 0.55
    const targetZ = focusedEntity.z
    const dx = targetX - vp.x
    const dy = targetY - vp.y
    const dz = targetZ - vp.z
    const len = Math.hypot(dx, dy, dz) || 1
    const ux = dx / len
    const uy = dy / len
    const uz = dz / len

    const rightX = -uz
    const rightY = 0
    const rightZ = ux
    const sideOffset = 2.0

    return [vp.x + ux * 3 + rightX * sideOffset, vp.y + uy * 3 + rightY * sideOffset, vp.z + uz * 3 + rightZ * sideOffset] as [number, number, number]
  }, [focusedEntity, vp.x, vp.y, vp.z])

  const runFocusedAction = async (action?: string) => {
    if (!focusedEntity) return
    const selectedAction = action || availableActions[selectedActionIdx] || focusedEntity.skillAction || focusedEntity.skillActions?.[0]
    if (!selectedAction) return
    try {
      await fetch(`${getApiBase()}/api/jarvis/device-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: focusedEntity.id,
          label: focusedEntity.label,
          skillName: focusedEntity.skillName,
          action: selectedAction,
        }),
      })
    } catch (error) {
      console.error('No se pudo ejecutar acción de skill', error)
    }
  }

  useEffect(() => {
    setSelectedActionIdx(0)
  }, [focusedEntityId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!availableActions.length) return
      if (e.code === 'ArrowUp') {
        e.preventDefault()
        setSelectedActionIdx((i) => (i - 1 + availableActions.length) % availableActions.length)
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault()
        setSelectedActionIdx((i) => (i + 1) % availableActions.length)
      }
      if (e.code === 'Enter' && (popupCenterLock || popupHover)) {
        e.preventDefault()
        runFocusedAction(availableActions[selectedActionIdx])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [availableActions, popupCenterLock, popupHover, selectedActionIdx])

  useEffect(() => {
    const onClick = () => {
      if ((popupCenterLock || popupHover) && availableActions.length) runFocusedAction(availableActions[selectedActionIdx])
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [popupCenterLock, popupHover, availableActions, selectedActionIdx])

  useEffect(() => {
    let raf = 0
    const loop = () => {
      const wrap = immersiveWrapRef.current
      const popup = popupRef.current
      if (wrap && popup) {
        const wrapRect = wrap.getBoundingClientRect()
        const cx = wrapRect.left + wrapRect.width * 0.5
        const cy = wrapRect.top + wrapRect.height * 0.5

        const popupRect = popup.getBoundingClientRect()
        const insidePopup = cx >= popupRect.left && cx <= popupRect.right && cy >= popupRect.top && cy <= popupRect.bottom
        if (insidePopup !== popupCenterLock) setPopupCenterLock(insidePopup)

        if (insidePopup) {
          const buttons = Array.from(popup.querySelectorAll('button.focus-popup-button')) as HTMLButtonElement[]
          const idx = buttons.findIndex((btn) => {
            const r = btn.getBoundingClientRect()
            return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom
          })
          if (idx >= 0 && idx !== selectedActionIdx) setSelectedActionIdx(idx)
        }
      } else {
        if (popupCenterLock) setPopupCenterLock(false)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [popupCenterLock, selectedActionIdx])

  return (
    <div className="plan3d-overlay">
      <div className="glass plan3d-panel">
        <div className="label">Habitación</div>
        <select className="select" value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)}>
          {savedPlans.length === 0 && <option value="">Sin planos guardados</option>}
          {savedPlans.map((p) => (
            <option key={`${p.room}-${p.name}`} value={`${p.room}::${p.name}`}>{p.room} · {p.name}</option>
          ))}
        </select>
      </div>

      <div ref={immersiveWrapRef} className="plan3d-canvas-wrap immersive-canvas-wrap">
        <Canvas camera={{ position: [vp.x, vp.y, vp.z], fov: 90 }}>
          <color attach="background" args={['#03080d']} />
          <ambientLight color="#00f0ff" intensity={0.2} />
          <pointLight position={[5, 7, 5]} intensity={0.8} color="#0059ff" />

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
            <EntityPrimitive key={entity.id} entity={entity} focused={entity.id === focusedEntityId} />
          ))}

          {focusedEntity && popupPos && (availableActions.length > 0 || focusedEntity.skillName) && (
            <Html
              position={popupPos}
              center
              distanceFactor={14}
              wrapperClass="focus-popup-wrapper"
            >
              <div
                ref={popupRef}
                className="glass jarvis-hud-enter"
                style={{ padding: '12px 16px', minWidth: 140, fontSize: 12 }}
                onMouseEnter={() => setPopupHover(true)}
                onMouseLeave={() => setPopupHover(false)}
              >
                <div className="label">{focusedEntity.label}</div>
                <div style={{ color: 'var(--text-dim)', fontSize: 10, marginBottom: 8 }}>
                  {focusedEntity.skillName || 'skill sin asignar'}
                </div>
                {availableActions.map((action, idx) => (
                  <button
                    key={action}
                    className={`btn focus-popup-button ${idx === selectedActionIdx ? 'active' : ''}`}
                    style={{ display: 'block', width: '100%', marginBottom: 4 }}
                    onMouseEnter={() => setSelectedActionIdx(idx)}
                    onClick={() => runFocusedAction(action)}
                  >
                    {action}
                  </button>
                ))}
              </div>
            </Html>
          )}

          <GazeDetector entities={entities} onFocus={setFocusedEntityId} locked={popupHover || popupCenterLock} currentFocusId={focusedEntityId} />
          <ImmersiveFirstPersonController viewpoint={vp} />
          <PinchFOVControl />
          <PointerLockControls />
        </Canvas>
        <div className="immersive-crosshair">
          <div className="crosshair-h" />
          <div className="crosshair-v" />
          <div className="crosshair-dot" />
        </div>
      </div>
    </div>
  )
}
