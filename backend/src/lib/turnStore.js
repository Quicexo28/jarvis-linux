/**
 * Turn store — persistent SQLite substrate for BOTH observability and memory.
 *
 * Two problems it solves, one table set:
 *
 * 1. Observability: every turn's transcript, intent, model, tools, latency,
 *    tokens and cost. Until now the only record was one `[turn]` console line
 *    (handlers/speech.js), so every threshold in the voice stack was tuned by
 *    eyeballing journald and nothing could be replayed or measured.
 * 2. Memory: `conversationMemory.js` keeps 8 turns in RAM and dies on restart,
 *    and the vault history (06-Conversaciones) is write-only — nothing ever
 *    reads it back. Facts extracted from turns live here and are recalled by
 *    full-text search on the next turn.
 *
 * `node:sqlite` is built into Node 22+ (this machine runs 26.3), so this adds
 * ZERO dependencies. FTS5 is compiled in — verified with `remove_diacritics 2`,
 * which is what makes "cafe" match "café" in Spanish recall.
 *
 * Every export degrades to a no-op (or empty array) when the database can't be
 * opened: a broken store must never take a voice turn down with it.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// `node:sqlite` is loaded through createRequire, NOT a static import: vitest's
// bundled vite resolves imports against its own (older) list of Node builtins,
// where node:sqlite doesn't exist yet — a static import dies at collection time
// with "Failed to load url sqlite". createRequire goes straight to the Node
// resolver, so the same code works in the backend process and under vitest.
const require = createRequire(import.meta.url)

const __dir = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PATH = join(__dir, '..', '..', 'data', 'jarvis.db')

let db = null
let initFailed = false

/** Open (once) and migrate the database. Returns null when unusable. */
function getDb() {
  if (db) return db
  if (initFailed) return null
  try {
    const path = process['env']['JARVIS_DB_PATH'] || DEFAULT_PATH
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const { DatabaseSync } = require("node:sqlite")
    db = new DatabaseSync(path)
    // WAL: the backend writes turns while an async fact extractor reads them.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    migrate(db)
    return db
  } catch (e) {
    console.warn('[turnStore] disabled —', e?.message)
    initFailed = true
    db = null
    return null
  }
}

/**
 * The shared handle, for sibling stores (study, habits) that keep their own
 * tables in the same file. null when the database is unusable.
 */
export function storeDb() {
  return getDb()
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      speaker     TEXT,
      mode        TEXT,
      source      TEXT,
      text        TEXT NOT NULL,
      reply       TEXT,
      intent      TEXT,
      model       TEXT,
      tools       TEXT,
      ms_first    INTEGER,
      ms_total    INTEGER,
      in_tokens   INTEGER,
      out_tokens  INTEGER,
      cost_usd    REAL,
      session_id  TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);

    CREATE TABLE IF NOT EXISTS facts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      kind       TEXT,
      subject    TEXT,
      text       TEXT NOT NULL UNIQUE,
      source     TEXT,
      hits       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `)
  // `verdict` arrived after the first turns were already stored, so it needs an
  // ALTER: CREATE TABLE IF NOT EXISTS silently does nothing on an existing table
  // and the column would never appear.
  ensureColumn(d, 'turns', 'verdict', 'TEXT')

  // FTS5 mirrors, kept in sync manually (external-content tables would need
  // triggers we'd have to migrate too; the write volume here is a few rows per
  // minute, so explicit inserts are simpler and just as fast).
  // remove_diacritics 2 is what makes accent-insensitive Spanish recall work.
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts
      USING fts5(text, reply, tokenize = "unicode61 remove_diacritics 2");
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
      USING fts5(text, subject, tokenize = "unicode61 remove_diacritics 2");
  `)
}

/** Add a column if the table doesn't have it yet. */
function ensureColumn(d, table, column, type) {
  try {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all()
    if (cols.some((c) => c.name === column)) return
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  } catch (e) {
    console.warn(`[turnStore] ensureColumn ${table}.${column} —`, e?.message)
  }
}

// ── query sanitation ────────────────────────────────────────────────────────
// FTS5 MATCH is a query language: quotes, '*', '-', ':' and NEAR are operators,
// so a raw transcript ("¿qué dijo del proyecto?") is a syntax error, not a
// search. Reduce any user text to bare word tokens joined by OR.

