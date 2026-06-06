/**
 * Pure helper functions for gesture rotation smoothing.
 * No React, no DOM — fully testable in Node.
 */

/**
 * Exponential Moving Average: moves prev toward current by alpha each step.
 * alpha=0 → no movement; alpha=1 → instant.
 * @param alpha - smoothing factor in [0, 1]; values outside this range will overshoot
 */
export function applyEMA(prev: number, current: number, alpha: number): number {
  return prev + alpha * (current - prev)
}

/**
 * Dead zone: returns 0 if abs(value) <= threshold, otherwise subtracts the
 * threshold from the magnitude so output starts at 0 and grows continuously.
 * This avoids the jump discontinuity of the hard-cut approach.
 * Negative threshold is treated as 0 (no dead zone).
 */
export function applyDeadZone(value: number, threshold: number): number {
  if (threshold <= 0) return value
  if (value > threshold) return value - threshold
  if (value < -threshold) return value + threshold
  return 0
}

/**
 * Non-linear sensitivity: sign(v) * |v|^exponent.
 * exponent > 1: slow near center, faster at extremes (precision + reach).
 * exponent = 1: linear (identity).
 */
export function applyNonLinear(value: number, exponent: number): number {
  if (value === 0) return 0
  return Math.sign(value) * Math.pow(Math.abs(value), exponent)
}
