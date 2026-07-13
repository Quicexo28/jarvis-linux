// E2E del engine con manos sintéticas de 21 landmarks: valida que la geometría
// real (curl ratios, aperturas, gaps) atraviesa features → pose → dynamics y
// produce las funciones de producto de cada gesto.
import { test, expect, beforeEach } from 'vitest'
import { GestureEngine } from './engine'
import type { HandFrame, Vec3 } from './types'

const DT = 66

type FingerMode = 'extended' | 'curled' | 'half'

interface HandOpts {
  thumb?: FingerMode
  index?: FingerMode
  middle?: FingerMode
  ring?: FingerMode
  pinky?: FingerMode
  /** Dirección lateral del índice/medio (spread de la V). */
  peace?: 'sep' | 'close'
  /** Coloca la punta del pulgar a esta distancia 3D de la punta del índice (metros world). */
  thumbToIndexDist?: number
  cx?: number
  cy?: number
  roll?: number
  palmImage?: number
  tipImage?: { x: number; y: number }
}

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z })
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z)
const scale = (a: Vec3, s: number): Vec3 => v(a.x * s, a.y * s, a.z * s)
const norm = (a: Vec3): Vec3 => {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) || 1
  return scale(a, 1 / l)
}

/** Cadena mcp→pip→dip→tip según el modo (recto / doblado 90° / plegado). */
function fingerChain(mcp: Vec3, dir: Vec3, mode: FingerMode): [Vec3, Vec3, Vec3] {
  const d = norm(dir)
  const p = norm(v(-d.y, d.x, 0)) // perpendicular en el plano
  if (mode === 'extended') {
    return [add(mcp, scale(d, 0.025)), add(mcp, scale(d, 0.045)), add(mcp, scale(d, 0.065))]
  }
  if (mode === 'half') {
    const pip = add(mcp, scale(d, 0.025))
    const dip = add(pip, scale(p, 0.02))
    return [pip, dip, add(dip, scale(p, 0.02))]
  }
  // curled: la punta vuelve hacia el mcp
  const pip = add(mcp, scale(d, 0.025))
  const dip = add(pip, scale(p, 0.02))
  return [pip, dip, add(dip, add(scale(d, -0.02), scale(p, -0.005)))]
}

function makeHand(opts: HandOpts = {}): HandFrame {
  const {
    thumb = 'extended', index = 'extended', middle = 'extended',
    ring = 'extended', pinky = 'extended',
    peace, thumbToIndexDist,
    cx = 0.5, cy = 0.5, roll = 0, palmImage = 0.18,
    tipImage = { x: cx, y: cy - 0.25 },
  } = opts

  const world: Vec3[] = new Array(21)
  world[0] = v(0, 0, 0)
  const up = v(0, -1, 0)

  let indexDir = up
  let middleDir = up
  if (peace === 'sep') { indexDir = norm(v(0.3, -1, 0)); middleDir = norm(v(-0.3, -1, 0)) }
  if (peace === 'close') { indexDir = norm(v(-0.15, -1, 0)); middleDir = norm(v(0.15, -1, 0)) }

  const defs: Array<{ mcpIdx: number; mcp: Vec3; dir: Vec3; mode: FingerMode }> = [
    { mcpIdx: 5, mcp: v(0.03, -0.088, 0), dir: indexDir, mode: index },
    { mcpIdx: 9, mcp: v(0, -0.09, 0), dir: middleDir, mode: middle },
    { mcpIdx: 13, mcp: v(-0.025, -0.088, 0), dir: up, mode: ring },
    { mcpIdx: 17, mcp: v(-0.045, -0.08, 0), dir: up, mode: pinky },
  ]
  for (const f of defs) {
    world[f.mcpIdx] = f.mcp
    const [pip, dip, tip] = fingerChain(f.mcp, f.dir, f.mode)
    world[f.mcpIdx + 1] = pip
    world[f.mcpIdx + 2] = dip
    world[f.mcpIdx + 3] = tip
  }

  // Pulgar (lm 1-4): recto hacia un objetivo (ratio 1.0 → no 'contracted', pasa
  // el guard anti-puño) o plegado si thumb='curled'.
  const cmc = v(0.025, -0.02, 0)
  world[1] = cmc
  if (thumbToIndexDist !== undefined) {
    const indexTip = world[8]
    // Punta a la distancia pedida de la punta del índice, alejándose en +x.
    const target = add(indexTip, v(thumbToIndexDist, 0, 0))
    world[2] = add(cmc, scale(add(target, scale(cmc, -1)), 1 / 3))
    world[3] = add(cmc, scale(add(target, scale(cmc, -1)), 2 / 3))
    world[4] = target
  } else {
    const [mcp, ip, tip] = fingerChain(cmc, norm(v(0.7, -1, 0)), thumb === 'curled' ? 'curled' : 'extended')
    world[2] = mcp
    world[3] = ip
    world[4] = tip
  }

  // Image landmarks: el engine usa 0 (muñeca), 8 (punta índice) y 9 (MCP medio).
  const image: Vec3[] = new Array(21).fill(v(cx, cy))
  image[0] = v(cx, cy)
  image[9] = add(v(cx, cy), v(Math.sin(roll) * palmImage, -Math.cos(roll) * palmImage))
  image[8] = v(tipImage.x, tipImage.y)

  return { image, world, score: 0.95 }
}

