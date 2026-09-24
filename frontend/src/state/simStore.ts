import { create } from 'zustand'

/** Transport controls + HUD readout for the running simulation.
 *
 *  Deliberately tiny: the simulation STATE lives inside the engine and is
 *  mutated 60× a second inside useFrame. Putting positions in zustand would
 *  re-render React on every step. Only what a human reads goes through here,
 *  and even that is throttled by the renderer.
 */
interface SimState {
  playing: boolean
  /** Multiplier applied on top of the spec's timeScale. */
  speed: number
  /** Bumped to ask the running engine to restore its initial conditions. */
  resetToken: number
  /** Rows the HUD prints, pushed by the engine at ~4 Hz. */
  readout: Array<[string, string]>
  title: string
  /** Whether a simulation is mounted at all (drives HUD visibility). */
  active: boolean

  setPlaying: (v: boolean) => void
  toggle: () => void
  setSpeed: (v: number) => void
  reset: () => void
  setReadout: (rows: Array<[string, string]>) => void
  setActive: (v: boolean, title?: string) => void
}

export const SIM_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 10, 30]

export const useSimStore = create<SimState>((set) => ({
  playing: true,
  speed: 1,
  resetToken: 0,
  readout: [],
  title: '',
  active: false,

  setPlaying: (v) => set({ playing: v }),
  toggle: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (v) => set({ speed: Math.max(0.01, Math.min(100, v)) }),
  reset: () => set((s) => ({ resetToken: s.resetToken + 1 })),
  setReadout: (rows) => set({ readout: rows }),
  setActive: (v, title) => set(
    v ? { active: true, title: title ?? '', playing: true, speed: 1 }
      : { active: false, readout: [], title: '' },
  ),
}))
