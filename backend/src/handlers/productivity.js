import { json, readBody } from '../lib/http.js'
import { addCards, dueCards, gradeCard, deleteCard, cardStats, logHabit, habitStatus } from '../lib/studyStore.js'
import { startStudy, stopStudy, studyStatus } from '../lib/studySession.js'
import { dayBrief, maybeMorningBriefing } from '../lib/dayBrief.js'
import { completeTask, appendHabitEntry } from '../lib/obsidian.js'

// Estudio y productividad para la voz:
//   /api/skills/study/session  → start / stop / status          (pomodoro)
//   /api/skills/study/cards    → add / due / grade / stats / delete  (repaso espaciado)
//   /api/skills/habit          → log / status
//   /api/skills/day/brief      → estado del día (GET)
//   /api/skills/day/briefing   → fuerza el saludo de la mañana (POST)
//   /api/skills/obsidian/task/done → marca una tarea como hecha

async function body(req) {
  try {
    return (await readBody(req)) || {}
  } catch {
    return null
  }
}

export async function handleStudySession(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'status').toLowerCase()
  if (action === 'status') {
    const st = studyStatus()
    return json(res, 200, {
      ok: true, ...st,
      detail: st.active
        ? `${st.phase === 'focus' ? 'Foco' : 'Descanso'} ${st.cycle}/${st.cycles} de ${st.subject}, quedan ${st.remainingMin} min`
        : 'No hay sesión de estudio activa',
    })
  }
  if (action === 'start') {
    const r = await startStudy({ subject: b.subject, focusMin: b.focus_minutes, breakMin: b.break_minutes, cycles: b.cycles })
    return json(res, r.ok ? 200 : 409, {
      ...r,
      detail: r.ok
        ? `Sesión de ${r.status.subject}: ${r.status.cycles} bloques de ${r.status.focusMin} min, descansos de ${r.status.breakMin}. No molestar activado.`
        : 'Ya hay una sesión de estudio en curso',
    })
  }
  if (action === 'stop') {
    const r = await stopStudy()
    return json(res, r.ok ? 200 : 404, {
      ...r,
      detail: r.ok ? `Sesión de ${r.subject} detenida tras ${r.focusedMinutes} min de foco` : 'No había sesión activa',
    })
  }
  return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'start|stop|status' })
}

export async function handleStudyCards(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'stats').toLowerCase()
  switch (action) {
    case 'add': {
      let cards = b.cards
      if (typeof cards === 'string') { try { cards = JSON.parse(cards) } catch { cards = [] } }
      if (!Array.isArray(cards) && b.front && b.back) cards = [{ front: b.front, back: b.back }]
      if (!Array.isArray(cards) || !cards.length) return json(res, 400, { ok: false, error: 'cards_requeridas' })
      const ids = addCards(cards, b.deck)
      return json(res, ids.length ? 200 : 400, { ok: ids.length > 0, ids, detail: `${ids.length} tarjetas añadidas al mazo ${b.deck || 'general'}` })
    }
    case 'due': {
      const cards = dueCards({ deck: b.deck, limit: b.limit })
      return json(res, 200, { ok: true, cards, detail: cards.length ? `${cards.length} tarjetas para repasar` : 'Nada pendiente de repaso' })
    }
    case 'grade': {
      const r = gradeCard(b.id, b.grade)
      if (!r) return json(res, 404, { ok: false, error: 'tarjeta_no_encontrada' })
      const when = r.interval ? `en ${r.interval} día${r.interval === 1 ? '' : 's'}` : 'en diez minutos'
      return json(res, 200, { ok: true, ...r, detail: `Vuelve ${when}` })
    }
    case 'delete':
      return json(res, 200, { ok: deleteCard(b.id) })
    case 'stats': {
      const s = cardStats()
      return json(res, 200, { ok: true, ...s, detail: `${s.total} tarjetas, ${s.due} pendientes` })
    }
    default:
      return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'add|due|grade|stats|delete' })
  }
}

export async function handleHabit(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'status').toLowerCase()
  if (action === 'log') {
    const r = logHabit(b.habit, { note: b.note })
    if (!r) return json(res, 400, { ok: false, error: 'habit_requerido' })
    if (!r.already) appendHabitEntry(String(b.habit), b.note)
    return json(res, 200, {
      ok: true, ...r,
      detail: `${r.already ? 'Ya estaba registrado hoy' : 'Registrado'}; racha de ${r.streak} día${r.streak === 1 ? '' : 's'}`,
    })
  }
  if (action === 'status') {
    const habits = habitStatus()
    return json(res, 200, { ok: true, habits })
  }
  return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'log|status' })
}

export async function handleDayBrief(_req, res) {
  return json(res, 200, { ok: true, ...dayBrief() })
}

export async function handleMorningBriefing(req, res) {
  const b = (await body(req)) || {}
  return json(res, 200, { ok: true, ...(await maybeMorningBriefing({ force: b.force === true })) })
}

export async function handleTaskDone(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const r = await completeTask(b.text)
  const code = r.ok ? 200 : r.error === 'ambigua' ? 409 : 404
  return json(res, code, r)
}
