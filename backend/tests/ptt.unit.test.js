import { describe, it, expect } from 'vitest'
import { setPttActive, isPttActive } from '../src/lib/pttState.js'
import { classifyIntent } from '../src/lib/intentClassifier.js'

describe('pttState', () => {
  it('tracks active state', () => {
    setPttActive(true)
    expect(isPttActive()).toBe(true)
    setPttActive(false)
    expect(isPttActive()).toBe(false)
  })
})

describe('classifyIntent ptt bypass', () => {
  it('blocks low speaker confidence without ptt', () => {
    const r = classifyIntent('enciende las luces', { state: 'PASSIVE', speakerConfidence: 0, alwaysOn: true })
    expect(r.shouldRespond).toBe(false)
    expect(r.reason).toBe('not_owner')
  })

  it('responds with ptt despite zero speaker confidence', () => {
    const r = classifyIntent('enciende las luces', { state: 'PASSIVE', speakerConfidence: 0, alwaysOn: true, ptt: true })
    expect(r.shouldRespond).toBe(true)
  })

  it('still honors sleep commands during ptt', () => {
    const r = classifyIntent('jarvis duerme', { state: 'ENGAGED', speakerConfidence: 0, ptt: true })
    expect(r.isSleepCommand).toBe(true)
  })
})
