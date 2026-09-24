/**
 * The state of the señor's day in one read: today's tasks, reminders due
 * today, flashcards due, study time, habits, and a running focus session.
 * It answers "¿cómo va mi día?" / "¿qué tengo hoy?" and feeds two automatic
 * moments: the morning briefing and the evening review.
 *
 * The morning briefing fires ONCE per day, the first time the UI is awake
 * (renderer connected) inside the morning window — "awake" is the only
 * presence signal that means he is at the desk. It bypasses the proactive
 * budget on purpose (it is expected, not an interruption) but respects the
 * rules that matter: never mid-conversation, never twice.
 */

import { tasksForToday } from './obsidian.js'
import { loadReminders } from './reminders.js'
import { cardStats, studySummary, habitStatus, localDay } from './studyStore.js'
import { studyStatus } from './studySession.js'
import { kvGet, kvSet } from './turnStore.js'
import { hasClient } from './skillBus.js'
import { getAttentionState } from './attentionState.js'
import { runClaude } from './claudeCli.js'
import { deliver } from './proactive.js'

const TZ = 'America/Bogota'

export function dayBrief(now = Date.now()) {
  const today = localDay(now)
  let reminders = []
  try {
    reminders = loadReminders()
      .filter((r) => !r.done)
      .map((r) => ({ text: r.text, when: r.when_iso ?? r.when }))
      .filter((r) => r.when && localDay(new Date(r.when).getTime()) === today)
  } catch { /* sin recordatorios */ }
  const cards = cardStats(now)
  return {
    date: new Date(now).toLocaleDateString('es-CO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }),
    tasks: tasksForToday(),
    reminders,
    flashcardsDue: cards.due,
    study: studySummary(now),
    studySession: studyStatus(now),
    habits: habitStatus(now),
  }
}

// ── morning briefing ────────────────────────────────────────────────────────

const KV_KEY = 'brief:morning:last'
const FROM_H = () => Number(process.env.JARVIS_BRIEFING_FROM_H ?? 6)
const TO_H = () => Number(process.env.JARVIS_BRIEFING_TO_H ?? 12)
const ENABLED = () => process.env.JARVIS_BRIEFING !== '0'

function hourNow(now) {
  return Number(new Date(now).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24
}

/** Why the briefing must not fire now, or null. Pure apart from its inputs. */
export function briefingBlock({ now = Date.now(), lastDay, awake, attention }) {
  if (!ENABLED()) return 'disabled'
  const h = hourNow(now)
  if (h < FROM_H() || h >= TO_H()) return 'outside_window'
  if (lastDay === localDay(now)) return 'already_today'
  if (!awake) return 'ui_asleep'
  if (attention === 'ENGAGED') return 'user_engaged'
  return null
}

const BRIEF_PROMPT = `Eres Jarvis. Con los datos JSON del día de Santiago, redacta el saludo de la mañana que dirás EN VOZ ALTA.
Reglas: español, dos a cuatro oraciones, trátalo de "señor", sin listas, símbolos, emojis ni rutas. Menciona solo lo que exista: tareas de hoy (cuántas y la más importante), recordatorios con su hora, tarjetas de repaso pendientes, hábitos con racha en juego. Si no hay nada, un saludo breve y ofrece planear el día. No inventes nada que no esté en los datos. Devuelve SOLO el texto a decir.`

/** One check. Exported so it can be triggered on demand and tested. */
export async function maybeMorningBriefing({ force = false, now = Date.now() } = {}) {
  const block = force ? null : briefingBlock({
    now, lastDay: kvGet(KV_KEY), awake: hasClient(), attention: getAttentionState(),
  })
  if (block) return { acted: false, reason: block }
  // Claim the day BEFORE the slow part, so two ticks can't both speak.
  kvSet(KV_KEY, localDay(now))
  const data = dayBrief(now)
  const text = (await runClaude(JSON.stringify(data), {
    systemPromptText: BRIEF_PROMPT,
    model: 'haiku',
    timeoutMs: 25000,
    namespace: 'jarvis-brief',
    fallbackReply: '',
    multiline: true,
  })).trim()
  if (text.length < 8) return { acted: false, reason: 'empty_reply' }
  const via = await deliver(text)
  console.log(`[brief] ${via}: ${text}`)
  return { acted: via !== 'failed', via, text }
}

let timer = null

export function startBriefingLoop(intervalMs = 2 * 60e3) {
  if (timer || !ENABLED()) return
  timer = setInterval(() => {
    maybeMorningBriefing().catch((e) => console.warn('[brief] tick failed —', e?.message))
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
}
