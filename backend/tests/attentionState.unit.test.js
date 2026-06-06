import { describe, it, expect, beforeEach } from 'vitest'
import {
  getAttentionState,
  markInteraction,
  forcePassive,
  setVoiceMuted,
  isVoiceMuted,
} from '../src/lib/attentionState.js'

beforeEach(() => {
  setVoiceMuted(false)
  forcePassive()
})

describe('VOICE_MUTED state', () => {
  it('isVoiceMuted() returns false by default', () => {
    expect(isVoiceMuted()).toBe(false)
  })

  it('setVoiceMuted(true) enables mute', () => {
    setVoiceMuted(true)
    expect(isVoiceMuted()).toBe(true)
  })

  it('setVoiceMuted(false) clears mute', () => {
    setVoiceMuted(true)
    setVoiceMuted(false)
    expect(isVoiceMuted()).toBe(false)
  })

  it('markInteraction() does NOT clear mute', () => {
    setVoiceMuted(true)
    markInteraction()
    expect(isVoiceMuted()).toBe(true)
  })

  it('VOICE_MUTED is independent of attention state', () => {
    setVoiceMuted(true)
    markInteraction()
    expect(getAttentionState()).toBe('ENGAGED')
    expect(isVoiceMuted()).toBe(true)
  })
})
