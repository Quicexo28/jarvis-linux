import { json, readBody } from '../lib/http.js'
import { agenda, calendarConfigured, spokenTime } from '../lib/calendar.js'
import { inbox, readMessage, mailConfigured } from '../lib/mail.js'

// Agenda y correo (solo lectura):
//   GET  /api/skills/calendar/agenda?days=1&from=ISO  → eventos de los .ics
//   POST /api/skills/mail/inbox  {unread, limit, query, sinceDays, from}
//   POST /api/skills/mail/read   {uid}

const CALENDAR_HOWTO = 'No hay calendario configurado. En Google Calendar: Configuración → tu calendario → «Dirección secreta en formato iCal»; pon esa URL en JARVIS_CALENDAR_ICS (secrets.local.json) y reinicia el backend.'
const MAIL_HOWTO = 'No hay correo configurado. Crea una contraseña de aplicación en tu cuenta de Google (requiere verificación en dos pasos) y pon JARVIS_IMAP_USER y JARVIS_IMAP_PASS en secrets.local.json; luego reinicia el backend.'

async function body(req) {
  try {
    return (await readBody(req)) || {}
  } catch {
    return null
  }
}

export async function handleCalendarAgenda(req, res) {
  if (!calendarConfigured()) {
    return json(res, 503, { ok: false, error: 'calendar_not_configured', detail: CALENDAR_HOWTO })
  }
  const url = new URL(req.url, 'http://x')
  const days = Number(url.searchParams.get('days')) || 1
  const from = url.searchParams.get('from') || undefined
  const r = await agenda({ from, days })
  if (!r.ok) return json(res, 502, { ok: false, error: 'calendar_unreachable', detail: r.errors.join('; ') })
  const detail = r.events.length
    ? r.events.slice(0, 8).map((e) => `${e.allDay ? 'todo el día' : spokenTime(e.start)} ${e.title}`).join('; ')
    : 'Sin eventos en ese intervalo.'
  return json(res, 200, { ...r, detail })
}

function mailError(res, e) {
  if (e?.code === 'mail_not_configured') return json(res, 503, { ok: false, error: 'mail_not_configured', detail: MAIL_HOWTO })
  if (e?.code === 'invalid_uid' || e?.code === 'not_found') return json(res, 404, { ok: false, error: e.code })
  // imapflow puts the server's answer in responseText ("Invalid credentials").
  const why = e?.responseText || e?.message || String(e)
  const auth = /auth|credential|login/i.test(why)
  return json(res, auth ? 401 : 502, { ok: false, error: auth ? 'mail_auth_failed' : 'mail_unreachable', detail: why.slice(0, 200) })
}

export async function handleMailInbox(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  if (!mailConfigured()) return json(res, 503, { ok: false, error: 'mail_not_configured', detail: MAIL_HOWTO })
  try {
    const r = await inbox({
      unread: b.unread !== false,
      limit: b.limit,
      query: b.query,
      sinceDays: b.sinceDays ?? b.since_days,
      from: b.from,
    })
    return json(res, 200, r)
  } catch (e) {
    return mailError(res, e)
  }
}

export async function handleMailRead(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  if (!mailConfigured()) return json(res, 503, { ok: false, error: 'mail_not_configured', detail: MAIL_HOWTO })
  try {
    return json(res, 200, await readMessage(b.uid))
  } catch (e) {
    return mailError(res, e)
  }
}
