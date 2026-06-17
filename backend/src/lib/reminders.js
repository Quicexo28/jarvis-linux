import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { runClaude } from './claudeCli.js'
import { notifyJarvis } from './cloudStorage.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', '..', 'data')
const STORE = join(DATA_DIR, 'reminders.json')

// Legacy repeat values kept for backward-compat reads
const REPEAT_MS = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3 }

// Bogotá is UTC-5
const BOGOTA_OFFSET_H = -5

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

/**
 * Add a reminder.
 *
 * New schema: { text, type, fireAt, schedule }
 *   type: 'once_at' | 'once_after' | 'recurring_at' | 'recurring_every'
 *   schedule: null | { days, hour, minute } | { intervalMs }
 *
 * Old schema (backward compat): { text, fireAt, repeat }
 *   repeat: 'hourly' | 'daily' | 'weekly' | null
 */
export function addReminder({ text, fireAt, repeat, type, schedule }) {
  let resolvedType = type
  let resolvedSchedule = schedule ?? null

  // Backward compat: old 'repeat' field → recurring_every
  if (!resolvedType && repeat && REPEAT_MS[repeat]) {
    resolvedType = 'recurring_every'
    resolvedSchedule = { intervalMs: REPEAT_MS[repeat] }
  } else if (!resolvedType) {
    resolvedType = 'once_at'
  }

  const entry = {
    id: `${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    text: String(text || '').trim(),
    type: resolvedType,
    fireAt: new Date(fireAt).toISOString(),
    schedule: resolvedSchedule,
    createdAt: new Date().toISOString(),
  }
  const list = loadReminders()
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

/**
 * Compute next fire time for recurring reminders. Returns ISO string or null.
 * Handles all 4 types + legacy entries that still have a `repeat` field.
 */
export function nextFire(entry, now) {
  const type = entry.type || 'once_at' // backward compat: no type = once_at

  if (type === 'once_at' || type === 'once_after') return null

  if (type === 'recurring_every') {
    const { intervalMs } = entry.schedule
    let t = new Date(entry.fireAt).getTime()
    do { t += intervalMs } while (t <= now)
    return new Date(t).toISOString()
  }

  if (type === 'recurring_at') {
    return nextFireRecurringAt(entry.schedule, now)
  }

  // Legacy: entry still has old `repeat` field
  if (entry.repeat && REPEAT_MS[entry.repeat]) {
    const step = REPEAT_MS[entry.repeat]
    let t = new Date(entry.fireAt).getTime()
    do { t += step } while (t <= now)
    return new Date(t).toISOString()
  }

  return null
}

// Exported alias so tests can import it (internal function exported for testability)
export { nextFire as nextFireExported }

/**
 * Find the next UTC datetime where the weekday (in Bogotá) is in `days`
 * and the clock in Bogotá shows hour:minute.
 *
 * days: array of JS weekday ints (0=Sun, 1=Mon … 6=Sat) in Bogotá timezone.
 */
function nextFireRecurringAt(schedule, now) {
  const { days, hour, minute } = schedule
  // hour:minute is in Bogotá (UTC-5) → UTC = hour - BOGOTA_OFFSET_H = hour + 5
  const utcHour = hour - BOGOTA_OFFSET_H // +5

  // Build today's fire candidate in UTC
  const base = new Date(now)
  const todayFire = new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
    utcHour, minute, 0, 0
  ))

  for (let delta = 0; delta < 8; delta++) {
    const candidate = new Date(todayFire.getTime() + delta * 86400000)
    if (candidate.getTime() <= now) continue

    // Determine weekday in Bogotá at the fire moment
    const bogotaMs = candidate.getTime() + BOGOTA_OFFSET_H * 3600000
    const dow = new Date(bogotaMs).getUTCDay()

    if (days.includes(dow)) return candidate.toISOString()
  }

  return null
}

async function tick() {
  const now = Date.now()
  const list = loadReminders()
  const due = list.filter((r) => new Date(r.fireAt).getTime() <= now)
  if (!due.length) return

  // Reschedule/remove BEFORE sending — prevents double-fire on slow Telegram call.
  const kept = []
  for (const r of list) {
    if (new Date(r.fireAt).getTime() > now) { kept.push(r); continue }
    const next = nextFire(r, now)
    if (next) kept.push({ ...r, fireAt: next })
  }
  save(kept)

  for (const r of due) {
    notifyJarvis(`⏰ Recordatorio, señor: ${r.text}`).catch(() => {})
    console.log('[reminders] fired:', r.text)
  }
}

let timer = null

/** Start the scheduler (idempotent). Checks every 30 s. */
export function startScheduler(intervalMs = 30000) {
  if (timer) return
  timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  console.log('[reminders] scheduler started')
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null }
}

const PARSE_SYSTEM = `Eres un parser de recordatorios. Recibes una frase en español y la hora actual en zona America/Bogota (UTC-5).
Devuelves SOLO un objeto JSON (sin texto, sin markdown).

Tipos posibles y su forma exacta:
1. Una vez en fecha/hora específica:
   {"text":string,"type":"once_at","fireAt":string ISO8601 con offset -05:00,"schedule":null}
2. Una vez después de cierto tiempo desde ahora:
   {"text":string,"type":"once_after","fireAt":string ISO8601 con offset -05:00,"schedule":null}
3. Recurrente en días y hora específicos:
   {"text":string,"type":"recurring_at","fireAt":string ISO8601 con offset -05:00,"schedule":{"days":[0..6],"hour":int,"minute":int}}
   - days: 0=domingo,1=lunes,2=martes,3=miércoles,4=jueves,5=viernes,6=sábado
   - Ejemplos: "cada lunes a las 9" → days:[1],hour:9,minute:0
               "días de semana a las 7am" → days:[1,2,3,4,5],hour:7,minute:0
4. Recurrente cada intervalo de tiempo:
   {"text":string,"type":"recurring_every","fireAt":string ISO8601 con offset -05:00,"schedule":{"intervalMs":int}}
   - Ejemplos: "cada hora" → intervalMs:3600000
               "cada 2 horas" → intervalMs:7200000
               "cada 30 minutos" → intervalMs:1800000

Reglas:
- "text": qué recordar, conciso, sin mencionar la hora.
- "fireAt": próximo momento de disparo en America/Bogota (-05:00). Si la hora ya pasó hoy, usa mañana.
- Si no puedes determinar tipo ni hora, devuelve {"error":"no_time"}.`

/**
 * Parse a natural-language reminder request into the 4-type schema.
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
  if (obj.error || !obj.fireAt || !obj.type) return null
  const when = new Date(obj.fireAt)
  if (isNaN(when.getTime())) return null
  return {
    text: String(obj.text || utterance).trim(),
    type: obj.type,
    fireAt: when.toISOString(),
    schedule: obj.schedule ?? null,
  }
}
