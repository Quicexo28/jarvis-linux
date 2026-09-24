/**
 * Proactive agent — the half of Jarvis that speaks without being spoken to.
 *
 * Everything before this was reactive: a turn existed only because someone said
 * something. The pieces that DID reach out (reminders, the Rust agents' disk and
 * boot watchers) each hardcode their own trigger and fire unconditionally. There
 * was no place that looks at the whole picture and asks "is anything worth
 * interrupting him for right now?", and no budget to keep the answer honest.
 *
 * Shape of one tick:
 *   1. gather cheap LOCAL signals (no API cost, no network)
 *   2. bail out early on the free rules (quiet hours, budget spent, mid-conversation)
 *   3. ask haiku for at most ONE thing worth saying, given what it already said
 *   4. deliver: voice if the renderer is awake, Telegram otherwise
 *
 * The budget is the important part. An assistant that can talk whenever it likes
 * becomes noise, and noise gets muted — so the limits are enforced in code
 * (count/day, quiet hours, minimum gap, no repeats), never left to the model.
 *
 * Off with JARVIS_PROACTIVE=0.
 */

import { getAttentionState } from './attentionState.js'
import { runClaude } from './claudeCli.js'
import { notifyJarvis } from './cloudStorage.js'
import { getCurrentState } from './mobileContext.js'
import { loadReminders } from './reminders.js'
import { hasClient, requestClient } from './skillBus.js'
import { kvGet, kvSet, turnStats, allFacts, addFact } from './turnStore.js'

const ENABLED = () => process['env']['JARVIS_PROACTIVE'] !== '0'
const INTERVAL_MS = () => Number(process['env']['JARVIS_PROACTIVE_INTERVAL_MS'] || 30 * 60e3)
const MAX_PER_DAY = () => Number(process['env']['JARVIS_PROACTIVE_MAX_DAY'] || 6)
const MIN_GAP_MS = () => Number(process['env']['JARVIS_PROACTIVE_MIN_GAP_MS'] || 45 * 60e3)
// Quiet hours in local time, [start, end) crossing midnight.
const QUIET_FROM = () => Number(process['env']['JARVIS_PROACTIVE_QUIET_FROM'] ?? 23)
const QUIET_TO = () => Number(process['env']['JARVIS_PROACTIVE_QUIET_TO'] ?? 7)
const TZ = 'America/Bogota'

let timer = null

// ── budget bookkeeping (persisted: a restart must not reset the day's quota) ──

function todayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ })   // YYYY-MM-DD
}

function sentToday() {
  const raw = kvGet('proactive:count')
  if (!raw) return 0
  const [day, n] = String(raw).split('|')
  return day === todayKey() ? Number(n) || 0 : 0
}

function recordSent() {
  kvSet('proactive:count', `${todayKey()}|${sentToday() + 1}`)
  kvSet('proactive:last', String(Date.now()))
}

function lastSentAt() {
  return Number(kvGet('proactive:last') || 0)
}

function inQuietHours(now = new Date()) {
  const hour = Number(now.toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }))
  const from = QUIET_FROM()
  const to = QUIET_TO()
  return from > to ? (hour >= from || hour < to) : (hour >= from && hour < to)
}

/**
 * The free checks, in order of cheapness. Returns a reason string when the tick
 * must stop, or null to continue.
 */
export function blockingReason(now = new Date()) {
  if (!ENABLED()) return 'disabled'
  if (inQuietHours(now)) return 'quiet_hours'
  if (sentToday() >= MAX_PER_DAY()) return 'daily_budget_spent'
  const since = Date.now() - lastSentAt()
  if (lastSentAt() && since < MIN_GAP_MS()) return 'too_soon'
  // Mid-conversation: he is already talking to Jarvis, and a proactive line on
  // top of a reply is the fastest way to become annoying.
  if (getAttentionState() === 'ENGAGED') return 'user_engaged'
  return null
}

// ── signals ─────────────────────────────────────────────────────────────────

/** Cheap local facts about right now. No API calls, no network. */
export async function gatherSignals() {
  const out = { at: new Date().toLocaleString('es-CO', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }) }

  // Phone/tablet snapshots go stale the moment the device stops reporting. A
  // battery reading from three days ago looked exactly like a live one here, and
  // "señor, le queda 1 por ciento" about a stale sample is worse than silence.
  const FRESH_H = Number(process['env']['JARVIS_PROACTIVE_SIGNAL_FRESH_H'] || 12)
  const fresh = (obj) => {
    if (!obj?.ts) return null
    const ageH = (Date.now() - new Date(obj.ts).getTime()) / 3600e3
    return ageH > FRESH_H ? null : { ...obj, ageHours: Math.round(ageH * 10) / 10 }
  }
  try {
    const st = getCurrentState() || {}
    const battery = fresh(st.battery)
    const presence = fresh(st.presence)
    if (battery) out.battery = battery
    if (presence) out.presence = presence
    if (st.location?.place && fresh(st.location)) out.place = st.location.place
    const dropped = [st.battery && !battery && 'bateria', st.presence && !presence && 'presencia']
      .filter(Boolean)
    if (dropped.length) out.staleIgnored = dropped
  } catch {}

  try {
    const pending = loadReminders().filter((r) => !r.done)
    const soon = pending.filter((r) => {
      const t = new Date(r.when_iso ?? r.when ?? 0).getTime()
      return t && t - Date.now() < 4 * 3600e3 && t > Date.now()
    })
    if (soon.length) out.remindersSoon = soon.map((r) => ({ text: r.text, when: r.when_iso ?? r.when }))
    out.remindersPending = pending.length
  } catch {}

  try {
    const s = turnStats(24)
    if (s) out.today = { turns: s.turns, costUsd: s.costUsd, errors: s.errors, verdicts: s.byVerdict }
  } catch {}

  // What the renderer is doing — a proactive line makes no sense if the UI is
  // asleep and nobody is around.
  try {
    if (hasClient()) out.ui = await requestClient('view_current', {}, 3000)
  } catch {}

  return out
}

