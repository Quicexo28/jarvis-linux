/** Simulation spec types — the wire contract the LLM writes and the viewer runs.
 *
 *  Everything here is plain data (no Three, no React) so the engine modules stay
 *  Node-testable, same rule as lib/geometry/.
 *
 *  Coordinates are MATH coordinates (z up), like every other 3D spec; the viewer
 *  applies the -π/2 X frame rotation. Orbital systems therefore live in the xy
 *  plane with z = north ecliptic pole, which is the physical convention already.
 */

export type Vec3 = [number, number, number]

/* ---------------- Shared ---------------- */

export interface SimBody {
  name?: string
  /** Solar masses for orbital systems; arbitrary consistent units elsewhere. */
  mass: number
  position: Vec3
  velocity?: Vec3
  /** Display radius in scene units (bodies are drawn exaggerated on purpose). */
  radius?: number
  color?: string
  /** Pinned: never integrated. Use for a central mass you want exactly at rest. */
  fixed?: boolean
  /** Extra HUD facts (real radius, period, ...) — never used by the math. */
  info?: Record<string, string | number>

  /* --- Apariencia física. Nada de esto entra en la integración: son los
     datos que hacen que el cuerpo se VEA como el cuerpo real. --- */

  /** Clave de la tabla de texturas (`sun`, `earth`, `saturn`, ...) o una ruta
   *  bajo /textures/. Sin esto el cuerpo cae al color plano de siempre. */
  texture?: string
  /** Oblicuidad del eje en GRADOS respecto a la normal de la órbita.
   *  Tierra 23.44, Urano 97.77, Venus 177.36 (retrógrado). */
  tilt?: number
  /** Periodo de rotación en las MISMAS unidades de tiempo del sistema
   *  (días para los orbitales). Negativo = retrógrado. 0/ausente = no gira. */
  rotationPeriod?: number
  /** Sistema de anillos, en radios del cuerpo. Saturno: [1.24, 2.27]. */
  rings?: { inner: number; outer: number; texture?: string; tilt?: number }
  /** Es una estrella: se ilumina a sí misma y alumbra a las demás, en vez de
   *  recibir luz. Marca al primario de `solar`, `binary`, `trappist`. */
  emissive?: boolean
}

/** Which live arrows to draw attached to each body. */
export type VectorOverlay = 'velocity' | 'acceleration' | 'force' | 'momentum'

/* ---------------- nbody ---------------- */

/** Presets with real data. `solar` uses J2000 orbital elements. */
export type NBodyPreset =
  | 'solar' | 'inner' | 'outer' | 'earth-moon' | 'jupiter-moons'
  | 'binary' | 'figure8' | 'lagrange' | 'trappist'

export interface NBodySpec {
  system: 'nbody'
  preset?: NBodyPreset
  bodies?: SimBody[]
  /** Gravitational constant in the working units. Default: AU³/(M☉·day²). */
  G?: number
  /** Plummer softening length — kills the 1/r² singularity on close passes. */
  softening?: number
  /** `kepler` propagates exact ellipses (zero drift, any date). `nbody`
   *  integrates real mutual attraction (shows resonances/perturbations). */
  mode?: 'kepler' | 'nbody'
  /** ISO date the propagation starts from (kepler mode). Default: today. */
  startDate?: string
  /** Draw each body's osculating orbit as a static ellipse. */
  showOrbits?: boolean

  /* --- Física por encima de Newton. Solo actúan en `mode: 'nbody'`: el modo
     kepler propaga elipses analíticas y no integra fuerzas. --- */

  /** Corrección relativista 1PN respecto a la masa dominante. Es lo que hace
   *  precesar a Mercurio (43"/siglo). Default: true en los presets solares. */
  relativistic?: boolean
  /** Achatamiento J2 de los cuerpos que lo tengan tabulado. Domina la dinámica
   *  de las lunas de Júpiter (J2 = 0.0147, 14× el de la Tierra sobre un radio
   *  11× mayor). Default true. */
  oblateness?: boolean
  /** Dos cuerpos que se tocan se FUNDEN, conservando masa y momento. Default
   *  false: en el sistema solar real nada choca, y activarlo por defecto haría
   *  que un `softening` mal puesto se comiera planetas. */
  collisions?: boolean
}

