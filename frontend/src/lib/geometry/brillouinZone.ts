/**
 * First Brillouin zone clipping planes for common lattices.
 * Returns plane data { normal, constant } where a point p is INSIDE the zone
 * when normal·p + constant >= 0 for all planes (matches THREE.Plane convention).
 * Pure data — no Three.js — so it's testable and the viewer maps it to THREE.Plane.
 */

export interface PlaneData {
  /** Unit-ish inward normal [x,y,z]. */
  normal: [number, number, number]
  /** Plane constant: inside when normal·p + constant >= 0. */
  constant: number
}

export type BrillouinLattice = 'fcc' | 'bcc' | 'sc'

/**
 * Build the first Brillouin zone faces scaled so the {100} faces sit at ±scale.
 *
 * - sc  (simple cubic): cube — 6 {100} faces.
 * - fcc: truncated octahedron — 6 {100} squares + 8 {111} hexagons. (Copper.)
 * - bcc: rhombic dodecahedron — 12 {110} faces.
 */
export function brillouinZonePlanes(lattice: BrillouinLattice, scale = Math.PI): PlaneData[] {
  const planes: PlaneData[] = []

  // 6 {100} planes: |x|,|y|,|z| <= scale. Inward normal points toward origin.
  const axes: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  if (lattice === 'sc' || lattice === 'fcc') {
    for (const a of axes) {
      for (const s of [1, -1]) {
        planes.push({ normal: [-s * a[0], -s * a[1], -s * a[2]], constant: scale })
      }
    }
  }

  // 8 {111} planes (fcc): |x|+|y|+|z| <= 1.5*scale → truncated octahedron.
  if (lattice === 'fcc') {
    const inv = 1 / Math.sqrt(3)
    const d = 1.5 * scale * inv
    for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
      planes.push({ normal: [-sx * inv, -sy * inv, -sz * inv], constant: d })
    }
  }

  // 12 {110} planes (bcc): rhombic dodecahedron. |xi| + |xj| <= scale per axis pair.
  if (lattice === 'bcc') {
    const inv = 1 / Math.sqrt(2)
    const d = scale * inv
    const pairs: [number, number][] = [[0, 1], [1, 2], [0, 2]]
    for (const [i, j] of pairs) {
      for (const si of [1, -1]) for (const sj of [1, -1]) {
        const n: [number, number, number] = [0, 0, 0]
        n[i] = -si * inv
        n[j] = -sj * inv
        planes.push({ normal: n, constant: d })
      }
    }
  }

  return planes
}
