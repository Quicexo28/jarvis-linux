import { describe, it, expect, beforeEach } from 'vitest'
import { pickModel, isStudyTurn, resetStudyState } from '../src/lib/modelRouter.js'

beforeEach(() => resetStudyState())

describe('isStudyTurn', () => {
  // Study requests, in the shape Whisper actually delivers them (no accents,
  // no question marks, "jarvis" at the head).
  const study = [
    'Jarvis, explícame la ley de Gauss',
    'por qué la entropía siempre aumenta',
    'cómo se deriva la ecuación de Schrödinger',
    'resuelve este ejercicio de cinemática',
    'qué es un tensor de inercia',
    'jarvis calcula la velocidad de escape de la tierra',
    'cuál es la diferencia entre campo eléctrico y potencial',
    'la fuerza de coriolis y la aceleración centrípeta en un sistema rotante',
  ]
  for (const t of study) it(`study: ${t}`, () => expect(isStudyTurn(t)).toBe(true))

  // Real transcripts from the turn store: commands and 3D editing stay on haiku.
  const notStudy = [
    'apaga el PC.',
    'Jarvis mueve la base de las rampas a una unidad de distancia del pentágono.',
    'Jarvis, aumenta la inclinación de las rampas.',
    'no hablaba contigo, olvídalo.',
    'pon un temporizador de diez minutos',
    'qué hora es',
    'sube el volumen',
    'por qué no abriste el navegador',
    'vamos a estudiar electromagnetismo, pomodoro de 25',
  ]
  for (const t of notStudy) it(`not study: ${t}`, () => expect(isStudyTurn(t)).toBe(false))
})

describe('pickModel', () => {
  it('keeps intent routing', () => {
    expect(pickModel('self_build', 'explica la gravedad')).toBe('opus')
    expect(pickModel('complex_task', 'hola')).toBe('sonnet')
    expect(pickModel('chat')).toBe('haiku')
  })

  it('routes study turns to sonnet', () => {
    expect(pickModel('chat', 'explícame el teorema de Noether', 1000)).toBe('sonnet')
  })

  it('keeps a follow-up on sonnet, but not a desktop command', () => {
    pickModel('chat', 'explícame el oscilador armónico', 1000)
    expect(pickModel('chat', 'y si duplico la masa', 30_000)).toBe('sonnet')
    expect(pickModel('chat', 'pausa la música', 40_000)).toBe('haiku')
    pickModel('chat', 'explícame el oscilador armónico', 50_000)
    expect(pickModel('chat', 'Jarvis, qué ventanas tengo abiertas', 60_000)).toBe('haiku')
    pickModel('chat', 'explícame el oscilador armónico', 70_000)
    expect(pickModel('chat', 'disminuye', 80_000)).toBe('sonnet')
    expect(pickModel('chat', 'ya entrené hoy', 90_000)).toBe('haiku')
  })

  it('a desktop turn ends the study exchange', () => {
    pickModel('chat', 'explícame el oscilador armónico', 1000)
    expect(pickModel('chat', 'anota una tarea', 10_000)).toBe('haiku')
    expect(pickModel('chat', 'ya repasé el capítulo de óptica', 20_000)).toBe('haiku')
  })

  it('lets stickiness expire', () => {
    pickModel('chat', 'explícame el oscilador armónico', 1000)
    expect(pickModel('chat', 'y si duplico la masa', 1000 + 10 * 60_000)).toBe('haiku')
  })

  it('can be switched off', () => {
    process.env.JARVIS_STUDY_ROUTING = '0'
    try {
      expect(pickModel('chat', 'explícame la ley de Gauss')).toBe('haiku')
    } finally {
      delete process.env.JARVIS_STUDY_ROUTING
    }
  })
})
