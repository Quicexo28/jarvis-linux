// frontend/src/state/cursorStore.ts
// Estado VISUAL del cursor de mano. Vive aparte de `gestureStore` porque lo
// consume un solo componente (<GesturePointer/>): así la muestra de gesto sigue
// sin re-renderizar nada más, y el halo del objetivo enganchado no obliga a
// leer el DOM desde el render.
import { create } from 'zustand'

export interface CursorTargetBox {
  left: number
  top: number
  width: number
  height: number
}

interface CursorState {
  visible: boolean
  /** Píxeles de ventana, ya imantados. */
  x: number
  y: number
  pressed: boolean
  /** 0..1 — progreso del clic por permanencia. */
  dwell: number
  /** Rect del objetivo enganchado (para el halo), o null. */
  target: CursorTargetBox | null
  /** Sube en cada clic efectivo — dispara el destello sin guardar timestamps. */
  clickPulse: number
  set: (patch: Partial<Omit<CursorState, 'set' | 'pulse'>>) => void
  pulse: () => void
}

export const useCursorStore = create<CursorState>((set) => ({
  visible: false,
  x: 0,
  y: 0,
  pressed: false,
  dwell: 0,
  target: null,
  clickPulse: 0,
  set: (patch) => set(patch),
  pulse: () => set((s) => ({ clickPulse: s.clickPulse + 1 })),
}))
