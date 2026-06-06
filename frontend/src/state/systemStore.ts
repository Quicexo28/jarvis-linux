import { create } from 'zustand'

interface ModelStats {
  requestsPerHour?: number
  avgLatencyMs?: number
}

interface ServiceStatus {
  name: string
  status: 'running' | 'stopped' | 'unknown'
}

interface SystemState {
  tokensWindow5h: number | null
  tokensWeek: number | null
  modelStats: ModelStats
  activeModel: string
  services: ServiceStatus[]
  containers: string[]
  routines: string[]

  setTokensWindow5h: (n: number | null) => void
  setTokensWeek: (n: number | null) => void
  setModelStats: (stats: ModelStats) => void
  setActiveModel: (model: string) => void
  setServices: (services: ServiceStatus[]) => void
  setContainers: (containers: string[]) => void
  setRoutines: (routines: string[]) => void
}

export const useSystemStore = create<SystemState>((set) => ({
  tokensWindow5h: null,
  tokensWeek: null,
  modelStats: {},
  activeModel: '',
  services: [],
  containers: [],
  routines: [],

  setTokensWindow5h: (tokensWindow5h) => set({ tokensWindow5h }),
  setTokensWeek: (tokensWeek) => set({ tokensWeek }),
  setModelStats: (modelStats) => set({ modelStats }),
  setActiveModel: (activeModel) => set({ activeModel }),
  setServices: (services) => set({ services }),
  setContainers: (containers) => set({ containers }),
  setRoutines: (routines) => set({ routines }),
}))
