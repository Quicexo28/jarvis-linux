/**
 * Watchers — scheduled checks: "avísame si va a llover cada mañana a las 7",
 * "cada hora revisa si me llegó el correo de la universidad".
 *
 * Reminders say a FIXED text at a time; the proactive loop decides on its own
 * what to say. Neither can run a check the señor asked for. The people who keep
 * using their home-made assistants say that is where most of the value is
 * ("crons over the notes", "avísame si…" watchers — HN, 2026).
 *
 * A watcher runs its task on a dedicated Claude session (profile 'watcher'):
 * its MCP server stamps origin=watcher, which toolRisk holds to READ-ONLY, and
 * it cannot write files — nobody is talking, so nothing may act. If the answer
 * is exactly "NADA" it stays quiet; otherwise deliver() says it (voice if the
 * UI is awake, notification if not), never during quiet hours.
 */
import { kvGet, kvSet } from './turnStore.js'
import { deliver, inQuietHours } from './proactive.js'
import { sessionAsk } from './claudeCli.js'

const KV_KEY = 'watchers'
const TZ = 'America/Bogota'
const MAX_ACTIVE = 12
const MIN_EVERY = 15
const LATE_LIMIT_MS = 2 * 3600e3  // a daily check missed by more than this is skipped, not run late
const OWNER = (process['env']['JARVIS_OWNER_NAME'] || 'Santiago').trim()

export const WATCHER_PROMPT = `Eres el vigilante de Jarvis, el asistente personal de ${OWNER}. Ejecutas tareas programadas que el señor dejó encargadas, mientras nadie te habla.

- Haz la tarea con herramientas de CONSULTA: clima, agenda, correo, resumen del día, búsqueda web, notas de la bóveda. No puedes ejecutar acciones (las herramientas que cambian algo te serán rechazadas); si algo requiere actuar, dilo en el aviso.
- Si según la tarea hay algo que el señor deba saber, responde SOLO con el aviso: una o dos frases en español natural, listas para decirse en voz alta, sin markdown, sin URLs, sin símbolos.
- Si no hay nada que avisar según la tarea, responde exactamente: NADA`

let watchers = []
let loaded = false
let running = false
let timer = null

function load() {
  if (loaded) return
  try { watchers = JSON.parse(kvGet(KV_KEY) || '[]') } catch { watchers = [] }
  loaded = true
}
function save() { kvSet(KV_KEY, JSON.stringify(watchers)) }

