import { create } from 'zustand'

export type OverlayName =
  | 'terminal'
  | 'gesture_debug'
  | 'speaker_config'

interface UiState {
  terminalOpen: boolean
  gestureDebugOpen: boolean
  speakerConfigOpen: boolean

  setTerminalOpen: (open: boolean) => void
  setGestureDebugOpen: (open: boolean) => void
  setSpeakerConfigOpen: (open: boolean) => void

  setOverlay: (name: OverlayName, open: boolean) => void
  isOverlayOpen: (name: OverlayName) => boolean
}

export const useUiStore = create<UiState>((set, get) => ({
  terminalOpen: false,
  gestureDebugOpen: false,
  speakerConfigOpen: false,

  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  setGestureDebugOpen: (gestureDebugOpen) => set({ gestureDebugOpen }),
  setSpeakerConfigOpen: (speakerConfigOpen) => set({ speakerConfigOpen }),

  setOverlay: (name, open) => {
    switch (name) {
      case 'terminal':       return set({ terminalOpen: open })
      case 'gesture_debug':  return set({ gestureDebugOpen: open })
      case 'speaker_config': return set({ speakerConfigOpen: open })
    }
  },

  isOverlayOpen: (name) => {
    const s = get()
    switch (name) {
      case 'terminal':       return s.terminalOpen
      case 'gesture_debug':  return s.gestureDebugOpen
      case 'speaker_config': return s.speakerConfigOpen
    }
  },
}))
