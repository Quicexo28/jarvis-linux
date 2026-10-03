import { describe, it, expect } from 'vitest'
import { isStopOnly } from './bargeIn'

describe('isStopOnly', () => {
  it.each([
    'Para',
    'para.',
    'Cállate',
    'Jarvis, para',
    'oye, detente',
    'ya basta',
    'Silencio, por favor',
    'Espera, espera',
    'Para ya',
    'Ya, Jarvis',
    'stop',
    'Déjalo',
    'Cancela eso',
  ])('"%s" only stops', (t) => expect(isStopOnly(t)).toBe(true))

  it.each([
    'Para, mejor pon un temporizador de cinco minutos',
    'para qué sirve la ley de Gauss',
    'Espera, ¿cuántos planetas hay?',
    'no, el otro plano',
    'no',              // an answer to a question, not a stop
    'ya',              // ditto
    'deja el volumen en cincuenta',
    'cancela todos los temporizadores',
    '',
  ])('"%s" is a real turn', (t) => expect(isStopOnly(t)).toBe(false))
})