/* ---------------- blackhole ---------------- */

export interface BlackHoleSpec {
  system: 'blackhole'
  /** Mass in geometric units (G = c = 1). Horizon = 2M, photon sphere 3M, ISCO 6M. */
  mass?: number
  /** Accretion disk inner/outer radius in M. Default [6, 20] (inner = ISCO). */
  disk?: [number, number] | false
  /** Disk particle count (capped). Default 3000. */
  diskParticles?: number
  /** Test masses on precessing orbits: [semi-latus rectum in M, eccentricity]. */
  orbits?: Array<{ p: number; e: number; color?: string; label?: string }>
  /** Light rays fired past the hole at these impact parameters (in M). */
  rays?: number[] | number
  /** Show horizon / photon sphere / ISCO reference markers. Default true. */
  markers?: boolean
  /** Doppler beaming + gravitational redshift coloring of the disk. Default true. */
  relativistic?: boolean
  /** Lente gravitacional del fondo: el campo de estrellas se deflecta por la
   *  misma ecuación de geodésica nula que ya usan los rayos, así que aparecen
   *  el anillo de Einstein y la imagen secundaria. Default true. */
  lensing?: boolean
}

/* ---------------- dynamics ---------------- */

export interface DynamicsParticle {
  name?: string
  position: Vec3
  velocity?: Vec3
  mass?: number
  /** Electric charge — only used by the Lorentz force term. */
  charge?: number
  color?: string
  radius?: number
  fixed?: boolean
}

/** Newtonian particles under composable forces. Every expression sees
 *  x,y,z,vx,vy,vz,t,m,q plus r (distance to origin) and speed. */
export interface DynamicsSpec {
  system: 'dynamics'
  particles?: DynamicsParticle[]
  preset?: 'projectile' | 'spring' | 'cyclotron' | 'orbit' | 'collision'
  /** Free-form force, added to every convenience term below. mathjs strings. */
  force?: { fx?: string; fy?: string; fz?: string }
  /** Uniform gravity magnitude along -z. */
  gravity?: number
  /** Linear drag: F = -k·v. Quadratic: dragQuadratic. */
  drag?: number
  dragQuadratic?: number
  /** Hooke spring toward an anchor. */
  spring?: { k: number; anchor?: Vec3; restLength?: number }
  /** Uniform or expression fields for the Lorentz force F = q(E + v×B). */
  eField?: Vec3 | [string, string, string]
  bField?: Vec3 | [string, string, string]
  /** Mutual gravity between the particles themselves. */
  mutualGravity?: number
  /** Bounce off a floor at z = floor, and/or a centered box. */
  floor?: number
  box?: Vec3
  restitution?: number
  /** The floor absorbs the impact completely: a particle that lands stops dead
   *  instead of sliding on forever (there is no friction term). This is what
   *  makes a range comparison readable — each trail ends where it landed. */
  stopOnFloor?: boolean
  /** Las partículas CHOCAN entre sí en vez de atravesarse. Impulso normal con
   *  `restitution`; sin esto el preset `collision` era una caja de fantasmas.
   *  Coste O(n²) sobre ≤64 partículas: despreciable. */
  collisions?: boolean
  /** Coeficiente de rozamiento de Coulomb en el contacto con suelo y paredes.
   *  Es lo que hace que algo que cae RUEDE hasta pararse, en vez de deslizar
   *  para siempre (μ = 0) o clavarse en seco (`stopOnFloor`). */
  friction?: number
  /** Live arrows attached to each particle. */
  vectors?: VectorOverlay[]
  /** Arrow length per unit magnitude. Default auto. */
  vectorScale?: number
}

/* ---------------- field ---------------- */