/** Epoch ms of today's HH:MM in the señor's time zone. */
export function todayAt(hhmm, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number)
  const ymd = new Date(now).toLocaleDateString('en-CA', { timeZone: TZ })
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(new Date(now)).find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00'
  return Date.parse(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${off || '+00:00'}`)
}

/**
 * Pure: is this watcher due at `now`? Daily ones missed by more than
 * LATE_LIMIT_MS (backend down at that hour) are reported as 'skip' — a 7:00
 * rain warning at 15:00 is noise.
 * @returns {'run'|'skip'|null}
 */
export function dueState(w, now = Date.now()) {
  if (!w.active) return null
  if (w.everyMinutes) return !w.lastRunAt || now - w.lastRunAt >= w.everyMinutes * 60e3 ? 'run' : null
  if (w.at) {
    const at = todayAt(w.at, now)
    if (now < at || (w.lastRunAt && w.lastRunAt >= at)) return null
    return now - at > LATE_LIMIT_MS ? 'skip' : 'run'
  }
  return null
}

/** @returns {{ok: true, watcher: object} | {ok: false, error: string, detail: string}} */
export function addWatcher({ task, at = null, everyMinutes = null } = {}, now = Date.now()) {
  load()
  const t = String(task || '').trim()
  if (t.length < 5 || t.length > 400) return { ok: false, error: 'task_invalida', detail: 'Describe la tarea en una frase (5-400 caracteres).' }
  const hhmm = at ? String(at).trim() : null
  if (hhmm && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(hhmm)) return { ok: false, error: 'hora_invalida', detail: 'La hora va en formato HH:MM (24 h).' }
  const every = everyMinutes != null ? Math.round(Number(everyMinutes)) : null
  if (!hhmm && !every) return { ok: false, error: 'horario_requerido', detail: 'Indica una hora diaria (at) o cada cuántos minutos (every_minutes).' }
  if (every != null && (!Number.isFinite(every) || every < MIN_EVERY || every > 1440)) {
    return { ok: false, error: 'intervalo_invalido', detail: `Cada ${MIN_EVERY} a 1440 minutos.` }
  }
  if (watchers.filter((w) => w.active).length >= MAX_ACTIVE) return { ok: false, error: 'demasiados', detail: `Máximo ${MAX_ACTIVE} vigilantes activos.` }
  const w = {
    id: `w${now.toString(36)}`,
    task: t,
    at: hhmm ? hhmm.padStart(5, '0') : null,
    everyMinutes: hhmm ? null : every,
    active: true,
    createdAt: now,
    // An interval watcher waits one interval before its first run; a daily one
    // created after today's hour starts tomorrow.
    lastRunAt: hhmm ? (now >= todayAt(hhmm.padStart(5, '0'), now) ? now : null) : now,
    lastStatus: null,
    lastResult: null,
  }
  watchers.push(w)
  save()
  return { ok: true, watcher: w }
}

export function listWatchers() {
  load()
  return watchers.filter((w) => w.active)
}

function findWatchers({ id, match }) {
  if (id) return watchers.filter((w) => w.active && w.id === id)
  const want = String(match || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim()
  if (!want) return []
  return watchers.filter((w) => w.active && w.task.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').includes(want))
}

/** @returns {number} how many were cancelled; >1 matches by text is refused (ambiguous) */
export function cancelWatchers({ id = null, match = null } = {}) {
  load()
  const hit = findWatchers({ id, match })
  if (hit.length > 1 && !id) return -hit.length
  for (const w of hit) w.active = false
  if (hit.length) save()
  return hit.length
}

// A turn that ended in a CLI error (usage limit, timeout) is a failure, not
// news: before this, "You've hit your session limit" went out as a notification.
const defaultAsk = async (message) => {
  let meta = null
  const reply = await sessionAsk(message, {
    systemPromptText: WATCHER_PROMPT, model: 'haiku', timeoutMs: 120000,
    fallbackReply: '', profile: 'watcher', tag: 'watcher', onMeta: (m) => { meta = m },
  })
  return meta?.isError ? '' : reply
}

/**
 * Run one watcher now. Injectable for tests.
 * @returns {Promise<{status: 'avisado'|'nada'|'silenciado'|'fallo', reply: string}>}
 */
export async function runWatcher(w, { ask = defaultAsk, notify = deliver, now = Date.now() } = {}) {
  const when = new Date(now).toLocaleString('es-CO', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' })
  let reply = ''
  try { reply = String(await ask(`Tarea programada: ${w.task}\nFecha y hora: ${when}.`) || '').trim() } catch {}
  let status
  if (!reply) status = 'fallo'
  else if (/^nada[.!]?$/i.test(reply)) status = 'nada'
  else if (inQuietHours(new Date(now))) status = 'silenciado'
  else { await notify(reply).catch(() => {}); status = 'avisado' }
  w.lastRunAt = now
  w.lastStatus = status
  w.lastResult = reply.slice(0, 300)
  save()
  console.log(`[watchers] ${w.id} ${status}: ${w.task.slice(0, 60)}${status === 'avisado' ? ` -> ${reply.slice(0, 80)}` : ''}`)
  return { status, reply }
}

export async function runWatcherNow(id, deps) {
  load()
  const w = watchers.find((x) => x.active && x.id === id)
  if (!w) return null
  return runWatcher(w, deps)
}

/** One scheduler tick: run what is due, one at a time. Exported for tests. */
export async function tick(deps = {}, now = Date.now()) {
  load()
  if (running) return 0
  running = true
  let ran = 0
  try {
    for (const w of watchers) {
      const state = dueState(w, now)
      if (state === 'skip') { w.lastRunAt = now; w.lastStatus = 'omitido'; save(); continue }
      if (state === 'run') { await runWatcher(w, { ...deps, now }); ran++ }
    }
  } finally {
    running = false
  }
  return ran
}

export function startWatchers(intervalMs = 60e3) {
  if (timer || process['env']['JARVIS_WATCHERS'] === '0') return
  load()
  timer = setInterval(() => { tick().catch((e) => console.warn('[watchers] tick failed —', e?.message)) }, intervalMs)
  if (listWatchers().length) console.log(`[watchers] ${listWatchers().length} activo(s)`)
}

/** Test hook. */
export function _resetWatchersForTests() {
  watchers = []
  loaded = true
  running = false
}
