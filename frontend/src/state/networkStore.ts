import { create } from 'zustand'

interface DiscoveredDevice {
  id: string
  ip: string
  hostname?: string
  mac?: string
}

interface NetworkState {
  discoveredDevices: DiscoveredDevice[]
  roomAssignments: Record<string, string>
  presenceByZone: Record<string, boolean>

  setDiscoveredDevices: (devices: DiscoveredDevice[]) => void
  setRoomAssignments: (assignments: Record<string, string>) => void
  setPresenceByZone: (presence: Record<string, boolean>) => void
}

export const useNetworkStore = create<NetworkState>((set) => ({
  discoveredDevices: [],
  roomAssignments: {},
  presenceByZone: {},

  setDiscoveredDevices: (discoveredDevices) => set({ discoveredDevices }),
  setRoomAssignments: (roomAssignments) => set({ roomAssignments }),
  setPresenceByZone: (presenceByZone) => set({ presenceByZone }),
}))
