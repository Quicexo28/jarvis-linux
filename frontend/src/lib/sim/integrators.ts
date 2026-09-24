/** Fixed-step integrators. Allocation-free after construction: every buffer is
 *  preallocated, because these run inside useFrame on a WebKitGTK/iGPU box where
 *  per-frame garbage shows up as jank (see CLAUDE.md gesture-pipeline notes).
 *
 *  The whole point of fixed steps is determinism: the simulation must not change
 *  its trajectory because the browser dropped a frame. Real elapsed time only
 *  decides HOW MANY steps to run (see FixedClock), never how big they are.
 */

/** ẏ = f(t, y) — writes the derivative into `out`. */
export type Derivative = (t: number, y: Float64Array, out: Float64Array) => void

/** Classic 4th-order Runge-Kutta. O(dt⁴) local error — the default for
 *  non-conservative systems (drag, forced oscillators, attractors). */
export class Rk4 {
  private readonly k1: Float64Array
  private readonly k2: Float64Array
  private readonly k3: Float64Array
  private readonly k4: Float64Array
  private readonly tmp: Float64Array

  constructor(readonly n: number, private readonly f: Derivative) {
    this.k1 = new Float64Array(n)
    this.k2 = new Float64Array(n)
    this.k3 = new Float64Array(n)
    this.k4 = new Float64Array(n)
    this.tmp = new Float64Array(n)
  }

  /** Advances `y` in place by dt. Returns the new time. */
  step(t: number, y: Float64Array, dt: number): number {
    const { k1, k2, k3, k4, tmp, n, f } = this
    f(t, y, k1)
    for (let i = 0; i < n; i++) tmp[i] = y[i] + (dt / 2) * k1[i]
    f(t + dt / 2, tmp, k2)
    for (let i = 0; i < n; i++) tmp[i] = y[i] + (dt / 2) * k2[i]
    f(t + dt / 2, tmp, k3)
    for (let i = 0; i < n; i++) tmp[i] = y[i] + dt * k3[i]
    f(t + dt, tmp, k4)
    const h = dt / 6
    for (let i = 0; i < n; i++) y[i] += h * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])
    return t + dt
  }
}

/** a(x) → acceleration field for second-order systems. Writes into `out`. */
export type AccelField = (pos: Float64Array, out: Float64Array, t: number) => void

/** Velocity Verlet — symplectic, time-reversible, 2nd order.
 *
 *  Chosen over RK4 for gravity even though RK4 is higher order: RK4 leaks energy
 *  monotonically, so a planet SPIRALS after a few thousand orbits. Verlet's error
 *  stays bounded and oscillates, so the orbit keeps closing. That is exactly the
 *  "precisión" a solar system needs on screen for minutes at a time.
 */
export class VelocityVerlet {
  private readonly aCur: Float64Array
  private readonly aNext: Float64Array
  /** a(t) is cached across steps; primed on the first step, not in the ctor,
   *  so construction stays side-effect free. */
  private primed = false

  constructor(readonly n: number, private readonly accel: AccelField) {
    this.aCur = new Float64Array(n)
    this.aNext = new Float64Array(n)
  }

  /** Advances position+velocity arrays (same length) in place. */
  step(t: number, pos: Float64Array, vel: Float64Array, dt: number): number {
    const { aCur, aNext, accel, n } = this
    if (!this.primed) { accel(pos, aCur, t); this.primed = true }
    const half = 0.5 * dt * dt
    for (let i = 0; i < n; i++) pos[i] += vel[i] * dt + half * aCur[i]
    accel(pos, aNext, t + dt)
    const hdt = 0.5 * dt
    for (let i = 0; i < n; i++) {
      vel[i] += hdt * (aCur[i] + aNext[i])
      aCur[i] = aNext[i]
    }
    return t + dt
  }

  /** Current accelerations (valid after the first step) — for force arrows. */
  get acceleration(): Float64Array { return this.aCur }

  /** Forget the cached a(t) — call after teleporting bodies. */
  invalidate() { this.primed = false }
}

/** Turns wall-clock frame deltas into a whole number of fixed steps.
 *
 *  Caps the backlog so a stalled tab (or a 2 s GC pause) can't queue thousands of
 *  steps and freeze the renderer trying to catch up — the classic "spiral of
 *  death". Dropped time is discarded: the sim runs slow-motion for one frame
 *  rather than locking the main thread. */
export class FixedClock {
  private acc = 0
  /** Simulation time actually advanced so far. */
  t = 0

  constructor(
    /** Fixed step in simulation units. */
    public dt: number,
    /** Simulation units per real second. */
    public timeScale: number,
    /** Hard ceiling on steps per frame. */
    public maxStepsPerFrame = 240,
  ) {}

  /** Returns how many steps to run for this frame. */
  pending(realDtSec: number): number {
    // Ignore absurd deltas (tab restored from background, breakpoint hit).
    const clamped = Math.min(Math.max(realDtSec, 0), 0.25)
    this.acc += clamped * this.timeScale
    let steps = Math.floor(this.acc / this.dt)
    if (steps <= 0) return 0
    if (steps > this.maxStepsPerFrame) {
      steps = this.maxStepsPerFrame
      this.acc = 0 // drop the backlog instead of chasing it
    } else {
      this.acc -= steps * this.dt
    }
    this.t += steps * this.dt
    return steps
  }

  reset() { this.acc = 0; this.t = 0 }
}

/** Ring buffer of xyz points, one per tracked body, kept in a flat Float32Array
 *  ready to hand to a THREE.BufferAttribute without copying. */
export class TrailBuffer {
  readonly data: Float32Array
  /** Points written so far, per body (saturates at capacity). */
  private filled: Int32Array
  private head: Int32Array

  constructor(readonly bodies: number, readonly capacity: number) {
    this.data = new Float32Array(bodies * capacity * 3)
    this.filled = new Int32Array(bodies)
    this.head = new Int32Array(bodies)
  }

  push(body: number, x: number, y: number, z: number) {
    const h = this.head[body]
    const base = (body * this.capacity + h) * 3
    this.data[base] = x; this.data[base + 1] = y; this.data[base + 2] = z
    this.head[body] = (h + 1) % this.capacity
    if (this.filled[body] < this.capacity) this.filled[body]++
  }

  /** Points currently stored for a body. */
  count(body: number): number { return this.filled[body] }

  /** Copies a body's trail into `out` in chronological order.
   *  Returns the number of points written. */
  ordered(body: number, out: Float32Array): number {
    const n = this.filled[body]
    const cap = this.capacity
    const start = (this.head[body] - n + cap) % cap
    for (let i = 0; i < n; i++) {
      const src = (body * cap + ((start + i) % cap)) * 3
      const dst = i * 3
      out[dst] = this.data[src]
      out[dst + 1] = this.data[src + 1]
      out[dst + 2] = this.data[src + 2]
    }
    return n
  }

  clear() { this.filled.fill(0); this.head.fill(0) }
}