const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a',
  'y', 'o', 'que', 'qué', 'en', 'con', 'por', 'para', 'es', 'son', 'era', 'fue',
  'me', 'te', 'se', 'lo', 'le', 'mi', 'tu', 'su', 'yo', 'tú', 'él', 'ella',
  'este', 'esta', 'eso', 'esto', 'ese', 'esa', 'como', 'cómo', 'muy', 'más',
  'pero', 'si', 'sí', 'no', 'ya', 'hay', 'ha', 'he', 'has', 'the', 'and', 'of',
])

/**
 * Turn arbitrary text into a safe FTS5 MATCH expression, or '' when there is
 * nothing searchable left.
 * @param {string} text
 * @returns {string}
 */
export function toMatchQuery(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  if (!words.length) return ''
  // Dedupe, cap: a 40-word utterance makes a slow, meaningless OR query.
  const uniq = [...new Set(words)].slice(0, 12)
  return uniq.map((w) => `"${w}"`).join(' OR ')
}

// ── turns ───────────────────────────────────────────────────────────────────

/**
 * Persist one completed turn. Never throws.
 * @param {object} t
 * @returns {number|null} row id
 */
export function recordTurn(t = {}) {
  const d = getDb()
  if (!d) return null
  try {
    const stmt = d.prepare(`
      INSERT INTO turns (ts, speaker, mode, source, text, reply, intent, model,
                         tools, ms_first, ms_total, in_tokens, out_tokens,
                         cost_usd, session_id, error, verdict)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const info = stmt.run(
      t.ts ?? Date.now(),
      t.speaker ?? null,
      t.mode ?? null,
      t.source ?? 'voice',
      String(t.text ?? ''),
      t.reply ?? null,
      t.intent ?? null,
      t.model ?? null,
      t.tools ? JSON.stringify(t.tools) : null,
      t.msFirst ?? null,
      t.msTotal ?? null,
      t.inTokens ?? null,
      t.outTokens ?? null,
      t.costUsd ?? null,
      t.sessionId ?? null,
      t.error ?? null,
      t.verdict ?? null,
    )
    const id = Number(info.lastInsertRowid)
    d.prepare('INSERT INTO turns_fts (rowid, text, reply) VALUES (?, ?, ?)')
      .run(id, String(t.text ?? ''), String(t.reply ?? ''))
    return id
  } catch (e) {
    console.warn('[turnStore] recordTurn failed —', e?.message)
    return null
  }
}

/**
 * Attach a verification verdict to an already-stored turn. Verification runs
 * after the reply is spoken, so it can never be part of the INSERT.
 * @param {number} id
 * @param {string} verdict
 */
export function setTurnVerdict(id, verdict) {
  const d = getDb()
  if (!d || !id) return false
  try {
    d.prepare('UPDATE turns SET verdict = ? WHERE id = ?').run(String(verdict).slice(0, 500), id)
    return true
  } catch (e) {
    console.warn('[turnStore] setTurnVerdict failed —', e?.message)
    return false
  }
}

/**
 * Most recent turns, newest first.
 * @param {number} limit
 */
export function recentTurns(limit = 20) {
  const d = getDb()
  if (!d) return []
  try {
    return d.prepare('SELECT * FROM turns ORDER BY ts DESC LIMIT ?').all(limit)
  } catch {
    return []
  }
}

/**
 * Full-text search over past turns.
 * @param {string} query
 * @param {number} limit
 */
export function searchTurns(query, limit = 5) {
  const d = getDb()
  if (!d) return []
  const match = toMatchQuery(query)
  if (!match) return []
  try {
    return d.prepare(`
      SELECT t.* FROM turns_fts f
      JOIN turns t ON t.id = f.rowid
      WHERE turns_fts MATCH ?
      ORDER BY bm25(turns_fts) LIMIT ?
    `).all(match, limit)
  } catch (e) {
    console.warn('[turnStore] searchTurns failed —', e?.message)
    return []
  }
}

// ── facts (long-term memory) ────────────────────────────────────────────────

/**
 * Insert or refresh one fact. Text is the natural key, so re-learning the same
 * fact bumps its timestamp instead of duplicating it.
 * @param {{text: string, kind?: string, subject?: string, source?: string}} f
 * @returns {number|null}
 */
export function addFact(f = {}) {
  const d = getDb()
  if (!d) return null
  const text = String(f.text ?? '').trim()
  if (!text) return null
  try {
    const now = Date.now()
    const existing = d.prepare('SELECT id FROM facts WHERE text = ?').get(text)
    if (existing) {
      d.prepare('UPDATE facts SET updated_at = ?, hits = hits + 1 WHERE id = ?')
        .run(now, existing.id)
      return Number(existing.id)
    }
    const info = d.prepare(`
      INSERT INTO facts (ts, updated_at, kind, subject, text, source, hits)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(now, now, f.kind ?? 'fact', f.subject ?? null, text, f.source ?? null)
    const id = Number(info.lastInsertRowid)
    d.prepare('INSERT INTO facts_fts (rowid, text, subject) VALUES (?, ?, ?)')
      .run(id, text, String(f.subject ?? ''))
    return id
  } catch (e) {
    console.warn('[turnStore] addFact failed —', e?.message)
    return null
  }
}

/**
 * Recall facts relevant to a query, best match first. Bumps `hits` on what it
 * returns so unused facts can be pruned later.
 * @param {string} query
 * @param {number} limit
 */
export function searchFacts(query, limit = 6) {
  const d = getDb()
  if (!d) return []
  const match = toMatchQuery(query)
  if (!match) return []
  try {
    const rows = d.prepare(`
      SELECT f.* FROM facts_fts x
      JOIN facts f ON f.id = x.rowid
      WHERE facts_fts MATCH ?
      ORDER BY bm25(facts_fts) LIMIT ?
    `).all(match, limit)
    for (const r of rows) {
      try { d.prepare('UPDATE facts SET hits = hits + 1 WHERE id = ?').run(r.id) } catch {}
    }
    return rows
  } catch (e) {
    console.warn('[turnStore] searchFacts failed —', e?.message)
    return []
  }
}

/** All facts, newest first — for the profile dump and for pruning. */
export function allFacts(limit = 200) {
  const d = getDb()
  if (!d) return []
  try {
    return d.prepare('SELECT * FROM facts ORDER BY updated_at DESC LIMIT ?').all(limit)
  } catch {
    return []
  }
}

/** Delete a fact by id (wrong/outdated memories must be removable). */
export function deleteFact(id) {
  const d = getDb()
  if (!d) return false
  try {
    d.prepare('DELETE FROM facts WHERE id = ?').run(id)
    d.prepare('DELETE FROM facts_fts WHERE rowid = ?').run(id)
    return true
  } catch {
    return false
  }
}

// ── small key/value (session ids, counters) ─────────────────────────────────

export function kvGet(k) {
  const d = getDb()
  if (!d) return null
  try {
    return d.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null
  } catch {
    return null
  }
}

export function kvSet(k, v) {
  const d = getDb()
  if (!d) return false
  try {
    d.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, String(v))
    return true
  } catch {
    return false
  }
}

