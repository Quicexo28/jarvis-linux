// frontend/src/gestures/filters.ts
// One-Euro filter (Casiez, Roussel, Vogel — CHI 2012): jitter bajo en reposo,
// lag bajo en movimiento. El estándar para entrada tipo cursor.

export interface OneEuroParams {
  /** Cutoff mínimo (Hz): más bajo = más suave en reposo. */
  minCutoff: number
  /** Cuánto sube el cutoff con la velocidad: más alto = menos lag al moverse rápido. */
  beta: number
  /** Cutoff del filtro de derivada. */
  dCutoff: number
}

class LowPass {
  private y: number | null = null

  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : this.y + alpha * (x - this.y)
    return this.y
  }

  last(): number | null {
    return this.y
  }

  reset(): void {
    this.y = null
  }
}

function alphaFor(cutoffHz: number, dtMs: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  const dt = dtMs / 1000
  return dt / (dt + tau)
}

export class OneEuro {
  private x = new LowPass()
  private dx = new LowPass()
  private lastT: number | null = null

  constructor(private p: OneEuroParams) {}

  filter(value: number, tMs: number): number {
    if (this.lastT === null) {
      this.lastT = tMs
      this.dx.filter(0, 1)
      return this.x.filter(value, 1)
    }
    const dtMs = Math.max(1, tMs - this.lastT)
    this.lastT = tMs

    const prev = this.x.last()
    const rate = prev === null ? 0 : (value - prev) / (dtMs / 1000)
    const dxHat = this.dx.filter(rate, alphaFor(this.p.dCutoff, dtMs))
    const cutoff = this.p.minCutoff + this.p.beta * Math.abs(dxHat)
    return this.x.filter(value, alphaFor(cutoff, dtMs))
  }

  reset(): void {
    this.x.reset()
    this.dx.reset()
    this.lastT = null
  }
}

/** Envuelve un ángulo a [-π, π] para que cruzar ±π no salte. */
export function wrapAngle(a: number): number {
  let x = a
  while (x > Math.PI) x -= 2 * Math.PI
  while (x < -Math.PI) x += 2 * Math.PI
  return x
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
