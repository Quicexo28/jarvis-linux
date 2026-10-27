import { describe, it, expect } from 'vitest'
import { matchFastCommand, fastReply, spokenDuration, tryFastPath } from '../src/lib/fastPath.js'

// The deterministic path must take ONLY short, unambiguous commands; anything
// else goes to the model untouched. Phrases are the real shapes from the turn
// traces and the eval fixture.
describe('matchFastCommand — takes', () => {
  it.each([
    ['Jarvis, pon un temporizador de tres minutos para el té', { kind: 'timer_start', body: { seconds: 180, label: 'té' } }],
    ['Jarvis, pon un temporizador de diez minutos para la pasta', { kind: 'timer_start', body: { seconds: 600, label: 'pasta' } }],
    ['temporizador de una hora y media', { kind: 'timer_start', body: { seconds: 5400 } }],
    ['oye Jarvis, cancela todos los temporizadores', { kind: 'timer_cancel', body: { all: true } }],
    ['cancela el temporizador de la pasta', { kind: 'timer_cancel', body: { label: 'pasta' } }],
    ['Jarvis, ¿cuánto le queda al temporizador?', { kind: 'timer_list' }],
    ['sube el volumen', { kind: 'volume_up', body: { action: 'up', step: 10 } }],
    ['Jarvis, baja el volumen un poco', { kind: 'volume_down' }],
    ['pon el volumen al 40 por ciento', { kind: 'volume_set', body: { action: 'set', value: 40 } }],
    ['pon el volumen al cincuenta', { kind: 'volume_set', body: { action: 'set', value: 50 } }],
    ['silencia', { kind: 'volume_mute' }],
    ['pausa la música', { kind: 'media_pause' }],
    ['Jarvis, siguiente canción', { kind: 'media_next' }],
    ['¿Qué hora es?', { kind: 'time' }],
  ])('%s', (text, want) => {
    expect(matchFastCommand(text)).toMatchObject(want)
  })
})

describe('matchFastCommand — leaves to the model', () => {
  it.each([
    'Jarvis, pon un temporizador de tres minutos y busca una receta de té',  // compound
    'pon un temporizador',                                                    // no duration
    'pon una alarma a las seis de la mañana',                                  // a reminder, not a timer
    'pon un temporizador a las 5',                                             // clock time
    'sube el volumen cuando empiece la canción',                               // conditional
    'Jarvis, explícame por qué el periodo de un péndulo no depende de la masa',
    'pon música de jazz',                                                      // needs a search
    'pausa el cronómetro',                                                     // chronos: renderer only
    'qué hora es en Tokio',                                                    // not "the time" here
    'pon el volumen al ciento cincuenta',                                      // unparsed number
    'Jarvis, abre el plano tres de',
  ])('%s', (text) => {
    expect(matchFastCommand(text)).toBeNull()
  })
})

describe('replies say what actually happened', () => {
  it('a timer the backend holds because the UI sleeps says so', () => {
    const cmd = matchFastCommand('pon un temporizador de tres minutos para el té')
    expect(fastReply(cmd, { ok: true, result: { owner: 'backend' } }))
      .toBe('Temporizador de 3 minutos para el té en marcha, señor. La interfaz está dormida, así que le aviso yo.')
  })

  it('reads the remaining time from the list', () => {
    const cmd = matchFastCommand('cuánto le queda al temporizador')
    const r = { ok: true, result: { timers: [{ label: 'té', remainingMs: 95_000, status: 'running' }] } }
    expect(fastReply(cmd, r)).toBe('Al de té le quedan 1 minuto y 35 segundos, señor.')
  })

  it('reports the real volume level', () => {
    expect(fastReply(matchFastCommand('sube el volumen'), { ok: true, level: 55 })).toBe('Volumen al 55 por ciento, señor.')
  })

  it('spells durations', () => {
    expect(spokenDuration(5_400_000)).toBe('1 hora y 30 minutos')
    expect(spokenDuration(45_000)).toBe('45 segundos')
  })
})

describe('tryFastPath', () => {
  it('hands the turn to the model when the route fails', async () => {
    const call = async () => ({ ok: false, error: 'sin_reproductor' })
    expect(await tryFastPath('pausa la música', call)).toBeNull()
  })

  it('runs the route and names the tool for the trace', async () => {
    const seen = []
    const call = async (route, body) => { seen.push([route.path, body]); return { ok: true, result: { owner: 'renderer' } } }
    const r = await tryFastPath('Jarvis, pon un temporizador de 5 minutos', call)
    expect(seen).toEqual([['/api/skills/timer/start', { seconds: 300 }]])
    expect(r).toMatchObject({ tool: 'mcp__jarvis__timer.start', reply: 'Temporizador de 5 minutos en marcha, señor.' })
  })

  it('can be switched off', async () => {
    process.env.JARVIS_FAST_PATH = '0'
    const r = await tryFastPath('qué hora es', async () => ({ ok: true }))
    delete process.env.JARVIS_FAST_PATH
    expect(r).toBeNull()
  })
})