// ── aggregate stats (for /api/jarvis/stats and evals) ───────────────────────

/**
 * Rolling stats over the last `hours` of turns: volume, latency percentiles,
 * cost, model and intent mix, error rate.
 * @param {number} hours
 */
export function turnStats(hours = 24) {
  const d = getDb()
  if (!d) return null
  try {
    const since = Date.now() - hours * 3600e3
    const rows = d.prepare(
      'SELECT intent, model, ms_first, ms_total, cost_usd, error, verdict FROM turns WHERE ts >= ?'
    ).all(since)
    if (!rows.length) return { hours, turns: 0 }
    const firsts = rows.map((r) => r.ms_first).filter((n) => typeof n === 'number' && n >= 0).sort((a, b) => a - b)
    const totals = rows.map((r) => r.ms_total).filter((n) => typeof n === 'number' && n >= 0).sort((a, b) => a - b)
    const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null)
    const tally = (key) => {
      const out = {}
      for (const r of rows) { const k = r[key] ?? '-'; out[k] = (out[k] ?? 0) + 1 }
      return out
    }
    return {
      hours,
      turns: rows.length,
      errors: rows.filter((r) => r.error).length,
      firstSentenceMs: { p50: pct(firsts, 0.5), p90: pct(firsts, 0.9) },
      totalMs: { p50: pct(totals, 0.5), p90: pct(totals, 0.9) },
      costUsd: Number(rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(4)),
      byModel: tally('model'),
      byIntent: tally('intent'),
      // Verification outcomes: 'ok' means the claimed action was confirmed
      // against real state; anything else is a turn that said one thing and did
      // another. unverified = nothing checkable happened.
      byVerdict: tally('verdict'),
      facts: allFacts(1).length ? d.prepare('SELECT COUNT(*) c FROM facts').get().c : 0,
    }
  } catch (e) {
    console.warn('[turnStore] turnStats failed —', e?.message)
    return null
  }
}

/** Close the database (tests). */
export function closeStore() {
  try { db?.close() } catch {}
  db = null
  initFailed = false
}
