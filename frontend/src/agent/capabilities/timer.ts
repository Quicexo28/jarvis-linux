// Timer capabilities — a worked example of extending the agent surface to a new
// in-app feature. The brain just supplies `seconds`; the UI (TimerOverlay)
// renders and counts down. Demonstrates that adding a real capability is small.
import { useTimerStore } from '../../state/timerStore'
import type { Capability } from '../types'

export const timerCapabilities: Capability[] = [
  {
    id: 'timer.start',
    domain: 'timer',
    description: 'Inicia un temporizador / cuenta atrás visible en la app. seconds = duración total en segundos.',
    params: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Duración total en segundos' },
        label: { type: 'string', description: 'Nombre opcional del temporizador' },
      },
      required: ['seconds'],
    },
    run: (params) => {
      const seconds = Math.max(1, Math.round(Number(params.seconds)))
      if (!Number.isFinite(seconds)) return { ok: false, detail: 'Duración inválida para el temporizador' }
      const label = (params.label as string)?.trim() || 'Temporizador'
      const t = useTimerStore.getState().create({ label, durationMs: seconds * 1000 })
      return { ok: true, detail: `${label} de ${seconds}s iniciado`, data: { id: t.id, seconds } }
    },
  },
  {
    id: 'timer.cancel',
    domain: 'timer',
    description: 'Cancela un temporizador por id, o todos los activos si no se pasa id.',
    params: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id del temporizador (opcional)' } },
    },
    run: (params) => {
      const store = useTimerStore.getState()
      const id = params.id as string | undefined
      if (id) {
        const exists = store.timers.some((t) => t.id === id)
        store.cancel(id)
        return { ok: exists, detail: exists ? 'Temporizador cancelado' : 'No encontré ese temporizador' }
      }
      const running = store.timers.filter((t) => t.status === 'running')
      store.cancelAll()
      return { ok: true, detail: `Cancelé ${running.length} temporizador(es)` }
    },
  },
]
