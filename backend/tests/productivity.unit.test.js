import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let store, session, brief, obsidian
let dir

// 2026-09-23 10:00 Bogotá
const T0 = Date.parse('2026-09-23T10:00:00-05:00')
const DAY = 86400e3
const MIN = 60e3

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-productivity-'))
  process.env.JARVIS_DB_PATH = join(dir, 'test.db')
  process.env.JARVIS_OBSIDIAN_VAULT = join(dir, 'vault')
  mkdirSync(join(dir, 'vault', '05-Daily'), { recursive: true })
  store = await import('../src/lib/studyStore.js')
  session = await import('../src/lib/studySession.js')
  brief = await import('../src/lib/dayBrief.js')
  obsidian = await import('../src/lib/obsidian.js')
})

afterAll(async () => {
  ;(await import('../src/lib/turnStore.js')).closeStore()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('sm2', () => {
  const fresh = { ease: 2.5, interval: 0, reps: 0, lapses: 0 }

  it('schedules 1 day, then 6, then interval × ease', () => {
    const a = store.sm2(fresh, 5, T0)
    expect(a.interval).toBe(1)
    const b = store.sm2(a, 5, T0)
    expect(b.interval).toBe(6)
    const c = store.sm2(b, 4, T0)
    expect(c.interval).toBe(Math.round(6 * b.ease))
    expect(c.due).toBe(T0 + c.interval * DAY)
  })

  it('brings a failed card back in ten minutes and counts the lapse', () => {
    const r = store.sm2({ ...fresh, reps: 3, interval: 15 }, 1, T0)
    expect(r).toMatchObject({ reps: 0, interval: 0, lapses: 1, due: T0 + 10 * MIN })
  })

  it('never lets ease fall below 1.3', () => {
    let c = fresh
    for (let i = 0; i < 20; i++) c = store.sm2(c, 3, T0)
    expect(c.ease).toBeGreaterThanOrEqual(1.3)
  })
})

describe('streak', () => {
  it('counts back from today', () => {
    expect(store.streak(['2026-09-23', '2026-09-22', '2026-09-21', '2026-09-19'], '2026-09-23')).toBe(3)
  })
  it('keeps a streak alive until midnight', () => {
    expect(store.streak(['2026-09-22', '2026-09-21'], '2026-09-23')).toBe(2)
  })
  it('crosses month boundaries', () => {
    expect(store.streak(['2026-10-01', '2026-09-30'], '2026-10-01')).toBe(2)
  })
  it('is zero when broken', () => {
    expect(store.streak(['2026-09-20'], '2026-09-23')).toBe(0)
  })
})

describe('flashcards in SQLite', () => {
  it('adds, lists due, grades out of the due list', () => {
    const ids = store.addCards([
      { front: '¿Qué dice la ley de Gauss?', back: 'El flujo eléctrico es la carga encerrada sobre ε0' },
      { front: '', back: 'descartada por vacía' },
    ], 'Electromagnetismo', T0)
    expect(ids).toHaveLength(1)
    expect(store.dueCards({ deck: 'electromagnetismo', now: T0 })).toHaveLength(1)
    store.gradeCard(ids[0], 5, T0)
    expect(store.dueCards({ now: T0 + MIN })).toHaveLength(0)
    expect(store.dueCards({ now: T0 + 2 * DAY })).toHaveLength(1)
    expect(store.cardStats(T0 + MIN)).toMatchObject({ total: 1, due: 0 })
  })
})

describe('habits', () => {
  it('logs once per day and keeps the streak', () => {
    expect(store.logHabit('Ejercicio', { now: T0 - DAY }).streak).toBe(1)
    const r = store.logHabit('ejercicio ', { now: T0 })
    expect(r).toMatchObject({ already: false, streak: 2 })
    expect(store.logHabit('EJERCICIO', { now: T0 + MIN }).already).toBe(true)
    const st = store.habitStatus(T0)
    expect(st).toEqual([{ habit: 'Ejercicio', doneToday: true, streak: 2, last7: 2 }])
  })
})

describe('study log', () => {
  it('sums today and the week by subject', () => {
    store.logStudy('Física', 25, T0)
    store.logStudy('física', 25, T0 + 30 * MIN)
    store.logStudy('cálculo', 50, T0 - 3 * DAY)
    store.logStudy('viejo', 90, T0 - 10 * DAY)
    const s = store.studySummary(T0 + DAY / 4)
    expect(s.todayMinutes).toBe(50)
    expect(s.weekMinutes).toBe(100)
    expect(s.weekBySubject[0]).toEqual({ subject: 'física', minutes: 50 })
  })
})

describe('pomodoro state machine', () => {
  it('alternates focus and break, then ends after the last focus block', () => {
    let s = session.newSession({ subject: 'física', focusMin: 25, breakMin: 5, cycles: 2 }, T0)
    let step = session.advance(s, s.phaseEndsAt)
    expect(step).toMatchObject({ logMinutes: 25, dnd: false })
    expect(step.next).toMatchObject({ phase: 'break', cycle: 1 })
    step = session.advance(step.next, step.next.phaseEndsAt)
    expect(step).toMatchObject({ logMinutes: 0, dnd: true })
    expect(step.next).toMatchObject({ phase: 'focus', cycle: 2 })
    step = session.advance(step.next, step.next.phaseEndsAt)
    expect(step.next).toBeNull()
    expect(step.logMinutes).toBe(25)
    expect(step.say).toMatch(/terminada/)
  })

  it('clamps nonsense durations', () => {
    const s = session.newSession({ focusMin: 'x', breakMin: -3, cycles: 99 }, T0)
    expect(s).toMatchObject({ focusMin: 25, breakMin: 1, cycles: 12 })
  })

  it('counts partial focus minutes, never break time', () => {
    const s = session.newSession({ focusMin: 25 }, T0)
    expect(session.partialFocusMinutes(s, T0 + 12.5 * MIN)).toBe(12)
    expect(session.partialFocusMinutes(s, T0 + 60 * MIN)).toBe(25)
    expect(session.partialFocusMinutes({ ...s, phase: 'break' }, T0 + 3 * MIN)).toBe(0)
  })
})

describe('morning briefing gate', () => {
  const at = (h) => Date.parse(`2026-09-23T${String(h).padStart(2, '0')}:30:00-05:00`)
  it('fires once, in the morning, with the UI awake and no conversation going', () => {
    expect(brief.briefingBlock({ now: at(8), lastDay: '2026-09-22', awake: true, attention: 'PASSIVE' })).toBeNull()
    expect(brief.briefingBlock({ now: at(8), lastDay: '2026-09-23', awake: true })).toBe('already_today')
    expect(brief.briefingBlock({ now: at(5), awake: true })).toBe('outside_window')
    expect(brief.briefingBlock({ now: at(14), awake: true })).toBe('outside_window')
    expect(brief.briefingBlock({ now: at(8), awake: false })).toBe('ui_asleep')
    expect(brief.briefingBlock({ now: at(8), awake: true, attention: 'ENGAGED' })).toBe('user_engaged')
  })
})

describe('daily tasks in the vault', () => {
  it('ticks the matching open task and refuses ambiguity', async () => {
    const today = new Date().toLocaleDateString('en-CA')
    const file = join(dir, 'vault', '05-Daily', `${today}.md`)
    writeFileSync(file, [
      '# Daily', '', '## Tareas', '',
      '- [ ] Repasar el capítulo de óptica _(10:00:00 · voice)_',
      '- [ ] Llamar a Ana',
      '- [ ] Llamar al banco',
      '- [x] Comprar café',
    ].join('\n'))
    expect(obsidian.tasksForToday()).toMatchObject({ open: ['Repasar el capítulo de óptica', 'Llamar a Ana', 'Llamar al banco'], done: ['Comprar café'] })
    expect((await obsidian.completeTask('llamar')).error).toBe('ambigua')
    const r = await obsidian.completeTask('repasar el capitulo de optica')
    expect(r).toMatchObject({ ok: true, task: 'Repasar el capítulo de óptica' })
    expect(readFileSync(file, 'utf-8')).toContain('- [x] Repasar el capítulo de óptica')
    expect((await obsidian.completeTask('pintar la casa')).error).toBe('no_encontrada')
  })
})
