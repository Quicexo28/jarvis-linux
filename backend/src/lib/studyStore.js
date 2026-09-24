/**
 * Study + habit store: flashcards with spaced repetition, the log of focus
 * blocks, and habit check-ins. Same SQLite file as the turn store
 * (`turnStore.storeDb()`), own tables, migrated on first use.
 *
 * The pure pieces — `sm2`, `streak`, `localDay` — are exported separately and
 * carry the logic; the rest is thin SQL. Like the turn store, every export
 * degrades to an empty result when the database is unusable: a broken store
 * must never take a voice turn down with it.
 */

import { storeDb } from './turnStore.js'

const TZ = 'America/Bogota'
const DAY_MS = 86400e3
const RELEARN_MS = 10 * 60e3

/** YYYY-MM-DD in Bogotá, whatever the machine's zone. */
export function localDay(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ })
}

// ── pure logic ──────────────────────────────────────────────────────────────

/**
 * SuperMemo-2 step. `grade` 0-5: 5 perfect, 4 right after a pause, 3 right with
 * effort, 0-2 wrong. A failed card comes back in ten minutes, not tomorrow — in
 * a spoken review session the point is to see it again before the session ends.
 * @param {{ease:number, interval:number, reps:number, lapses:number}} card  interval in days
 * @param {number} grade
 * @param {number} now
 */
