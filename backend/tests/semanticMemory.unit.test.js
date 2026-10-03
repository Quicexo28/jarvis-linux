import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

process.env.JARVIS_DB_PATH = ':memory:'

let sem
let store
let memory
beforeAll(async () => {
  store = await import('../src/lib/turnStore.js')
  sem = await import('../src/lib/semanticMemory.js')
  memory = await import('../src/lib/memory.js')
})
afterAll(() => vi.unstubAllGlobals())

// A fake embedding service: a tiny "meaning space" where each text is placed by
// the topic words it contains, so paraphrases with no shared word still land
// close together — the property the real model gives us.
const TOPICS = [
  /gimnasio|entren|ejercicio|pesas/i,
  /herman|familia|\bana\b/i, // "\bana\b": a bare /ana/ also matches "mañanas"
  /cort|breve|resum/i,
]
function fakeVector(text) {
  const v = TOPICS.map((re) => (re.test(text) ? 1 : 0))
  v.push(0.05) // never the zero vector
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}
function stubService({ down = false } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (down) throw new Error('ECONNREFUSED')
    const { texts } = JSON.parse(init.body)
    return { ok: true, json: async () => ({ vectors: texts.map(fakeVector), dim: 4 }) }
  }))
}

describe('rrf', () => {
  it('rewards ids that both rankers agree on', () => {
    expect(sem.rrf([[1, 2, 3], [3, 4]])[0]).toBe(3)
  })
  it('keeps everything from both lists', () => {
    expect(new Set(sem.rrf([[1, 2], [5]]))).toEqual(new Set([1, 2, 5]))
  })
})

describe('cosine', () => {
  it('is 1 for the same normalised vector', () => {
    const v = Float32Array.from(fakeVector('gimnasio'))
    expect(sem.cosine(v, v)).toBeCloseTo(1, 5)
  })
})

describe('hybrid recall', () => {
  it('finds a fact by MEANING when no word is shared (BM25 alone cannot)', async () => {
    process.env.JARVIS_MEMORY_VEC_MIN = '0.8'
    stubService()
    store.addFact({ text: 'Entrena en el gimnasio todas las mañanas a las seis', kind: 'routine' })
    store.addFact({ text: 'Su hermana se llama Ana', kind: 'person' })
    expect(await sem.indexFacts()).toBe(2)

    const query = '¿a qué hora hago ejercicio?'
    expect(store.searchFacts(query, 6).map((f) => f.text)).not.toContain('Entrena en el gimnasio todas las mañanas a las seis')
    const got = await memory.hybridFacts(query, 6)
    expect(got[0]?.text).toMatch(/gimnasio/)
    expect(got.map((f) => f.text)).not.toContain('Su hermana se llama Ana')
  })

  it('degrades to plain BM25 when the service is down', async () => {
    stubService({ down: true })
    const got = await memory.hybridFacts('hermana Ana', 6)
    expect(got.map((f) => f.text)).toContain('Su hermana se llama Ana')
  })
})
