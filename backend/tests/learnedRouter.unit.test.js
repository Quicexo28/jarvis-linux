import { describe, it, expect } from 'vitest'
import { contentTokens, decideEscalation, learnedModel } from '../src/lib/learnedRouter.js'

const turn = (text, model, verdict) => ({ text, model, verdict })
const RGB_FAILS = [
  turn('Jarvis, cambia el color de setup a verde lima.', 'haiku', 'false_success'),
  turn('Jarvis, cambia el color de mi setup a rojo', 'haiku', 'false_success'),
]

describe('contentTokens', () => {
  it('drops the wake word, accents and function words', () => {
    expect([...contentTokens('Jarvis, pon el cronómetro de la pasta')]).toEqual(['pon', 'cronometro', 'pasta'])
  })
})

describe('decideEscalation', () => {
  it('escalates when haiku keeps failing similar turns', () => {
    expect(decideEscalation('Jarvis, cambia el color de mi setup a azul', RGB_FAILS).escalate).toBe(true)
  })

  it('needs more than one failure', () => {
    expect(decideEscalation('cambia el color de mi setup a azul', RGB_FAILS.slice(0, 1)).escalate).toBe(false)
  })

  it('stays on haiku when it mostly succeeds', () => {
    const history = [
      ...RGB_FAILS,
      turn('cambia el color de mi setup a azul', 'haiku', 'ok'),
      turn('cambia el color de mi setup a verde', 'haiku', 'ok'),
      turn('cambia el color de mi setup a blanco', 'haiku', 'ok'),
    ]
    expect(decideEscalation('cambia el color de mi setup a azul', history)).toEqual({ escalate: false, reason: 'haiku_ok' })
  })

  it('ignores failures on unrelated turns', () => {
    expect(decideEscalation('Jarvis, pon un temporizador de tres minutos', RGB_FAILS).escalate).toBe(false)
  })

  it('ignores unverified turns and CLI errors', () => {
    const history = [
      turn('cambia el color de mi setup a rojo', 'haiku', 'unverified'),
      turn('cambia el color de mi setup a verde', 'haiku', null),
      turn('cambia el color de mi setup a lima', 'haiku', 'false_success'),
    ]
    expect(decideEscalation('cambia el color de mi setup a azul', history).escalate).toBe(false)
  })

  it('stops escalating when sonnet fails just as often', () => {
    const history = [
      ...RGB_FAILS,
      turn('cambia el color de mi setup a azul', 'sonnet', 'false_success'),
      turn('cambia el color de mi setup a verde', 'sonnet', 'false_success'),
    ]
    expect(decideEscalation('cambia el color de mi setup a azul', history)).toEqual({ escalate: false, reason: 'sonnet_no_better' })
  })

  it('keeps escalating while sonnet does better', () => {
    const history = [
      ...RGB_FAILS,
      turn('cambia el color de mi setup a azul', 'sonnet', 'ok'),
      turn('cambia el color de mi setup a verde', 'sonnet', 'ok'),
    ]
    expect(decideEscalation('cambia el color de mi setup a azul', history).escalate).toBe(true)
  })

  it('ignores failures caused by the environment, not the model', () => {
    // Real case: UI asleep → every renderer tool failed → false_success.
    const asleep = RGB_FAILS.map((t) => ({ ...t, error: 'mcp__jarvis__rgb_set: Error ejecutando rgb_set: renderer_not_connected' }))
    expect(decideEscalation('cambia el color de mi setup a azul', asleep).escalate).toBe(false)
  })

  it('learns from real usage only, not eval replays', () => {
    const replays = RGB_FAILS.map((t) => ({ ...t, source: 'eval' }))
    expect(decideEscalation('cambia el color de mi setup a azul', replays).escalate).toBe(false)
  })

  it('does not judge one-word utterances', () => {
    expect(decideEscalation('disminuye', [turn('disminuye', 'haiku', 'false_success'), turn('disminuye', 'haiku', 'false_success')]).reason).toBe('too_short')
  })
})

describe('learnedModel', () => {
  it('never touches a turn the base router already escalated', () => {
    expect(learnedModel('sonnet', 'cambia el color de mi setup a azul')).toBe('sonnet')
    expect(learnedModel('opus', 'cambia el color de mi setup a azul')).toBe('opus')
  })

  it('can be switched off', () => {
    process.env.JARVIS_LEARNED_ROUTING = '0'
    try {
      expect(learnedModel('haiku', 'cambia el color de mi setup a azul')).toBe('haiku')
    } finally {
      delete process.env.JARVIS_LEARNED_ROUTING
    }
  })
})
