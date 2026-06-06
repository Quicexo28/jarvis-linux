import { create } from 'zustand'

export type BootState = 'DORMANT' | 'AWAKE'

interface BootStore {
  bootState: BootState
  setBootState: (state: BootState) => void
  silentWake: () => void
}

export const useBootStore = create<BootStore>((set) => ({
  bootState: 'DORMANT',
  setBootState: (bootState) => set({ bootState }),
  silentWake: () => set({ bootState: 'AWAKE' }),
}))
