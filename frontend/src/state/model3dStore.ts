import { create } from 'zustand'
import type { SimulationBody } from '../lib/sim/types'

/** Fields shared by every renderable object in the 3D scene.
 *  position/rotation are MATH coordinates (z up); the viewer applies the frame. */
export interface BaseSpec {
  /** Stable identity for legend toggles/removal. Auto-assigned when omitted. */
  id?: string
  title?: string
  /** Hex color. When omitted, a palette color is assigned by object index. */
  color?: string
  /** 0–1. Kind-specific translucent defaults let nested/overlapping solids show through. */
  opacity?: number
  wireframe?: boolean
  position?: [number, number, number]
  /** Euler radians, applied in math frame */
  rotation?: [number, number, number]
  scale?: number | [number, number, number]
}

export interface ParametricSpec extends BaseSpec {
  kind: 'parametric'
  x: string
  y: string
  z: string
  uRange: [number, number]
  vRange: [number, number]
  segments?: number
}

export interface PolytopeSpec extends BaseSpec {
  kind: 'polytope'
  type: 'hypercube' | 'cross'
  dimension: number
  /** Translucent 2-faces (default: on for hypercubes of dim ≥ 4). */
  faces?: boolean
  /** N-D auto-rotation speed multiplier (default 1). 0 freezes it. */
  speed?: number
  /** Force N-D auto-rotation on/off (default: on for dim ≥ 4). */
  spin?: boolean
  /** Color edges/faces by the 4th coordinate — depth cue for the extra dimension
   *  (default: on for dim ≥ 4). */
  colorByW?: boolean
}

export interface ImplicitSpec extends BaseSpec {
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
}

/** Exact solids — for compositions with precise tangency/containment
 *  (concentric spheres, a cube inscribed in a cylinder, ...). */
export interface PrimitiveSpec extends BaseSpec {
  kind: 'primitive'
  shape: 'sphere' | 'box' | 'cylinder' | 'cone' | 'torus'
  /** sphere/cylinder/cone: radius. torus: major radius. */
  radius?: number
  /** box: [sx, sy, sz] (a single number is also accepted → cube). */
  size?: [number, number, number] | number
  /** cylinder/cone height (axis = math z). */
  height?: number
  /** torus tube (minor) radius. */
  tube?: number
}

/** Parametric curve (x(t), y(t), z(t)) — splits at discontinuities. */
export interface CurveSpec extends BaseSpec {
  kind: 'curve'
  x: string
  y: string
  z?: string
  tRange: [number, number]
  samples?: number
}

/** Function graph: y = f(x) (planar curve) or z = f(x,y) (surface) — the
 *  variant is auto-detected from whether f uses the symbol y. */
export interface GraphSpec extends BaseSpec {
  kind: 'graph'
  f: string
  xRange?: [number, number]
  yRange?: [number, number]
  samples?: number
  segments?: number
}

/** Arrows from an origin. n-D vectors are perspective-projected to R³. */
export interface VectorsSpec extends BaseSpec {
  kind: 'vectors'
  vectors: number[][]
  labels?: string[]
  colors?: string[]
  origin?: [number, number, number]
  /** With exactly 2 independent vectors: draw span(v1,v2) as lattice + plane. */
  showSpan?: boolean
}

/** Analytic plane: normal+point, or explicit spanning vectors u,v. */
export interface PlaneSpec extends BaseSpec {
  kind: 'plane'
  normal?: [number, number, number]
  point?: [number, number, number]
  u?: [number, number, number]
  v?: [number, number, number]
  size?: number
}

/** Infinite line rendered as a long segment: point + direction. */
export interface LineSpec extends BaseSpec {
  kind: 'line'
  point?: [number, number, number]
  direction: [number, number, number]
  length?: number
  arrow?: boolean
}

/** Explicit vertex list — the shape the hand-capture mode produces, and the
 *  only kind whose geometry is edited point by point rather than by formula.
 *  With `height` it extrudes along the best-fit plane normal, which turns the
 *  same spec into a prism, a box, a cylinder (many-sided polygon) or, with
 *  `capScale: 0`, a pyramid/cone. */
export interface PolygonSpec extends BaseSpec {
  kind: 'polygon'
  /** MATH coords (z up). At least 3 for a face; 2 renders as a segment. */
  vertices: [number, number, number][]
  /** Close the ring back to the first vertex (default true). */
  closed?: boolean
  /** Fill the face (default true when closed). */
  fill?: boolean
  /** Extrude this far along the plane normal. Omit/0 = flat figure. */
  height?: number
  /** Top cap size relative to the base (default 1). 0 = apex → pyramid/cone. */
  capScale?: number
}

/** A time-evolving physical system rather than a static figure: orbital
 *  mechanics, a black hole, forces on particles, a vector field, a chaotic
 *  attractor. The physics lives in `lib/sim/`; this is only the wire shape.
 *  Discriminated a second time by `system`. */
export type SimulationSpec = BaseSpec & { kind: 'simulation' } & SimulationBody

export type Model3DSpec =
  | ParametricSpec
  | PolytopeSpec
  | ImplicitSpec
  | PrimitiveSpec
  | CurveSpec
  | GraphSpec
  | VectorsSpec
  | PlaneSpec
  | LineSpec
  | PolygonSpec
  | SimulationSpec

export const MODEL3D_KINDS: Model3DSpec['kind'][] = [
  'parametric', 'polytope', 'implicit', 'primitive', 'curve', 'graph', 'vectors', 'plane', 'line',
  'polygon', 'simulation',
]

export interface SceneOptions {
  title?: string
  /** Draw labeled x/y/z axes. Default: auto (on when any analytic kind is present). */
  axes?: boolean
  /** Draw a reference grid on this math plane. true = 'xy'. */
  grid?: boolean | 'xy' | 'xz' | 'yz'
  axisLength?: number
  background?: string
}

let seq = 0
const withId = (spec: Model3DSpec): Model3DSpec =>
  spec.id ? spec : { ...spec, id: `obj-${Date.now().toString(36)}-${seq++}` }

const asArray = (specs: Model3DSpec | Model3DSpec[]): Model3DSpec[] =>
  (Array.isArray(specs) ? specs : [specs]).map(withId)

interface Model3DState {
  open: boolean
  objects: Model3DSpec[]
  scene: SceneOptions
  /** Replace the scene contents (single spec or array) and open the viewer. */
  show: (specs: Model3DSpec | Model3DSpec[], scene?: SceneOptions) => void
  /** Append object(s) to the current scene (opens the viewer if closed). */
  add: (specs: Model3DSpec | Model3DSpec[]) => void
  /** Replace one object with a patched copy. Editing MUST go through here:
   *  every per-kind component memoizes on spec identity, so mutating fields
   *  in place repaints nothing. */
  update: (id: string, patch: Partial<Model3DSpec>) => void
  /** Remove one object by id (legend ×). */
  remove: (id: string) => void
  hide: () => void
}

export const useModel3dStore = create<Model3DState>((set) => ({
  open: false,
  objects: [],
  scene: {},
  show: (specs, scene) => set({ open: true, objects: asArray(specs), scene: scene ?? {} }),
  add: (specs) => set((s) => ({ open: true, objects: [...s.objects, ...asArray(specs)] })),
  update: (id, patch) => set((s) => ({
    objects: s.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as Model3DSpec) : o)),
  })),
  remove: (id) => set((s) => ({ objects: s.objects.filter((o) => o.id !== id) })),
  hide: () => set({ open: false }),
}))
