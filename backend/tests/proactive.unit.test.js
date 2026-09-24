import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let proactive
let store
let dir

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-proactive-'))
  process.env.JARVIS_DB_PATH = join(dir, 'test.db')
  store = await import('../src/lib/turnStore.js')
  proactive = await import('../src/lib/proactive.js')
})

afterAll(() => {
  store?.closeStore()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  delete process.env.JARVIS_PROACTIVE
  process.env.JARVIS_PROACTIVE_QUIET_FROM = '23'
  process.env.JARVIS_PROACTIVE_QUIET_TO = '7'
  process.env.JARVIS_PROACTIVE_MAX_DAY = '6'
  process.env.JARVIS_PROACTIVE_MIN_GAP_MS = '2700000'
  store.kvSet('proactive:count', 'x|0')
  store.kvSet('proactive:last', '0')
})

describe('blockingReason', () => {
  it('is off when disabled', () => {
    process.env.JARVIS_PROACTIVE = '0'
    expect(proactive.blockingReason()).toBe('disabled')
  })

  it('stays quiet during quiet hours, which cross midnight', () => {
    // 02:00 local — inside the 23→07 window.
    const night = new Date('2026-08-24T07:00:00Z')   // 02:00 Bogotá (UTC-5)
    expect(proactive.blockingReason(night)).toBe('quiet_hours')
    // 15:00 local — outside it.
    const day = new Date('2026-08-24T20:00:00Z')
    expect(proactive.blockingReason(day)).not.toBe('quiet_hours')
  })

  it('stops once the daily budget is spent, and the count survives a restart', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })
    store.kvSet('proactive:count', `${today}|6`)
    expect(proactive.blockingReason(new Date('2026-08-24T20:00:00Z'))).toBe('daily_budget_spent')
  })

  it('ignores a count from a previous day', () => {
    store.kvSet('proactive:count', '2020-01-01|99')
    expect(proactive.blockingReason(new Date('2026-08-24T20:00:00Z'))).not.toBe('daily_budget_spent')
  })

  it('enforces a minimum gap between notices', () => {
    store.kvSet('proactive:last', String(Date.now() - 60e3))
    expect(proactive.blockingReason(new Date('2026-08-24T20:00:00Z'))).toBe('too_soon')
  })

  it('does not interrupt an active conversation', async () => {
    const { markInteraction } = await import('../src/lib/attentionState.js')
    markInteraction()
    expect(proactive.blockingReason(new Date('2026-08-24T20:00:00Z'))).toBe('user_engaged')
  })
})

describe('gatherSignals', () => {
  it('always reports the time and never throws without a renderer', async () => {
    const s = await proactive.gatherSignals()
    expect(typeof s.at).toBe('string')
  })
})
