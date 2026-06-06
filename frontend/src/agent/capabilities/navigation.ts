// Navigation + plan capabilities (Round 1 surface). Every capability wraps an
// EXISTING store action — the agent pulls the same levers a human does.
import { useJarvisStore } from '../../state/jarvisStore'
import { useBootStore } from '../../state/bootStore'
import { loadSavedPlans } from '../../modes/Plan2DEditor'
import { modeMeta } from '../../constants'
import { buildSnapshot } from '../snapshot'
import type { Mode } from '../../types'
import type { Capability } from '../types'

const MODES: Mode[] = ['home', 'house', 'plan2d', 'plan3d', 'space', 'cloud', 'system', 'mobile']

const labelOf = (mode: Mode) => modeMeta[mode]?.label ?? mode

export const navigationCapabilities: Capability[] = [
  {
    id: 'nav.goto',
    domain: 'navigation',
    description:
      'Abre/navega a una vista de la app (home=Core, house=Casa, plan2d=Plano 2D, plan3d=Espacio 3D, space=Inmersivo, cloud=Nube, system=Sistema).',
    params: {
      type: 'object',
      properties: { mode: { type: 'string', description: 'Vista destino', enum: MODES } },
      required: ['mode'],
    },
    run: (params) => {
      const mode = params.mode as Mode
      useJarvisStore.getState().setZoomedMode(mode)
      return { ok: true, detail: `Abrí ${labelOf(mode)}`, data: { mode } }
    },
  },
  {
    id: 'nav.back',
    domain: 'navigation',
    description: 'Cierra la vista actual y vuelve atrás (al carrusel o al nivel anterior).',
    params: { type: 'object', properties: {} },
    run: () => {
      const s = useJarvisStore.getState()
      if (s.zoomedMode != null) s.setZoomedMode(null)
      else if (s.ringLevel === 'house-sub') s.setRingLevel('main')
      return { ok: true, detail: 'Volví atrás' }
    },
  },
  {
    id: 'nav.ring.rotate',
    domain: 'navigation',
    description: 'Gira el carrusel principal de modos. dir=1 derecha (siguiente), dir=-1 izquierda (anterior).',
    params: {
      type: 'object',
      properties: { dir: { type: 'number', description: '1 o -1', enum: [1, -1] } },
      required: ['dir'],
    },
    run: (params) => {
      const s = useJarvisStore.getState()
      if (s.zoomedMode != null) {
        return { ok: false, detail: 'No puedo girar el carrusel con una vista abierta' }
      }
      const dir = (params.dir as number) >= 0 ? 1 : -1
      s.rotateRing(dir)
      const next = useJarvisStore.getState().activeRingMode
      return { ok: true, detail: `Giré el carrusel a ${labelOf(next)}`, data: { activeRingMode: next } }
    },
  },
  {
    id: 'nav.ring.enter',
    domain: 'navigation',
    description: 'Entra al modo enfocado en el carrusel (o abre el sub-anillo de Casa).',
    params: { type: 'object', properties: {} },
    run: () => {
      const s = useJarvisStore.getState()
      if (s.ringLevel === 'main' && s.activeRingMode === 'house') {
        s.setRingLevel('house-sub')
        return { ok: true, detail: 'Abrí el sub-menú de Casa' }
      }
      s.setZoomedMode(s.activeRingMode)
      return { ok: true, detail: `Entré a ${labelOf(s.activeRingMode)}` }
    },
  },
  {
    id: 'plan.loadLast',
    domain: 'plan',
    description: 'Carga el último proyecto/plano guardado (el más reciente) en el Espacio 3D.',
    params: { type: 'object', properties: {} },
    run: () => {
      const plans = loadSavedPlans()
      if (!plans.length) return { ok: false, detail: 'No hay proyectos guardados todavía' }
      const latest = [...plans].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
      const key = `${latest.room}::${latest.name}`
      useJarvisStore.getState().setRequestedPlanKey(key)
      return { ok: true, detail: `Cargué ${latest.room} · ${latest.name}`, data: { key } }
    },
  },
  {
    id: 'system.sleep',
    domain: 'system',
    description: 'Pone el sistema en reposo (estado DORMANT).',
    params: { type: 'object', properties: {} },
    run: () => {
      useBootStore.getState().setBootState('DORMANT')
      return { ok: true, detail: 'Sistema en reposo' }
    },
  },
  {
    id: 'query.state',
    domain: 'query',
    description: 'Devuelve el estado actual de la app (vista activa, plano cargado, dispositivos).',
    params: { type: 'object', properties: {} },
    run: () => {
      const snap = buildSnapshot()
      const where = snap.zoomedMode ? labelOf(snap.zoomedMode) : `carrusel en ${labelOf(snap.activeRingMode)}`
      const plan = snap.activePlanKey ? `, proyecto ${snap.activePlanKey}` : ''
      return {
        ok: true,
        detail: `Estás en ${where}${plan}. Hay ${snap.plans.length} proyecto(s) guardado(s).`,
        data: snap,
      }
    },
  },
]
