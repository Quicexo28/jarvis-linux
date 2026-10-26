import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Timers that keep working with the UI asleep: the backend holds them, says
// them when they end, and hands them back to the renderer when it wakes.
let t, dir
const said = []
const T0 = Date.parse('2026-10-26T10:00:00-05:00')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-timers-'))
  process.env.JARVIS_DB_PATH = join(dir, 'test.db')
  t = await import('../src/lib/backendTimers.js')
})

afterAll(() => {
  t._resetTimersForTests()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  said.length = 0
  t._resetTimersForTests({ announcer: async (text) => { said.push(text) } })
  vi.useFakeTimers({ now: T0 })
})

describe('backend timers', () => {
  it('announces a timer when it ends', () => {
    t.startTimer({ seconds: 180, label: 'el té' }, T0)
    vi.advanceTimersByTime(179_000)
    expect(said).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(said).toEqual(['Señor, terminó el temporizador de el té.'])
    expect(t.listTimers(T0 + 181_000)).toEqual([])
  })

  it('lists remaining time and finds a timer by a loose label', () => {
    t.startTimer({ seconds: 600, label: 'Pasta' }, T0)
    expect(t.listTimers(T0 + 60_000)[0]).toMatchObject({ label: 'Pasta', remainingMs: 540_000, running: true })
    expect(t.cancelTimers({ label: 'arroz' })).toBe(0)
    expect(t.cancelTimers({ label: 'la pasta' })).toBe(1)
    vi.advanceTimersByTime(700_000)
    expect(said).toEqual([])
  })

  it('pauses, adds time and resumes', () => {
    t.startTimer({ seconds: 120, label: 'huevos' }, T0)
    expect(t.pauseTimers({ label: 'huevos' }, T0 + 60_000)).toBe(1)
    vi.advanceTimersByTime(600_000)
    expect(said).toEqual([])
    t.addToTimers({ label: 'huevos', seconds: 30 }, T0 + 600_000)
    expect(t.listTimers(T0 + 600_000)[0]).toMatchObject({ remainingMs: 90_000, running: false })
    t.resumeTimers({ label: 'huevos' }, Date.now())
    vi.advanceTimersByTime(90_000)
    expect(said).toHaveLength(1)
  })

  it('a single timer is the target when no label is given', () => {
    t.startTimer({ seconds: 60 }, T0)
    expect(t.cancelTimers({})).toBe(1)
  })

  it('hands pending timers to the renderer with their remaining time', async () => {
    t.startTimer({ seconds: 300, label: 'té' }, T0)
    t.startTimer({ seconds: 900, label: 'pan' }, T0)
    t.pauseTimers({ label: 'pan' }, T0 + 100_000)
    const created = []
    const paused = []
    const moved = await t.handOverTimers({
      create: async (ms, label) => { created.push([label, ms]) },
      pause: async (label) => { paused.push(label) },
    }, T0 + 100_000)
    expect(moved).toBe(2)
    expect(created).toEqual([['té', 200_000], ['pan', 800_000]])
    expect(paused).toEqual(['pan'])
    expect(t.hasBackendTimers()).toBe(false)
    vi.advanceTimersByTime(1_000_000)
    expect(said).toEqual([])  // the renderer owns them now
  })

  it('keeps a timer whose hand-off fails', async () => {
    t.startTimer({ seconds: 300, label: 'té' }, T0)
    const moved = await t.handOverTimers({ create: async () => { throw new Error('skill_bus_failed') }, pause: async () => {} }, T0)
    expect(moved).toBe(0)
    expect(t.hasBackendTimers()).toBe(true)
  })

  it('survives a restart and announces one that expired while down', () => {
    t.startTimer({ seconds: 60, label: 'café' }, T0)
    t.startTimer({ seconds: 3600, label: 'ropa' }, T0)
    t._resetTimersForTests({ announcer: async (text) => { said.push(text) } })  // process died
    t.restoreTimers(T0 + 5 * 60_000)
    expect(said).toEqual(['Señor, terminó el temporizador de café, hace 4 minutos.'])
    expect(t.listTimers(T0 + 5 * 60_000).map((x) => x.label)).toEqual(['ropa'])
  })
})
