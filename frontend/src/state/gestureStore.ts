import { create } from 'zustand'
import type { GestureOutput } from '../gestures/types'

const DEFAULT_OUTPUT: GestureOutput = {
  grab: { active: false, deltaX: 0, deltaY: 0, deltaAngle: 0 },
  point: { active: false, screenX: 0, screenY: 0 },
  pinch: { active: false, zoom: 1.0, paused: false },
  pinkyExtended: false,
  click: false,
  back: false,
  debug: { leftDetected: false, rightDetected: false, leftGesture: 'idle', rightGesture: 'idle' },
}

interface GestureState {
  enabled: boolean
  output: GestureOutput
  setEnabled: (enabled: boolean) => void
  setOutput: (output: GestureOutput) => void
}

export const useGestureStore = create<GestureState>((set) => ({
  enabled: false,
  output: DEFAULT_OUTPUT,
  setEnabled: (enabled) => set({ enabled }),
  setOutput: (output) => set({ output }),
}))
