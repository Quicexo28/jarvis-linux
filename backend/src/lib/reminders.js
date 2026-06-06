/**
 * Telegram reminder scheduler.
 *
 * Persistent, survives restarts (data/reminders.json). A single interval checks
 * for due reminders and fires them via notifySanti() (Telegram). Supports
 * one-shot and recurring (hourly/daily/weekly) reminders.
 *
 * Natural-language time ("mañana a las 7", "en 2 horas", "cada día a las 9") is
 * parsed by Claude haiku in parseReminder() — robust against free phrasing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { runClaude } from './claudeCli.js'
import { notifyJarvis } from './cloudStorage.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', '..', 'data')
const STORE = join(DATA_DIR, 'reminders.json')

const REPEAT_MS = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3 }

export function loadReminders() {
  try {
    if (!existsSync(STORE)) return []
    return JSON.parse(readFileSync(STORE, 'utf-8'))
  } catch {
    return []
  }
}

function save(list) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(STORE, JSON.stringify(list, null, 2), 'utf-8')
}

/** Add a reminder. fireAt: ISO string. repeat: null|'hourly'|'daily'|'weekly'. */
export function addReminder({ text, fireAt, repeat = null }) {
  const list = loadReminders()
  const entry = {
    id: `${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    text: String(text || '').trim(),
    fireAt: new Date(fireAt).toISOString(),
    repeat: REPEAT_MS[repeat] ? repeat : null,
    createdAt: new Date().toISOString(),
  }
  list.push(entry)
  save(list)
  return entry
}

export function cancelReminder(id) {
  const list = loadReminders()
  const next = list.filter((r) => r.id !== id)
  save(next)
  return next.length !== list.length
}

/** Pending reminders sorted by next fire time. */
export function listReminders() {
  return loadReminders().sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt))
}

// Advance a recurring reminder past now; returns next ISO or null for one-shot.
function nextFire(entry, now) {
  if (!entry.repeat) return null
  const step = REPEAT_MS[entry.repeat]
  let t = new Date(entry.fireAt).getTime()
  do { t += step } while (t <= now)
  return new Date(t).toISOString()
}

async function tick() {
  const now = Date.now()
  const list = loadReminders()
  const due = list.filter((r) => new Date(r.fireAt).getTime() <= now)
  if (!due.length) return

  // Reschedule/remove BEFORE sending so a slow Telegram call can't double-fire.
  const kept = []
  for (const r of list) {
    if (new Date(r.fireAt).getTime() > now) { kept.push(r); continue }
    const next = nextFire(r, now)
    if (next) kept.push({ ...r, fireAt: next })
  }
  save(kept)

  for (const r of due) {
    notifySanti(`⏰ Recordatorio, señor: ${r.text}`).catch(() => {})
    console.log('[reminders] fired:', r.text)
  }
}

let timer = null

/** Start the scheduler (idempotent). Checks every 30 s. */
export function startScheduler(intervalMs = 30000) {
  if (timer) return
  timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref() // don't keep process alive in tests
  console.log('[reminders] scheduler started')
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null }
}

const PARSE_SYSTEM = `Eres un parser de recordatorios. Recibes una frase en español y la hora actual.
Devuelves SOLO un objeto JSON (sin texto, sin markdown) con esta forma exacta:
{"text": string, "fireAt": string ISO8601 con offset -05:00, "repeat": "hourly"|"daily"|"weekly"|null}
- "text": qué recordar, conciso, sin la parte de la hora.
- "fireAt": el próximo instante en que debe dispararse, en zona America/Bogota (-05:00). Si la hora ya pasó hoy, usa el próximo día.
- "repeat": "daily" si dice "cada día"/"todos los días", "hourly" si "cada hora", "weekly" si "cada semana"/"cada lunes", si no null.
Si no puedes determinar una hora, devuelve {"error":"no_time"}.`

/**
 * Parse a natural-language reminder request into { text, fireAt, repeat }.
 * Returns null if no usable time could be extracted.
 */
export async function parseReminder(utterance) {
  const now = new Date()
  const nowStr = now.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' })
  const raw = await runClaude(`Hora actual: ${nowStr}\nFrase: "${utterance}"`, {
    systemPromptText: PARSE_SYSTEM,
    timeoutMs: 15000,
    model: 'haiku',
    fallbackReply: '',
    namespace: 'jarvis-reminder',
  })
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  let obj
  try { obj = JSON.parse(m[0]) } catch { return null }
  if (obj.error || !obj.fireAt) return null
  const when = new Date(obj.fireAt)
  if (isNaN(when.getTime())) return null
  return {
    text: String(obj.text || utterance).trim(),
    fireAt: when.toISOString(),
    repeat: REPEAT_MS[obj.repeat] ? obj.repeat : null,
  }
}
