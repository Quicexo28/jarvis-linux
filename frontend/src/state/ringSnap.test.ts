import { describe, it, expect } from 'vitest'
import { snapToNearestSlot } from '../state/ringSnap'

describe('snapToNearestSlot', () => {
  it('snaps 0.3 to slot 0', () => {
    expect(snapToNearestSlot(0.3, 5)).toBe(0)
  })
  it('snaps 0.7 to slot 1', () => {
    expect(snapToNearestSlot(0.7, 5)).toBe(1)
  })
  it('snaps -0.3 to slot 0 (wraps from end)', () => {
    expect(snapToNearestSlot(-0.3, 5)).toBe(0)
  })
  it('snaps 4.6 to slot 0 (wraps)', () => {
    expect(snapToNearestSlot(4.6, 5)).toBe(0)
  })
  it('snaps 2.4 to slot 2', () => {
    expect(snapToNearestSlot(2.4, 5)).toBe(2)
  })
})