const DECIDE_PROMPT = `Decides si el asistente Jarvis debe decirle algo a Santiago AHORA, por iniciativa propia, sin que él haya preguntado nada.

Recibes señales del sistema en JSON y la lista de lo último que ya le dijiste por iniciativa propia.

Devuelves SOLO un objeto JSON, sin markdown: {"say": true|false, "text": "...", "kind": "..."}

kind es uno de: recordatorio, bateria, salud, rutina, seguimiento.

DI ALGO solo si se cumple TODO esto:
- Es ÚTIL ahora y se pierde valor si esperas a que él pregunte.
- Es ACCIONABLE: él puede hacer algo al respecto en este momento.
- NO se lo has dicho ya (mira la lista de avisos recientes).
- No es una obviedad, ni un saludo, ni una charla, ni un resumen de lo que sabes.

NO digas nada (say=false) si solo tienes: estado normal del sistema, batería por encima del 25 por ciento, curiosidades, ánimos, o ganas de conversar. El silencio es la respuesta correcta la mayoría de las veces.

"text" es UNA frase corta en español, dicha en voz alta al estilo del asistente (trata a Santiago de "señor"), sin símbolos, sin emojis, sin rutas ni URLs, sin nombrar herramientas ni detalles técnicos. Si say es false, "text" es "".`

/**
 * Ask the model whether anything deserves interrupting. Returns null on any
 * doubt — a malformed answer must never become a spoken interruption.
 * @param {object} signals
 * @param {string[]} recent
 */
export async function decide(signals, recent) {
  const input = `SEÑALES:\n${JSON.stringify(signals, null, 1)}\n\nAVISOS RECIENTES (no repitas):\n${recent.length ? recent.map((r) => `- ${r}`).join('\n') : '(ninguno)'}`
  const out = await runClaude(input, {
    systemPromptText: DECIDE_PROMPT,
    model: 'haiku',
    timeoutMs: 25000,
    namespace: 'jarvis-proactive',
    fallbackReply: '{"say":false}',
    multiline: true,
  })
  try {
    const start = out.indexOf('{')
    const end = out.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const parsed = JSON.parse(out.slice(start, end + 1))
    if (!parsed?.say) return null
    const text = String(parsed.text ?? '').trim()
    if (text.length < 8 || text.length > 300) return null
    return { text, kind: String(parsed.kind ?? 'aviso').slice(0, 24) }
  } catch {
    return null
  }
}

/** Recent proactive notices, so the model can avoid repeating itself. */
function recentNotices(limit = 8) {
  return allFacts(200)
    .filter((f) => f.kind === 'proactive')
    .slice(0, limit)
    .map((f) => f.text)
}

/**
 * Say it out loud if anyone is listening; fall back to Telegram otherwise.
 * Exported: the study timer and the morning briefing speak the same way.
 * @returns {Promise<'voice'|'telegram'|'failed'>}
 */
export async function deliver(text) {
  if (hasClient()) {
    try {
      await requestClient('speak_text', { text }, 20000)
      return 'voice'
    } catch (e) {
      console.warn('[proactive] speak failed, falling back to Telegram —', e?.message)
    }
  }
  try {
    await notifyJarvis(text)
    return 'telegram'
  } catch {
    return 'failed'
  }
}

/** One full cycle. Exported so it can be triggered and tested on demand. */
export async function runOnce({ force = false } = {}) {
  const blocked = force ? null : blockingReason()
  if (blocked) return { acted: false, reason: blocked }

  const signals = await gatherSignals()
  const decision = await decide(signals, recentNotices())
  if (!decision) return { acted: false, reason: 'nothing_worth_saying' }

  const via = await deliver(decision.text)
  if (via === 'failed') return { acted: false, reason: 'delivery_failed', text: decision.text }

  recordSent()
  // Store as a fact so the next tick can see it and not repeat itself, and so
  // it shows up in /api/jarvis/memory like anything else Jarvis knows.
  addFact({ text: decision.text, kind: 'proactive', subject: decision.kind, source: `proactive:${via}` })
  console.log(`[proactive] ${via}: ${decision.text}`)
  return { acted: true, via, ...decision }
}

/** Start the background loop. Safe to call once at boot. */
export function startProactiveLoop() {
  if (timer || !ENABLED()) return
  const tick = () => {
    runOnce().catch((e) => console.warn('[proactive] tick failed —', e?.message))
  }
  // First tick one interval in, never at boot: a just-restarted backend has no
  // idea what happened while it was down.
  timer = setInterval(tick, INTERVAL_MS())
  if (typeof timer.unref === 'function') timer.unref()
  console.log(`[proactive] loop armed: cada ${Math.round(INTERVAL_MS() / 60e3)} min, máx ${MAX_PER_DAY()}/día`)
}

export function stopProactiveLoop() {
  if (timer) clearInterval(timer)
  timer = null
}
