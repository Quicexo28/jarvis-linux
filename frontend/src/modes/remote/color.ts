/**
 * Colour-wheel maths. Pure and Three-free so it stays Node-testable, like the
 * rest of the shared logic in this app.
 *
 * The wheel is drawn with a CSS conic-gradient, which starts at 12 o'clock and
 * runs clockwise — the geometry here matches that so the marker lands where the
 * finger is.
 */

/** Screen offset from the wheel centre → hue (deg) + saturation (0..1). */
export function pointToHs(dx: number, dy: number, radius: number): { h: number; s: number } {
  const h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360
  const dist = Math.sqrt(dx * dx + dy * dy)
  return { h, s: Math.min(1, radius > 0 ? dist / radius : 0) }
}

/** Inverse of pointToHs: where the marker goes, in offsets from the centre. */
export function hsToPoint(h: number, s: number, radius: number): { dx: number; dy: number } {
  const rad = h * Math.PI / 180
  const r = Math.min(1, Math.max(0, s)) * radius
  return { dx: Math.sin(rad) * r, dy: -Math.cos(rad) * r }
}

/** HSV (h in deg, s/v in 0..1) → 0-255 RGB triple. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] :
             [c, 0, x]
  const m = v - c
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ]
}

/** Six lowercase hex digits, no leading '#' — what rgb_ctl.py takes as argv. */
export function rgbToHex(r: number, g: number, b: number): string {
  return [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')
}

export function hsvToHex(h: number, s: number, v: number): string {
  return rgbToHex(...hsvToRgb(h, s, v))
}

/** '#RRGGBB' or 'rrggbb' → HSV (h in deg, s/v in 0..1). Inverse of hsvToHex. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const h6 = hex.replace('#', '').padStart(6, '0').slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h6.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max }
}
