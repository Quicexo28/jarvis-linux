import { test, expect } from 'vitest'
import { FingerTracker, PoseStabilizer, classifyLeft } from './pose'
import type { FingerStates } from './types'
import type { HandFeatures } from './features'

function curls(v: Partial<Record<'thumb' | 'index' | 'middle' | 'ring' | 'pinky', number>>) {
  return { thumb: 0.99, index: 0.95, middle: 0.95, ring: 0.95, pinky: 0.95, ...v }
}

function fingers(v: Partial<FingerStates>): FingerStates {
  return { thumb: 'extended', index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended', ...v }
}

function feat(v: Partial<HandFeatures> = {}): HandFeatures {
  return {
    palmSize: 0.09,
    curl: curls({}),
    aperture: 1.0,
    indexMiddleGap: 0.5,
    wristImage: { x: 0.5, y: 0.5 },
    indexTipImage: { x: 0.5, y: 0.3 },
    palmImageSize: 0.18,
    palmAngle: -Math.PI / 2,
    palmAxisWorld: { x: 0, y: -1, z: 0 },
    palmNormalWorld: { x: 0, y: 0, z: -1 },
    ...v,
  }
}

test('FingerTracker: curl bajo → contracted, curl alto → extended', () => {
  const t = new FingerTracker()
  const down = t.update(curls({ index: 0.4 }))
  expect(down.index).toBe('contracted')
  const up = t.update(curls({ index: 0.95 }))
  expect(up.index).toBe('extended')
})

test('FingerTracker: histéresis — oscilar sobre el umbral no hace flicker', () => {
  const t = new FingerTracker()
  t.update(curls({ index: 0.4 }))
  // Oscila entre 0.69 y 0.71 (dentro de la banda contracted 0.68-0.72): sigue contracted.
  for (let i = 0; i < 10; i++) {
    const s = t.update(curls({ index: i % 2 === 0 ? 0.69 : 0.71 }))
    expect(s.index).toBe('contracted')
  }
})

test('classifyLeft: puño = grab, índice = point, V = peace', () => {
  const allDown = fingers({ thumb: 'contracted', index: 'contracted', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  expect(classifyLeft(allDown, feat(), null)).toBe('grab')

  const pointing = fingers({ thumb: 'contracted', index: 'extended', middle: 'half', ring: 'contracted', pinky: 'contracted' })
  expect(classifyLeft(pointing, feat(), null)).toBe('point')

  const peace = fingers({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  expect(classifyLeft(peace, feat({ indexMiddleGap: 0.5 }), null)).toBe('peace_sep')
  expect(classifyLeft(peace, feat({ indexMiddleGap: 0.15 }), null)).toBe('peace_close')

  expect(classifyLeft(fingers({}), feat(), null)).toBe('idle')
})

test('classifyLeft: grab pegajoso — pulgar dudoso no suelta el puño, apertura clara sí', () => {
  const thumbOut = fingers({ thumb: 'extended', index: 'contracted', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  // Sin grab previo, la entrada exige el pulgar: no engancha.
  expect(classifyLeft(thumbOut, feat(), null, 'idle')).toBe('idle')
  // Ya en grab, el pulgar deja de contar: sigue enganchado.
  expect(classifyLeft(thumbOut, feat(), null, 'grab')).toBe('grab')
  // Un dedo no-pulgar dudoso (half→extended por blur) tampoco suelta.
  const oneFingerOut = fingers({ thumb: 'extended', index: 'extended', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  expect(classifyLeft(oneFingerOut, feat(), null, 'grab')).toBe('point') // point gana: transición deliberada
  const ringOut = fingers({ thumb: 'extended', index: 'contracted', middle: 'contracted', ring: 'extended', pinky: 'contracted' })
  expect(classifyLeft(ringOut, feat(), null, 'grab')).toBe('grab')
  // Mano claramente abierta: suelta.
  expect(classifyLeft(fingers({}), feat(), null, 'grab')).toBe('idle')
})

test('classifyLeft: zona muerta del gap mantiene el sub-estado anterior', () => {
  const peace = fingers({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  // 0.33 está entre PEACE_CLOSE_ENTER (0.30) y PEACE_SEP_ENTER (0.36).
  expect(classifyLeft(peace, feat({ indexMiddleGap: 0.33 }), 'close')).toBe('peace_close')
  expect(classifyLeft(peace, feat({ indexMiddleGap: 0.33 }), 'sep')).toBe('peace_sep')
})

test('PoseStabilizer: cambia solo tras N frames estables', () => {
  const s = new PoseStabilizer<'a' | 'b'>('a')
  expect(s.update('b')).toBe('a')  // 1 frame: aún no
  expect(s.update('b')).toBe('b')  // 2 frames: cambia
})

test('PoseStabilizer: un frame suelto no cambia la pose', () => {
  const s = new PoseStabilizer<'a' | 'b'>('a')
  expect(s.update('b')).toBe('a')
  expect(s.update('a')).toBe('a')  // volvió: candidata descartada
  expect(s.update('b')).toBe('a')  // cuenta desde cero otra vez
})
