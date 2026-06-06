/**
 * Snap a continuous ring angle (in slot units) to the nearest integer slot,
 * wrapping modulo numSlots.
 */
export function snapToNearestSlot(ringAngle: number, numSlots: number): number {
  const rounded = Math.round(ringAngle)
  return ((rounded % numSlots) + numSlots) % numSlots
}
