import { create } from 'zustand'
import { DEFAULT_OUTPUT } from '../gestures/types'
import type { GestureOutput, DebugFrame } from '../gestures/types'

export type GestureStatus = 'off' | 'starting' | 'running' | 'error'

interface GestureState {
  enabled: boolean
  output: GestureOutput
  /** Pipeline lifecycle: off → starting (cámara/modelo) → running | error. */
  status: GestureStatus
  /** running: detalle del backend de inferencia; error: mensaje legible. */
  statusDetail: string
  fps: number
  /** Landmarks post-swap para GestureDebugView; null cuando el panel está cerrado. */
  debugFrame: DebugFrame | null
  setEnabled: (enabled: boolean) => void
  setOutput: (output: GestureOutput) => void
  setStatus: (status: GestureStatus, detail?: string) => void
  setFps: (fps: number) => void
  setDebugFrame: (frame: DebugFrame | null) => void
}

export const useGestureStore = create<GestureState>((set) => ({
  enabled: false,
  output: DEFAULT_OUTPUT,
  status: 'off',
  statusDetail: '',
  fps: 0,
  debugFrame: null,
  setEnabled: (enabled) => set({ enabled }),
  setOutput: (output) => set({ output }),
  setStatus: (status, detail = '') => set({ status, statusDetail: detail }),
  setFps: (fps) => set({ fps }),
  setDebugFrame: (debugFrame) => set({ debugFrame }),
}))
