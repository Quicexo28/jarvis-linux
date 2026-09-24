import { create } from 'zustand'
import { DEFAULT_OUTPUT } from '../gestures/types'
import type { GestureOutput, HandsFrame } from '../gestures/types'

export type GestureStatus = 'off' | 'starting' | 'running' | 'error'

interface GestureState {
  enabled: boolean
  output: GestureOutput
  /** Pipeline lifecycle: off → starting (cámara/modelo) → running | error. */
  status: GestureStatus
  /** running: detalle del backend de inferencia; error: mensaje legible. */
  statusDetail: string
  fps: number
  /**
   * Landmarks crudos post-swap — canal ÚNICO (panel de debug y motor de formas
   * beben del mismo). null mientras nadie los pida.
   */
  handsFrame: HandsFrame | null
  /**
   * Cuántos consumidores quieren landmarks ahora mismo. Refcount, no booleano:
   * dos consumidores a la vez: cerrar uno no puede dejar
   * al otro sin datos (mismo motivo que `micFeed` cuenta en vez de togglear).
   */
  landmarkConsumers: number
  setEnabled: (enabled: boolean) => void
  setOutput: (output: GestureOutput) => void
  setStatus: (status: GestureStatus, detail?: string) => void
  setFps: (fps: number) => void
  setHandsFrame: (frame: HandsFrame | null) => void
  /** Pide landmarks. Devuelve la función de liberación (llamarla una sola vez). */
  acquireLandmarks: () => () => void
}

export const useGestureStore = create<GestureState>((set, get) => ({
  enabled: false,
  output: DEFAULT_OUTPUT,
  status: 'off',
  statusDetail: '',
  fps: 0,
  handsFrame: null,
  landmarkConsumers: 0,
  setEnabled: (enabled) => set({ enabled }),
  setOutput: (output) => set({ output }),
  setStatus: (status, detail = '') => set({ status, statusDetail: detail }),
  setFps: (fps) => set({ fps }),
  setHandsFrame: (handsFrame) => set({ handsFrame }),
  acquireLandmarks: () => {
    set((s) => ({ landmarkConsumers: s.landmarkConsumers + 1 }))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = Math.max(0, get().landmarkConsumers - 1)
      set(next === 0 ? { landmarkConsumers: 0, handsFrame: null } : { landmarkConsumers: next })
    }
  },
}))
