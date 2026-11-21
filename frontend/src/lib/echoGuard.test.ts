import { describe, it, expect } from 'vitest'
import { normalizeForEcho, hasRealSpeech } from './echoGuard'

describe('echoGuard', () => {
  it('normaliza tildes, signos y espacios', () => {
    expect(normalizeForEcho('  ¡Qué  día, Señor! ')).toBe('que dia senor')
  })

  it('eco puro no es habla real', () => {
    expect(hasRealSpeech('son las tres', 'son las tres de la tarde')).toBe(false)
  })

  it('dos palabras novedosas son habla real aunque haya eco', () => {
    expect(hasRealSpeech('son las tres pon musica', 'son las tres de la tarde')).toBe(true)
  })

  it('una palabra de interrupción basta', () => {
    expect(hasRealSpeech('para', 'son las tres de la tarde')).toBe(true)
  })

  it('sin nada dicho antes, todo es real', () => {
    expect(hasRealSpeech('hola', '')).toBe(true)
  })
})