export interface FieldSpec {
  system: 'field'
  /** Canonical field pictures: dipole, vortex, source, wire, saddle, wave. */
  preset?: 'dipole' | 'vortex' | 'source' | 'wire' | 'saddle' | 'wave'
  /** Components as mathjs expressions in x,y,z,t (r = |x| is also in scope). */
  fx?: string
  fy?: string
  fz?: string
  /** Sampling box half-size, default 5. */
  extent?: number
  /** Arrows per axis (capped 12 → 1728 arrows). Default 7. */
  density?: number
  /** Slice the arrows to one plane instead of a 3D lattice. */
  plane?: 'xy' | 'xz' | 'yz'
  /** Massless tracers advected by the field (this is what makes it move). */
  tracers?: number
  /** Streamline seeds → static integral curves of the field. */
  streamlines?: number
  /** Color arrows by |F| instead of a flat color. Default true. */
  colorByMagnitude?: boolean
}

/* ---------------- ode ---------------- */

/** Abstract dynamical system ẋ = f(x, t) drawn as a trajectory in 3 chosen
 *  state coordinates. Lorenz, Rössler, double pendulum in phase space, ... */
export interface OdeSpec {
  system: 'ode'
  preset?: 'lorenz' | 'rossler' | 'double-pendulum' | 'van-der-pol' | 'chua'
  /** State variable names, e.g. ['x','y','z']. */
  vars?: string[]
  /** Derivative expression per variable, in terms of vars + t. */
  d?: string[]
  /** One row per trajectory. */
  init?: number[][]
  /** Which 3 vars map to the drawn axes. Each entry is an EXPRESSION over the
   *  state, so a pendulum integrated in (θ, ω) can still be drawn in real space.
   *  Default: the first three variables. */
  axes?: [string, string, string]
}

/* ---------------- union ---------------- */

export type SimSystemSpec = NBodySpec | BlackHoleSpec | DynamicsSpec | FieldSpec | OdeSpec

export type SimSystem = SimSystemSpec['system']

export const SIM_SYSTEMS: SimSystem[] = ['nbody', 'blackhole', 'dynamics', 'field', 'ode']

/** Fields every simulation accepts on top of its system-specific ones. */
export interface SimCommon {
  /** Integrator step in simulation units. Fixed — never tied to frame time. */
  dt?: number
  /** Simulation units advanced per real second. */
  timeScale?: number
  /** Trail length in points (0/false = no trail). */
  trail?: number | false
  /** Start paused. */
  paused?: boolean
  /** Multiply every body's display radius. */
  bodyScale?: number
  /** Scene units per simulation length unit. Default: auto-fit. */
  viewScale?: number
  /** Show the physics HUD (time, energy drift, per-system readouts). */
  hud?: boolean

  /* --- Look realista. Por defecto ENCENDIDO: un sistema solar de esferas
     planas bajo luz cyan no se parece a nada. Se apaga para el modo
     esquemático (diagramas, figuras abstractas). --- */

  /** Texturas, iluminación física y anillos. Default true. */
  realistic?: boolean
  /** Fondo de estrellas (Vía Láctea). Default: true si `realistic`. */
  starfield?: boolean
  /** Sombras proyectadas — eclipses reales. Cuesta un render extra por luz,
   *  así que default: true solo en sistemas de ≤ 12 cuerpos. */
  shadows?: boolean
}

export type SimulationBody = SimCommon & SimSystemSpec

/* ---------------- runtime ---------------- */

/** What a running engine exposes to the renderer, once per step. */
export interface SimFrame {
  /** Simulation time elapsed, in the system's own units. */
  t: number
  /** Flat xyz positions in SCENE units, 3 per body. */
  positions: Float32Array
  /** Flat xyz velocities in SIM units (for vector overlays). */
  velocities?: Float32Array
  /** Flat xyz accelerations in SIM units. */
  accelerations?: Float32Array
  /** Human-readable rows for the HUD. */
  readout?: Array<[string, string]>
}

export interface SimEngine {
  readonly bodyCount: number
  readonly colors: string[]
  readonly radii: number[]
  readonly names: string[]
  /** Advance exactly one fixed step. */
  step(): void
  /** Current state, written into a reused frame object (no allocation). */
  frame(): SimFrame
  /** Restore initial conditions. */
  reset(): void
}
