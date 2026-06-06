import { create } from 'zustand'

const STORAGE_KEY = 'jarvis.chrono.v1'

export type ChronoStatus = 'running' | 'paused' | 'idle'

export interface ChronoEntry {
  id: string
  label: string
  elapsedMs: number
  status: ChronoStatus
  startedAt: number | null
  laps: number[]
  createdAt: number
}

interface PersistedShape {
  chronos: ChronoEntry[]
  savedAt: number
}

function nowMs(): number { return Date.now() }

function genId(): string {
  return `${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function loadPersisted(): ChronoEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as PersistedShape
    if (!Array.isArray(data.chronos)) return []
    const elapsedSinceSave = nowMs() - (data.savedAt ?? nowMs())
    return data.chronos.map((c) =>
      c.status === 'running'
        ? { ...c, elapsedMs: c.elapsedMs + elapsedSinceSave, startedAt: nowMs() - (c.elapsedMs + elapsedSinceSave) }
        : c,
    )
  } catch {
    return []
  }
}

function savePersisted(chronos: ChronoEntry[]) {
  try {
    const data: PersistedShape = { chronos, savedAt: nowMs() }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {}
}

interface ChronoState {
  chronos: ChronoEntry[]
  create: (input: { label?: string; autoStart?: boolean }) => ChronoEntry
  start: (id?: string) => void
  pause: (id?: string) => void
  reset: (id?: string) => void
  lap: (id?: string) => void
  cancel: (id?: string) => void
  cancelAll: () => void
  findByLabel: (label: string) => ChronoEntry | undefined
}

export const useChronoStore = create<ChronoState>((set, get) => ({
  chronos: loadPersisted(),

  create: ({ label, autoStart = true }) => {
    const entry: ChronoEntry = {
      id: genId(),
      label: (label || '').trim() || 'Cronómetro',
      elapsedMs: 0,
      status: autoStart ? 'running' : 'idle',
      startedAt: autoStart ? nowMs() : null,
      laps: [],
      createdAt: nowMs(),
    }
    const next = [...get().chronos, entry]
    set({ chronos: next })
    savePersisted(next)
    return entry
  },

  start: (id) => {
    const next = get().chronos.map((c) => {
      const match = id ? c.id === id : c.status !== 'running'
      if (!match || c.status === 'running') return c
      return { ...c, status: 'running' as const, startedAt: nowMs() - c.elapsedMs }
    })
    set({ chronos: next })
    savePersisted(next)
  },

  pause: (id) => {
    const next = get().chronos.map((c) => {
      const match = id ? c.id === id : c.status === 'running'
      if (!match || c.status !== 'running') return c
      const elapsed = c.startedAt ? nowMs() - c.startedAt : c.elapsedMs
      return { ...c, status: 'paused' as const, elapsedMs: elapsed, startedAt: null }
    })
    set({ chronos: next })
    savePersisted(next)
  },

  reset: (id) => {
    const next = get().chronos.map((c) =>
      (id ? c.id === id : true)
        ? { ...c, status: 'idle' as const, elapsedMs: 0, startedAt: null, laps: [] }
        : c,
    )
    set({ chronos: next })
    savePersisted(next)
  },

  lap: (id) => {
    const next = get().chronos.map((c) => {
      const match = id ? c.id === id : c.status === 'running'
      if (!match) return c
      const elapsed = c.startedAt ? nowMs() - c.startedAt : c.elapsedMs
      return { ...c, laps: [...c.laps, elapsed] }
    })
    set({ chronos: next })
    savePersisted(next)
  },

  cancel: (id) => {
    const next = id ? get().chronos.filter((c) => c.id !== id) : []
    set({ chronos: next })
    savePersisted(next)
  },

  cancelAll: () => {
    set({ chronos: [] })
    savePersisted([])
  },

  findByLabel: (label) => {
    const needle = label.toLowerCase().trim()
    if (!needle) return undefined
    return get().chronos.find((c) => c.label.toLowerCase().includes(needle))
  },
}))

// Tick at 100ms so centiseconds are smooth in the UI.
let tickHandle: ReturnType<typeof setInterval> | null = null

export function startChronoTicker() {
  if (tickHandle) return
  tickHandle = setInterval(() => {
    const state = useChronoStore.getState()
    let anyRunning = false
    const next = state.chronos.map((c) => {
      if (c.status !== 'running' || c.startedAt == null) return c
      anyRunning = true
      return { ...c, elapsedMs: nowMs() - c.startedAt }
    })
    if (anyRunning) {
      useChronoStore.setState({ chronos: next })
    }
  }, 100)
}

export function stopChronoTicker() {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null }
}

export function formatChrono(ms: number): string {
  const totalCs = Math.max(0, Math.floor(ms / 10))
  const cs = totalCs % 100
  const totalS = Math.floor(totalCs / 100)
  const s = totalS % 60
  const totalM = Math.floor(totalS / 60)
  const m = totalM % 60
  const h = Math.floor(totalM / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`
    : `${pad(m)}:${pad(s)}.${pad(cs)}`
}
