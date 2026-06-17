import { create } from 'zustand'

export interface ParametricSpec {
  kind: 'parametric'
  x: string
  y: string
  z: string
  uRange: [number, number]
  vRange: [number, number]
  segments?: number
  title?: string
  color?: string
  position?: [number, number, number]
}

export interface PolytopeSpec {
  kind: 'polytope'
  type: 'hypercube' | 'cross'
  dimension: number
  title?: string
  position?: [number, number, number]
}

export interface ImplicitSpec {
  kind: 'implicit'
  /** mathjs expression f(x,y,z); the isosurface f = isoValue is rendered.
   *  For Fermi surfaces this is the band energy E(kx,ky,kz). */
  f: string
  isoValue: number
  /** Sampling box [min,max] per axis. Default [-π, π]. */
  bounds?: [number, number]
  /** Marching-cubes cells per axis (capped 64). Default 40. */
  resolution?: number
  /** Clip the surface to the 1st Brillouin zone of this lattice (e.g. 'fcc' = copper). */
  brillouinZone?: 'fcc' | 'bcc' | 'sc'
  title?: string
  color?: string
  position?: [number, number, number]
}

export type Model3DSpec = ParametricSpec | PolytopeSpec | ImplicitSpec

interface Model3DState {
  open: boolean
  specs: Model3DSpec[]
  show: (spec: Model3DSpec) => void
  hide: () => void
  setSpecs: (specs: Model3DSpec[]) => void
  addSpec: (spec: Model3DSpec) => void
  clearSpecs: () => void
}

export const useModel3dStore = create<Model3DState>((set) => ({
  open: false,
  specs: [],
  show: (spec) => set({ open: true, specs: [spec] }),
  hide: () => set({ open: false }),
  setSpecs: (specs) => set({ open: specs.length > 0, specs }),
  addSpec: (spec) => set((s) => ({ open: true, specs: [...s.specs, spec] })),
  clearSpecs: () => set({ open: false, specs: [] }),
}))
