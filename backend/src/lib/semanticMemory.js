/**
 * Semantic recall — vectors for the long-term facts, fused with BM25.
 *
 * BM25 (FTS5) only matches shared WORDS: "¿a qué hora entreno?" never finds
 * "Entrena en el gimnasio a las seis". The embedding service (embed_service.py,
 * multilingual-e5-small) maps both to nearby vectors, so a meaning match is
 * found even with zero words in common. Measured on this machine: ~10 ms per
 * query on CPU, and the right fact ranks first for paraphrased questions.
 *
 * Design rules:
 *  - OPTIONAL. Every function degrades to "no vector results" when the service
 *    is down or slow; recall then is exactly the BM25 it was before. A circuit
 *    breaker stops paying the timeout on every turn while it is down.
 *  - Vectors live in their own table (`fact_vectors`), keyed by fact id. A
 *    deleted fact simply stops joining; nothing to migrate in `facts`.
 *  - Brute-force cosine over an in-RAM cache. A few hundred facts × 384 dims is
 *    microseconds; an ANN index would be machinery without a problem to solve.
 *  - Fusion by reciprocal rank (RRF), not by mixing raw scores: BM25 and cosine
 *    live on unrelated scales, ranks don't.
 */

import { storeDb } from './turnStore.js'

const EMBED_URL = () => process.env.JARVIS_EMBED_URL || 'http://127.0.0.1:8797'
const ENABLED = () => process.env.JARVIS_MEMORY_VECTORS !== '0'
// e5 cosines are compressed (unrelated Spanish sentences still score ~0.78), so
// the floor is high. Measured: right fact 0.85–0.86, best wrong one 0.82.
const VEC_MIN = () => Number(process.env.JARVIS_MEMORY_VEC_MIN ?? 0.83)
const QUERY_TIMEOUT_MS = 350
const BREAKER_MS = 60_000
const RRF_K = 60

let downUntil = 0
let migrated = false
/** @type {Map<number, Float32Array>|null} */
let cache = null

function db() {
  const d = storeDb()
  if (!d) return null
  if (!migrated) {
    d.exec(`CREATE TABLE IF NOT EXISTS fact_vectors (
      fact_id INTEGER PRIMARY KEY,
      dim     INTEGER NOT NULL,
      vec     BLOB NOT NULL
    )`)
    migrated = true
  }
  return d
}

/**
 * Ask the embedding service. Returns Float32Array[] or null (down/slow/error).
 * @param {string[]} texts
 * @param {'query'|'passage'} kind
 */
export async function embed(texts, kind = 'passage', timeoutMs = QUERY_TIMEOUT_MS) {
  if (!ENABLED() || !texts.length) return null
  if (Date.now() < downUntil) return null
  try {
    const res = await fetch(`${EMBED_URL()}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, kind }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    return (body.vectors || []).map((v) => Float32Array.from(v))
  } catch {
    downUntil = Date.now() + BREAKER_MS
    return null
  }
}

/** Dot product of two L2-normalised vectors = cosine. Exported for tests. */
export function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/**
 * Reciprocal rank fusion of ranked id lists. Exported for tests.
 * @param {number[][]} lists  each list ranked best-first
 * @returns {number[]} ids, best-first
 */
export function rrf(lists, k = RRF_K) {
  const score = new Map()
  for (const list of lists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)))
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

function loadCache() {
  if (cache) return cache
  cache = new Map()
  const d = db()
  if (!d) return cache
  try {
    for (const r of d.prepare('SELECT v.fact_id, v.vec FROM fact_vectors v JOIN facts f ON f.id = v.fact_id').all()) {
      const buf = r.vec
      cache.set(Number(r.fact_id), new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice())
    }
  } catch (e) {
    console.warn('[semantic] cache load failed —', e?.message)
  }
  return cache
}

/**
 * Fact ids ranked by meaning, above the similarity floor.
 * @returns {Promise<number[]>} empty when the service is unavailable
 */
export async function vectorSearch(query, limit = 6) {
  const q = String(query ?? '').trim()
  if (q.length < 4) return []
  const vecs = loadCache()
  if (!vecs.size) return []
  const got = await embed([q], 'query')
  if (!got?.[0]) return []
  const qv = got[0]
  const floor = VEC_MIN()
  return [...vecs.entries()]
    .map(([id, v]) => [id, cosine(qv, v)])
    .filter(([, s]) => s >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
}

/** Fetch fact rows by id, preserving the given order. */
export function factsByIds(ids) {
  const d = db()
  if (!d || !ids.length) return []
  const rows = d.prepare(`SELECT * FROM facts WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  return ids.map((id) => byId.get(id)).filter(Boolean)
}

let indexing = false
let indexTimer = null

/**
 * Embed every fact that has no vector yet. Batched, background, idempotent.
 * @returns {Promise<number>} how many were indexed
 */
export async function indexFacts() {
  if (indexing || !ENABLED()) return 0
  const d = db()
  if (!d) return 0
  indexing = true
  let done = 0
  try {
    for (;;) {
      const rows = d.prepare(`SELECT f.id, f.text FROM facts f
        LEFT JOIN fact_vectors v ON v.fact_id = f.id
        WHERE v.fact_id IS NULL LIMIT 32`).all()
      if (!rows.length) break
      // Indexing is background work: a generous timeout, it's not on a turn.
      const vecs = await embed(rows.map((r) => r.text), 'passage', 30_000)
      if (!vecs || vecs.length !== rows.length) break
      const ins = d.prepare('INSERT OR REPLACE INTO fact_vectors (fact_id, dim, vec) VALUES (?, ?, ?)')
      rows.forEach((r, i) => {
        const v = vecs[i]
        ins.run(r.id, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength))
        loadCache().set(Number(r.id), v)
      })
      done += rows.length
    }
  } catch (e) {
    console.warn('[semantic] index failed —', e?.message)
  } finally {
    indexing = false
  }
  if (done) console.log(`[semantic] ${done} hecho(s) indexado(s)`)
  return done
}

/** Debounced indexFacts — call after anything adds facts. */
export function scheduleIndex(delayMs = 2000) {
  if (indexTimer) clearTimeout(indexTimer)
  indexTimer = setTimeout(() => { indexTimer = null; indexFacts().catch(() => {}) }, delayMs)
  indexTimer.unref?.()
}

/** Forget the RAM cache (after a delete). */
export function invalidateVectors() {
  cache = null
}