export function sm2(card, grade, now = Date.now()) {
  const q = Math.max(0, Math.min(5, Math.round(Number(grade))))
  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = card
  if (q < 3) {
    return { ease, interval: 0, reps: 0, lapses: lapses + 1, due: now + RELEARN_MS }
  }
  reps += 1
  interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(Math.max(1, interval) * ease)
  ease = Math.max(1.3, ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  return { ease: Math.round(ease * 100) / 100, interval, reps, lapses, due: now + interval * DAY_MS }
}

/**
 * Consecutive days ending today — or yesterday, because a habit not done YET
 * today is still alive until midnight.
 * @param {string[]} days  YYYY-MM-DD, any order, duplicates allowed
 * @param {string} today
 */
export function streak(days, today) {
  const set = new Set(days)
  const step = (d, n) => localDay(Date.parse(`${d}T12:00:00-05:00`) + n * DAY_MS)
  let cursor = set.has(today) ? today : step(today, -1)
  let n = 0
  while (set.has(cursor)) {
    n++
    cursor = step(cursor, -1)
  }
  return n
}

/** Canonical habit name: "Ejercicio" and "ejercicio " are the same habit. */
export function habitKey(name) {
  return String(name || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// ── schema ──────────────────────────────────────────────────────────────────

let migrated = false

function db() {
  const d = storeDb()
  if (!d) return null
  if (!migrated) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deck TEXT NOT NULL DEFAULT 'general',
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        ease REAL NOT NULL DEFAULT 2.5,
        interval INTEGER NOT NULL DEFAULT 0,
        reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0,
        due INTEGER NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cards_due ON cards(due);
      CREATE TABLE IF NOT EXISTS study_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        day TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS habit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        habit TEXT NOT NULL,
        label TEXT NOT NULL,
        day TEXT NOT NULL,
        note TEXT,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS habit_day ON habit_log(habit, day);
    `)
    migrated = true
  }
  return d
}

function safe(fn, fallback) {
  try {
    const d = db()
    return d ? fn(d) : fallback
  } catch (e) {
    console.warn('[studyStore]', e?.message)
    return fallback
  }
}

// ── flashcards ──────────────────────────────────────────────────────────────

/** @param {{front:string, back:string}[]} cards */
export function addCards(cards, deck = 'general', now = Date.now()) {
  return safe((d) => {
    const ins = d.prepare('INSERT INTO cards (deck, front, back, due, created) VALUES (?, ?, ?, ?, ?)')
    const ids = []
    for (const c of cards) {
      const front = String(c?.front || '').trim()
      const back = String(c?.back || '').trim()
      if (!front || !back) continue
      ids.push(Number(ins.run(String(deck || 'general').trim().toLowerCase(), front, back, now, now).lastInsertRowid))
    }
    return ids
  }, [])
}

export function dueCards({ deck, limit = 10, now = Date.now() } = {}) {
  return safe((d) => {
    const lim = Math.max(1, Math.min(50, Number(limit) || 10))
    return deck
      ? d.prepare('SELECT id, deck, front, back, reps FROM cards WHERE due <= ? AND deck = ? ORDER BY due LIMIT ?').all(now, String(deck).toLowerCase(), lim)
      : d.prepare('SELECT id, deck, front, back, reps FROM cards WHERE due <= ? ORDER BY due LIMIT ?').all(now, lim)
  }, [])
}

export function gradeCard(id, grade, now = Date.now()) {
  return safe((d) => {
    const card = d.prepare('SELECT * FROM cards WHERE id = ?').get(Number(id))
    if (!card) return null
    const next = sm2(card, grade, now)
    d.prepare('UPDATE cards SET ease = ?, interval = ?, reps = ?, lapses = ?, due = ? WHERE id = ?')
      .run(next.ease, next.interval, next.reps, next.lapses, next.due, card.id)
    return { id: card.id, ...next }
  }, null)
}

export function deleteCard(id) {
  return safe((d) => d.prepare('DELETE FROM cards WHERE id = ?').run(Number(id)).changes > 0, false)
}

export function cardStats(now = Date.now()) {
  return safe((d) => {
    const decks = d.prepare(`
      SELECT deck, COUNT(*) AS total, SUM(CASE WHEN due <= ? THEN 1 ELSE 0 END) AS due
      FROM cards GROUP BY deck ORDER BY deck`).all(now)
    return {
      total: decks.reduce((a, r) => a + r.total, 0),
      due: decks.reduce((a, r) => a + (r.due || 0), 0),
      decks: decks.map((r) => ({ deck: r.deck, total: r.total, due: r.due || 0 })),
    }
  }, { total: 0, due: 0, decks: [] })
}

// ── study log ───────────────────────────────────────────────────────────────

export function logStudy(subject, minutes, now = Date.now()) {
  const m = Math.round(Number(minutes))
  if (!(m >= 1)) return false
  return safe((d) => {
    d.prepare('INSERT INTO study_log (subject, minutes, day, ts) VALUES (?, ?, ?, ?)')
      .run(String(subject || 'estudio').trim().toLowerCase(), m, localDay(now), now)
    return true
  }, false)
}

/** Minutes studied today and over the last 7 days, with a per-subject split. */
export function studySummary(now = Date.now()) {
  return safe((d) => {
    const today = localDay(now)
    const weekStart = localDay(now - 6 * DAY_MS)
    const todayMin = d.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM study_log WHERE day = ?').get(today).m
    const bySubject = d.prepare(`
      SELECT subject, SUM(minutes) AS minutes FROM study_log
      WHERE day >= ? GROUP BY subject ORDER BY minutes DESC`).all(weekStart)
    return {
      todayMinutes: todayMin,
      weekMinutes: bySubject.reduce((a, r) => a + r.minutes, 0),
      weekBySubject: bySubject,
    }
  }, { todayMinutes: 0, weekMinutes: 0, weekBySubject: [] })
}

// ── habits ──────────────────────────────────────────────────────────────────

/** One check-in per habit per day; a second one the same day only updates the note. */
export function logHabit(name, { note, now = Date.now() } = {}) {
  const habit = habitKey(name)
  if (!habit) return null
  return safe((d) => {
    const day = localDay(now)
    const existing = d.prepare('SELECT id FROM habit_log WHERE habit = ? AND day = ?').get(habit, day)
    if (existing) {
      if (note) d.prepare('UPDATE habit_log SET note = ? WHERE id = ?').run(String(note), existing.id)
      return { habit, day, already: true, streak: habitStreak(habit, now) }
    }
    d.prepare('INSERT INTO habit_log (habit, label, day, note, ts) VALUES (?, ?, ?, ?, ?)')
      .run(habit, String(name).trim(), day, note ? String(note) : null, now)
    return { habit, day, already: false, streak: habitStreak(habit, now) }
  }, null)
}

export function habitStreak(habit, now = Date.now()) {
  return safe((d) => {
    const days = d.prepare('SELECT day FROM habit_log WHERE habit = ? ORDER BY day DESC LIMIT 400').all(habitKey(habit)).map((r) => r.day)
    return streak(days, localDay(now))
  }, 0)
}

/** Every habit ever logged: done today?, streak, last 7 days count. */
export function habitStatus(now = Date.now()) {
  return safe((d) => {
    const today = localDay(now)
    const weekStart = localDay(now - 6 * DAY_MS)
    // The label is how it was first said — later check-ins vary in case/accents.
    const habits = d.prepare(`SELECT h.habit, (SELECT label FROM habit_log WHERE habit = h.habit ORDER BY id LIMIT 1) AS label
      FROM habit_log h GROUP BY h.habit ORDER BY h.habit`).all()
    return habits.map((h) => {
      const days = d.prepare('SELECT DISTINCT day FROM habit_log WHERE habit = ? ORDER BY day DESC LIMIT 400').all(h.habit).map((r) => r.day)
      return {
        habit: h.label,
        doneToday: days.includes(today),
        streak: streak(days, today),
        last7: days.filter((x) => x >= weekStart).length,
      }
    })
  }, [])
}
