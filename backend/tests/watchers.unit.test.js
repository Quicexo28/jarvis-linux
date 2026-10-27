import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scheduled read-only checks: when they run, what they say, and that a quiet
// "NADA" stays quiet.
let w, risk, dir
const H = 3600e3
// 2026-10-26 06:00 in Bogotá (UTC-5)
const SIX_AM = Date.parse('2026-10-26T06:00:00-05:00')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-watchers-'))
  process.env.JARVIS_DB_PATH = join(dir, 'test.db')
  w = await import('../src/lib/watchers.js')
  risk = await import('../src/lib/toolRisk.js')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => w._resetWatchersForTests())

describe('schedule', () => {
  it('today at HH:MM is in Bogotá time', () => {
    expect(w.todayAt('07:00', SIX_AM)).toBe(SIX_AM + H)
  })

  it('a daily watcher runs once its hour comes, once a day', () => {
    const { watcher } = w.addWatcher({ task: 'Avísame si va a llover hoy', at: '07:00' }, SIX_AM)
    expect(w.dueState(watcher, SIX_AM + 30 * 60e3)).toBeNull()
    expect(w.dueState(watcher, SIX_AM + H + 60e3)).toBe('run')
    watcher.lastRunAt = SIX_AM + H + 60e3
    expect(w.dueState(watcher, SIX_AM + 5 * H)).toBeNull()
    expect(w.dueState(watcher, SIX_AM + 25 * H + 60e3)).toBe('run')  // tomorrow 07:01
  })

  it('a daily check missed by hours is skipped, not run late', () => {
    const { watcher } = w.addWatcher({ task: 'Avísame si va a llover hoy', at: '07:00' }, SIX_AM)
    expect(w.dueState(watcher, SIX_AM + 9 * H)).toBe('skip')
  })

  it('created after today\'s hour, it starts tomorrow', () => {
    const { watcher } = w.addWatcher({ task: 'Avísame si va a llover hoy', at: '07:00' }, SIX_AM + 3 * H)
    expect(w.dueState(watcher, SIX_AM + 3 * H + 60e3)).toBeNull()
  })

  it('an interval watcher waits one interval first', () => {
    const { watcher } = w.addWatcher({ task: 'Mira si llegó el correo de la universidad', everyMinutes: 60 }, SIX_AM)
    expect(w.dueState(watcher, SIX_AM + 30 * 60e3)).toBeNull()
    expect(w.dueState(watcher, SIX_AM + H)).toBe('run')
  })
})

describe('validation', () => {
  it.each([
    [{ task: 'x', at: '07:00' }, 'task_invalida'],
    [{ task: 'Avísame si llueve', at: '7am' }, 'hora_invalida'],
    [{ task: 'Avísame si llueve' }, 'horario_requerido'],
    [{ task: 'Avísame si llueve', everyMinutes: 5 }, 'intervalo_invalido'],
  ])('%o → %s', (args, error) => expect(w.addWatcher(args)).toMatchObject({ ok: false, error }))

  it('cancels by a piece of the text, refusing ambiguous matches', () => {
    w.addWatcher({ task: 'Avísame si va a llover', at: '07:00' })
    w.addWatcher({ task: 'Avísame si llega el correo', everyMinutes: 60 })
    expect(w.cancelWatchers({ match: 'avisame' })).toBe(-2)
    expect(w.cancelWatchers({ match: 'llover' })).toBe(1)
    expect(w.listWatchers()).toHaveLength(1)
  })
})

describe('running', () => {
  const ten = Date.parse('2026-10-26T10:00:00-05:00')
  const twoAm = Date.parse('2026-10-26T02:00:00-05:00')

  it('says what it found', async () => {
    const said = []
    const { watcher } = w.addWatcher({ task: 'Avísame si va a llover', at: '07:00' })
    const r = await w.runWatcher(watcher, { ask: async () => 'Va a llover hacia las dos, lleve paraguas.', notify: async (t) => { said.push(t) }, now: ten })
    expect(r.status).toBe('avisado')
    expect(said).toEqual(['Va a llover hacia las dos, lleve paraguas.'])
    expect(watcher.lastResult).toContain('paraguas')
  })

  it('stays quiet on NADA', async () => {
    const said = []
    const { watcher } = w.addWatcher({ task: 'Avísame si va a llover', at: '07:00' })
    const r = await w.runWatcher(watcher, { ask: async () => 'NADA', notify: async (t) => { said.push(t) }, now: ten })
    expect(r.status).toBe('nada')
    expect(said).toEqual([])
  })

  it('never speaks during quiet hours', async () => {
    const said = []
    const { watcher } = w.addWatcher({ task: 'Mira si llegó el correo', everyMinutes: 60 })
    const r = await w.runWatcher(watcher, { ask: async () => 'Llegó el correo de la universidad.', notify: async (t) => { said.push(t) }, now: twoAm })
    expect(r.status).toBe('silenciado')
    expect(said).toEqual([])
  })

  it('tick runs only what is due', async () => {
    const asked = []
    w.addWatcher({ task: 'Avísame si va a llover', at: '07:00' }, SIX_AM)
    w.addWatcher({ task: 'Mira si llegó el correo', everyMinutes: 120 }, SIX_AM)
    const ran = await w.tick({ ask: async (m) => { asked.push(m); return 'NADA' }, notify: async () => {} }, SIX_AM + H + 60e3)
    expect(ran).toBe(1)
    expect(asked[0]).toContain('Avísame si va a llover')
  })
})

describe('risk gate', () => {
  const req = (path) => ({ url: path, headers: { 'x-jarvis-origin': 'watcher' } })
  it('a watcher may look', () => {
    expect(risk.checkToolRisk(req('/api/skills/weather')).allowed).toBe(true)
    expect(risk.checkToolRisk(req('/api/skills/day/brief')).allowed).toBe(true)
  })
  it('and nothing else, whoever spoke last', () => {
    for (const p of ['/api/skills/timer/start', '/api/skills/system/terminal', '/api/skills/watcher/create']) {
      expect(risk.checkToolRisk(req(p))).toMatchObject({ allowed: false, reason: 'watcher_read_only' })
    }
  })
})
