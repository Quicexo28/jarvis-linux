import { create } from 'zustand'
import { playTimerAlarm } from '../audio/timerAlarm'

const STORAGE_KEY = 'jarvis.timer.v1'

export type TimerStatus = 'running' | 'paused' | 'done'

export interface TimerEntry {
  id: string
  label: string
  durationMs: number
  remainingMs: number
  status: TimerStatus
  startedAt: number
  pausedAt: number | null
  createdAt: number
}

interface PersistedShape {
  timers: TimerEntry[]
  savedAt: number
}

function nowMs(): number { return Date.now() }

function genId(): string {
  return `${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function loadPersisted(): TimerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as PersistedShape
    if (!Array.isArray(data.timers)) return []
    // Rehydrate: running timers should reflect elapsed wall-clock since save.
    const elapsedSinceSave = nowMs() - (data.savedAt ?? nowMs())
    return data.timers.map((t) => {
      if (t.status !== 'running') return t
      const remaining = Math.max(0, t.remainingMs - elapsedSinceSave)
      return remaining <= 0
        ? { ...t, remainingMs: 0, status: 'done' as const, pausedAt: null }
        : { ...t, remainingMs: remaining }
    })
  } catch {
    return []
  }
}

function savePersisted(timers: TimerEntry[]) {
  try {
    const data: PersistedShape = { timers, savedAt: nowMs() }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {}
}

interface TimerState {
  timers: TimerEntry[]
  create: (input: { label?: string; durationMs: number }) => TimerEntry
  pause: (id?: string) => void
  resume: (id?: string) => void
  add: (id: string | undefined, deltaMs: number) => void
  reset: (id?: string) => void
  cancel: (id?: string) => void
  cancelAll: () => void
  findByLabel: (label: string) => TimerEntry | undefined
}

export const useTimerStore = create<TimerState>((set, get) => ({
  timers: loadPersisted(),

  create: ({ label, durationMs }) => {
    const entry: TimerEntry = {
      id: genId(),
      label: (label || '').trim() || 'Temporizador',
      durationMs: Math.max(1000, Math.round(durationMs)),
      remainingMs: Math.max(1000, Math.round(durationMs)),
      status: 'running',
      startedAt: nowMs(),
      pausedAt: null,
      createdAt: nowMs(),
    }
    const next = [...get().timers, entry]
    set({ timers: next })
    savePersisted(next)
    return entry
  },

  pause: (id) => {
    const t = nowMs()
    const next = get().timers.map((x) =>
      (id ? x.id === id : x.status === 'running') && x.status === 'running'
        ? { ...x, status: 'paused' as const, pausedAt: t }
        : x,
    )
    set({ timers: next })
    savePersisted(next)
  },

  resume: (id) => {
    const next = get().timers.map((x) =>
      (id ? x.id === id : x.status === 'paused') && x.status === 'paused'
        ? { ...x, status: 'running' as const, pausedAt: null, startedAt: nowMs() }
        : x,
    )
    set({ timers: next })
    savePersisted(next)
  },

  add: (id, deltaMs) => {
    const next = get().timers.map((x) => {
      const match = id ? x.id === id : x.status === 'running' || x.status === 'paused'
      if (!match) return x
      const wasDone = x.status === 'done'
      return {
        ...x,
        remainingMs: Math.max(0, x.remainingMs + deltaMs),
        durationMs: Math.max(0, x.durationMs + deltaMs),
        status: wasDone && deltaMs > 0 ? ('running' as const) : x.status,
        startedAt: wasDone && deltaMs > 0 ? nowMs() : x.startedAt,
      }
    })
    set({ timers: next })
    savePersisted(next)
  },

  reset: (id) => {
    const next = get().timers.map((x) =>
      (id ? x.id === id : true)
        ? { ...x, remainingMs: x.durationMs, status: 'paused' as const, pausedAt: nowMs(), startedAt: nowMs() }
        : x,
    )
    set({ timers: next })
    savePersisted(next)
  },

  cancel: (id) => {
    const next = id ? get().timers.filter((x) => x.id !== id) : []
    set({ timers: next })
    savePersisted(next)
  },

  cancelAll: () => {
    set({ timers: [] })
    savePersisted([])
  },

  findByLabel: (label) => {
    const needle = label.toLowerCase().trim()
    if (!needle) return undefined
    return get().timers.find((x) => x.label.toLowerCase().includes(needle))
  },
}))

// Single global tick — updates remainingMs for running timers and fires the
// alarm when any reaches 0. 250ms keeps the dial smooth without burning CPU.
let tickHandle: ReturnType<typeof setInterval> | null = null

export function startTimerTicker() {
  if (tickHandle) return
  let lastTick = nowMs()
  tickHandle = setInterval(() => {
    const t = nowMs()
    const dt = t - lastTick
    lastTick = t
    const state = useTimerStore.getState()
    let anyRunning = false
    let anyJustDone: TimerEntry | null = null
    const next = state.timers.map((x) => {
      if (x.status !== 'running') return x
      anyRunning = true
      const remaining = x.remainingMs - dt
      if (remaining <= 0) {
        const done: TimerEntry = { ...x, remainingMs: 0, status: 'done', pausedAt: null }
        anyJustDone = done
        return done
      }
      return { ...x, remainingMs: remaining }
    })
    if (anyRunning) {
      useTimerStore.setState({ timers: next })
      savePersisted(next)
      if (anyJustDone) {
        try { playTimerAlarm() } catch {}
        window.dispatchEvent(new CustomEvent('jarvis:timer-done', { detail: anyJustDone }))
      }
    }
  }, 250)
}

export function stopTimerTicker() {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null }
}

export function formatHms(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}
