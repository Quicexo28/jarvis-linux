// Builds a compact, live snapshot of app state for the brain. Kept small on
// purpose (token budget) and dependency-light: it reads zustand stores and
// localStorage directly rather than importing the heavy 3D viewer module.
import { useJarvisStore } from '../state/jarvisStore'
import { useBootStore } from '../state/bootStore'
import { loadSavedPlans } from '../modes/Plan2DEditor'
import { PLAN3D_ENTITY_STORAGE_KEY } from '../constants'
import type { SceneEntity } from '../types'
import type { AgentSnapshot } from './types'

function loadEntityStore(): Record<string, SceneEntity[]> {
  try {
    const raw = localStorage.getItem(PLAN3D_ENTITY_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, SceneEntity[]>) : {}
  } catch {
    return {}
  }
}

export function buildSnapshot(): AgentSnapshot {
  const j = useJarvisStore.getState()
  const boot = useBootStore.getState()

  const plans = loadSavedPlans()
  const planList = plans.map((p) => ({
    key: `${p.room}::${p.name}`,
    room: p.room,
    name: p.name,
    updatedAt: p.updatedAt,
  }))

  const activePlanKey =
    j.requestedPlanKey ?? (planList.length ? planList[0].key : null)

  const entityStore = loadEntityStore()
  const entities = activePlanKey ? entityStore[activePlanKey] ?? [] : []

  return {
    mode: j.mode,
    zoomedMode: j.zoomedMode,
    ringLevel: j.ringLevel,
    activeRingMode: j.activeRingMode,
    bootState: boot.bootState,
    voiceEnabled: j.voiceEnabled,
    focusedEntity: j.focusedEntity?.label ?? null,
    activePlanKey,
    plans: planList,
    activePlanEntities: entities.map((e) => ({ id: e.id, label: e.label, kind: e.kind })),
  }
}
