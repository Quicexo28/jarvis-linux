import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let store
let dir

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-turnstore-'))
  process.env.JARVIS_DB_PATH = join(dir, 'test.db')
  store = await import('../src/lib/turnStore.js')
})

afterAll(() => {
  store?.closeStore()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('toMatchQuery', () => {
  it('strips FTS5 operators so a raw transcript cannot be a syntax error', () => {
    const q = store.toMatchQuery('¿qué dijo del proyecto "jarvis" - NEAR/2 algo*?')
    expect(q).not.toMatch(/[*:\-/]/)
    expect(q).toContain('"proyecto"')
    expect(q).toContain('"jarvis"')
  })

  it('drops stopwords and short tokens', () => {
    expect(store.toMatchQuery('el la de a y que')).toBe('')
    expect(store.toMatchQuery('')).toBe('')
  })

  it('caps the token count so a long utterance stays a cheap query', () => {
    const long = Array.from({ length: 40 }, (_, i) => `palabra${i}`).join(' ')
    expect(store.toMatchQuery(long).split(' OR ').length).toBe(12)
  })
})

describe('turns', () => {
  it('records a turn and finds it by full text, accent-insensitively', () => {
    const id = store.recordTurn({
      text: 'pon un temporizador de diez minutos para el café',
      reply: 'Temporizador corriendo.',
      intent: 'timer_start',
      model: 'haiku',
      tools: ['timer_start'],
      msFirst: 240,
      msTotal: 1800,
      inTokens: 100,
      outTokens: 20,
      costUsd: 0.0012,
      sessionId: 'sess-1',
      speaker: 'santiago',
      mode: 'OWNER',
    })
    expect(id).toBeGreaterThan(0)

    // "cafe" (no accent) must match "café" — remove_diacritics 2.
    const hits = store.searchTurns('cafe temporizador')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].intent).toBe('timer_start')
    expect(JSON.parse(hits[0].tools)).toEqual(['timer_start'])
  })

  it('returns [] for an unsearchable query instead of throwing', () => {
    expect(store.searchTurns('¿?')).toEqual([])
  })

  it('lists recent turns newest first', () => {
    store.recordTurn({ text: 'segunda frase de prueba', ts: Date.now() + 1000 })
    const recent = store.recentTurns(2)
    expect(recent[0].text).toBe('segunda frase de prueba')
  })
})

describe('facts', () => {
  it('stores and recalls a fact', () => {
    store.addFact({ text: 'El señor prefiere el café sin azúcar', kind: 'preference', subject: 'café' })
    const hits = store.searchFacts('quiero un cafe')
    expect(hits.length).toBe(1)
    expect(hits[0].kind).toBe('preference')
  })

  it('dedupes by text and bumps hits instead of duplicating', () => {
    const a = store.addFact({ text: 'El proyecto activo es Jarvis' })
    const b = store.addFact({ text: 'El proyecto activo es Jarvis' })
    expect(a).toBe(b)
    const all = store.allFacts()
    expect(all.filter((f) => f.text === 'El proyecto activo es Jarvis').length).toBe(1)
  })

  it('deletes a wrong fact from both the table and the index', () => {
    const id = store.addFact({ text: 'Dato equivocado sobre bicicletas' })
    expect(store.deleteFact(id)).toBe(true)
    expect(store.searchFacts('bicicletas')).toEqual([])
  })
})

describe('kv + stats', () => {
  it('round-trips a key', () => {
    store.kvSet('session:haiku', 'uuid-123')
    expect(store.kvGet('session:haiku')).toBe('uuid-123')
    store.kvSet('session:haiku', 'uuid-456')
    expect(store.kvGet('session:haiku')).toBe('uuid-456')
    expect(store.kvGet('nope')).toBeNull()
  })

  it('aggregates latency and cost', () => {
    const s = store.turnStats(24)
    expect(s.turns).toBeGreaterThan(0)
    expect(s.byModel.haiku).toBe(1)
    expect(s.costUsd).toBeCloseTo(0.0012, 4)
    expect(s.firstSentenceMs.p50).toBe(240)
  })
})
