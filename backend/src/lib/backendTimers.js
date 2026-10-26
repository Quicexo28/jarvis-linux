/**
 * Timers that keep working while the UI is asleep.
 *
 * A timer normally lives in the renderer (zustand store + its own alarm), so
 * with the UI DORMANT "pon un temporizador" failed with renderer_not_connected
 * — the most basic thing an assistant does (seen in the 2026-10-26 eval, and
 * every time the señor talks to Jarvis with the UI put away). While no renderer
 * is connected the backend holds the timer instead: persisted in `kv` so it
 * survives a backend restart (same as the pomodoro), announced through
 * deliver() — voice if the UI is awake by then, desktop/Telegram if not. When
 * the UI wakes, pending timers are handed to the renderer with their remaining
 * time and dropped here, so a timer only ever has one owner.
 *
 * Chronos are NOT covered: a stopwatch is something you look at.
 */
import { kvGet, kvSet } from './turnStore.js'
import { deliver } from './proactive.js'

const KV_KEY = 'timers:backend'

let timers = []           // { id, label, durationMs, endsAt|null, remainingMs|null }
const armed = new Map()   // id -> Timeout
let announce = (text) => deliver(text)

function load() {
  try { return JSON.parse(kvGet(KV_KEY) || '[]') } catch { return [] }
}

function save() {
  kvSet(KV_KEY, JSON.stringify(timers))
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim()
}

/** Same leniency as the renderer's findByLabel: "té" finds "el té". */
function byLabel(label) {
  const want = norm(label)
  if (!want) return timers.length === 1 ? timers : []
  return timers.filter((t) => norm(t.label).includes(want) || want.includes(norm(t.label)))
}

function remaining(t, now) {
  return t.endsAt != null ? Math.max(0, t.endsAt - now) : (t.remainingMs ?? 0)
}

function disarm(id) {
  clearTimeout(armed.get(id))
  armed.delete(id)
}

function fire(id, lateMs = 0) {
  disarm(id)
  const t = timers.find((x) => x.id === id)
  if (!t) return
  timers = timers.filter((x) => x.id !== id)
  save()
  const what = t.label ? `el temporizador de ${t.label}` : 'su temporizador'
  const late = lateMs > 60000 ? `, hace ${Math.round(lateMs / 60000)} minutos` : ''
  announce(`Señor, terminó ${what}${late}.`).catch(() => {})
}

function arm(t, now) {
  disarm(t.id)
  if (t.endsAt == null) return
  armed.set(t.id, setTimeout(() => fire(t.id), Math.max(0, t.endsAt - now)))
}

/** @returns {{id: string, label: string|null, durationMs: number}} */
export function startTimer({ seconds, label = null }, now = Date.now()) {
  const durationMs = Math.round(Number(seconds) * 1000)
  const t = { id: `bt-${now.toString(36)}-${timers.length}`, label: label || null, durationMs, endsAt: now + durationMs, remainingMs: null }
  timers.push(t)
  arm(t, now)
  save()
  return { id: t.id, label: t.label, durationMs }
}

export function listTimers(now = Date.now()) {
  return timers.map((t) => ({
    id: t.id, label: t.label, durationMs: t.durationMs,
    remainingMs: remaining(t, now), running: t.endsAt != null, owner: 'backend',
  }))
}

/** @returns {number} how many were cancelled */
export function cancelTimers({ label = null, all = false } = {}) {
  const hit = all ? [...timers] : byLabel(label)
  for (const t of hit) disarm(t.id)
  timers = timers.filter((t) => !hit.includes(t))
  save()
  return hit.length
}

export function pauseTimers({ label = null } = {}, now = Date.now()) {
  const hit = byLabel(label).filter((t) => t.endsAt != null)
  for (const t of hit) { t.remainingMs = remaining(t, now); t.endsAt = null; disarm(t.id) }
  save()
  return hit.length
}

export function resumeTimers({ label = null } = {}, now = Date.now()) {
  const hit = byLabel(label).filter((t) => t.endsAt == null)
  for (const t of hit) { t.endsAt = now + (t.remainingMs ?? 0); t.remainingMs = null; arm(t, now) }
  save()
  return hit.length
}

export function addToTimers({ label = null, seconds }, now = Date.now()) {
  const delta = Math.round(Number(seconds) * 1000)
  const hit = byLabel(label)
  for (const t of hit) {
    t.durationMs += delta
    if (t.endsAt != null) { t.endsAt += delta; arm(t, now) } else t.remainingMs = (t.remainingMs ?? 0) + delta
  }
  save()
  return hit.length
}

export function resetTimers({ label = null } = {}, now = Date.now()) {
  const hit = byLabel(label)
  for (const t of hit) { t.endsAt = now + t.durationMs; t.remainingMs = null; arm(t, now) }
  save()
  return hit.length
}

export function hasBackendTimers() {
  return timers.length > 0
}

/**
 * Hand every pending timer to the (now connected) renderer and forget it here.
 * `create(durationMs, label)` and `pause(label)` are the renderer primitives.
 * A timer whose hand-off fails stays with the backend.
 */
export async function handOverTimers({ create, pause }, now = Date.now()) {
  let moved = 0
  for (const t of [...timers]) {
    const left = remaining(t, now)
    if (left < 1000) continue  // about to fire: let the backend say it
    try {
      await create(left, t.label)
      if (t.endsAt == null && t.label) await pause(t.label)
      disarm(t.id)
      timers = timers.filter((x) => x !== t)
      moved++
    } catch (e) {
      console.warn(`[timers] hand-off of ${t.label || t.id} failed: ${e?.message || e}`)
    }
  }
  if (moved) {
    save()
    console.log(`[timers] ${moved} timer(s) handed to the renderer`)
  }
  return moved
}

/** Boot: re-arm what survived a restart; one that expired meanwhile is announced late. */
export function restoreTimers(now = Date.now()) {
  timers = load()
  for (const t of [...timers]) {
    if (t.endsAt != null && t.endsAt <= now) fire(t.id, now - t.endsAt)
    else arm(t, now)
  }
  if (timers.length) console.log(`[timers] restored ${timers.length} backend timer(s)`)
}

/** Test hooks. */
export function _resetTimersForTests({ announcer } = {}) {
  for (const id of [...armed.keys()]) disarm(id)
  timers = []
  if (announcer) announce = announcer
}
