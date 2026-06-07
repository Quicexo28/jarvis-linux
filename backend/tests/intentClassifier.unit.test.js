import { describe, it, expect } from 'vitest'
import { classifyIntent } from '../src/lib/intentClassifier.js'

const ENGAGED_CTX = { state: 'ENGAGED', speakerConfidence: 1.0, alwaysOn: true }

describe('toggle_gestures intent', () => {
  it('detects "activa gestos"', () => {
    const r = classifyIntent('activa gestos', ENGAGED_CTX)
    expect(r.intentTag).toBe('toggle_gestures')
  })

  it('detects "desactiva los gestos"', () => {
    const r = classifyIntent('desactiva los gestos', ENGAGED_CTX)
    expect(r.intentTag).toBe('toggle_gestures')
  })
})

describe('voice_muted intent', () => {
  it('detects "jarvis no escuches"', () => {
    const r = classifyIntent('jarvis no escuches', ENGAGED_CTX)
    expect(r.intentTag).toBe('voice_muted')
  })

  it('detects "ignórame"', () => {
    const r = classifyIntent('ignórame', ENGAGED_CTX)
    expect(r.intentTag).toBe('voice_muted')
  })
})