const fist = (o: HandOpts = {}) => makeHand({ thumb: 'curled', index: 'curled', middle: 'curled', ring: 'curled', pinky: 'curled', ...o })
const pointing = (o: HandOpts = {}) => makeHand({ thumb: 'curled', index: 'extended', middle: 'curled', ring: 'curled', pinky: 'curled', ...o })
const peaceHand = (kind: 'sep' | 'close', o: HandOpts = {}) => makeHand({ thumb: 'curled', index: 'extended', middle: 'extended', ring: 'curled', pinky: 'curled', peace: kind, ...o })
const pinchHand = (aperture: number, o: HandOpts = {}) =>
  makeHand({ index: 'half', middle: 'curled', ring: 'curled', pinky: 'curled', thumbToIndexDist: aperture * 0.09, ...o })

let engine: GestureEngine
let t = 0

beforeEach(() => {
  engine = new GestureEngine()
  t = 0
})

function step(left: HandFrame | null, right: HandFrame | null) {
  const out = engine.update(left, right, t)
  t += DT
  return out
}

test('puño izquierdo → grab activo con deltas de arrastre', () => {
  for (let i = 0; i < 4; i++) step(fist(), null)
  let out = step(fist(), null)
  expect(out.debug.leftGesture).toBe('grab')
  expect(out.grab.active).toBe(true)

  // Mano se mueve a la derecha física (x de imagen baja).
  for (let i = 0; i < 12; i++) out = step(fist({ cx: 0.36 }), null)
  expect(out.grab.deltaX).toBeGreaterThan(0.05)
})

test('índice izquierdo → cursor en coords de pantalla', () => {
  let out = step(pointing(), null)
  for (let i = 0; i < 15; i++) out = step(pointing({ tipImage: { x: 0.3, y: 0.4 } }), null)
  expect(out.debug.leftGesture).toBe('point')
  expect(out.point.active).toBe(true)
  expect(out.point.screenX).toBeGreaterThan(0.7)  // espejo: 1-0.3 expandido
  expect(out.point.screenY).toBeLessThan(0.45)
})

test('V abierta sostenida y soltada → click', () => {
  for (let i = 0; i < 6; i++) step(peaceHand('sep'), null)  // ~400ms
  let clicked = false
  for (let i = 0; i < 4; i++) {
    const out = step(makeHand(), null)  // mano abierta = release deliberado
    if (out.click) clicked = true
  }
  expect(clicked).toBe(true)
})

test('V cerrada sostenida y soltada → back', () => {
  for (let i = 0; i < 6; i++) step(peaceHand('close'), null)
  let backed = false
  for (let i = 0; i < 4; i++) {
    const out = step(makeHand(), null)
    if (out.back) backed = true
  }
  expect(backed).toBe(true)
})

test('mano derecha: pinch engancha en contacto y el spread sube el zoom', () => {
  let out = step(null, pinchHand(0.35))
  for (let i = 0; i < 3; i++) out = step(null, pinchHand(0.35))
  expect(out.pinch.active).toBe(true)
  expect(out.debug.rightGesture).toBe('pinch')
  expect(out.pinch.zoom).toBe(1.0)

  for (let i = 1; i <= 12; i++) out = step(null, pinchHand(0.35 + i * 0.07))
  expect(out.pinch.zoom).toBeGreaterThan(1.3)
})

test('puño derecho NO es pinch (guard anti-puño)', () => {
  let out = step(null, fist())
  for (let i = 0; i < 6; i++) out = step(null, fist())
  expect(out.pinch.active).toBe(false)
  expect(out.debug.rightGesture).toBe('idle')
})

test('dropout de 1 frame no suelta el grab (gracia)', () => {
  for (let i = 0; i < 5; i++) step(fist(), null)
  let out = step(null, null)  // frame perdido
  expect(out.grab.active).toBe(true)
  out = step(fist(), null)
  expect(out.grab.active).toBe(true)
})

test('mano izquierda perdida >gracia → todo idle y sin click fantasma', () => {
  for (let i = 0; i < 6; i++) step(peaceHand('sep'), null)
  let anyClick = false
  let out = step(null, null)
  for (let i = 0; i < 8; i++) {
    out = step(null, null)
    if (out.click) anyClick = true
  }
  expect(anyClick).toBe(false)
  expect(out.grab.active).toBe(false)
  expect(out.point.active).toBe(false)
  expect(out.debug.leftGesture).toBe('idle')
})

test('reset limpia todo', () => {
  for (let i = 0; i < 6; i++) step(fist(), pinchHand(0.35))
  engine.reset()
  const out = step(null, null)
  expect(out.grab.active).toBe(false)
  expect(out.pinch.active).toBe(false)
  expect(out.pinch.zoom).toBe(1.0)
})
