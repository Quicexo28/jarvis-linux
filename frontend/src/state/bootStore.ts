import { create } from 'zustand'

export type BootState = 'DORMANT' | 'AWAKE' | 'PIP'

interface BootStore {
  bootState: BootState
  setBootState: (state: BootState) => void
  silentWake: () => void
  enterPip: () => void
  leavePip: () => void
}

export const useBootStore = create<BootStore>((set) => ({
  bootState: 'DORMANT',
  setBootState: (bootState) => set({ bootState }),
  silentWake: () => set({ bootState: 'AWAKE' }),
  enterPip: () => set({ bootState: 'PIP' }),
  leavePip: () => set({ bootState: 'AWAKE' }),
}))
