import { json, readBody } from '../lib/http.js'
import { runDiagnosis, listIncidents, getIncident, attemptCodeFix, dismissIncident, summarize } from '../lib/selfHeal.js'
import { getSpeakerMode } from '../lib/speakerContext.js'
import { requireCodeAuth } from '../lib/codeAuth.js'

// Autodiagnóstico:
//   GET  /api/jarvis/health/incidents   → historial completo (?open=1 solo abiertos)
//   POST /api/skills/health/diagnose    → sondeo ahora + incidentes abiertos (lectura)
//   POST /api/skills/code/heal          → {id, action: fix|dismiss} — fix lanza el
//        agente de autodesarrollo sobre el incidente; vive bajo code/ para heredar
//        local-only (webAuth) y destructive (toolRisk).

async function body(req) {
  try {
    return (await readBody(req)) || {}
  } catch {
    return null
  }
}

export async function handleIncidentList(req, res) {
  const url = new URL(req.url, 'http://x')
  const open = url.searchParams.get('open') === '1'
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)
  return json(res, 200, { ok: true, incidents: listIncidents({ open, limit }) })
}

export async function handleDiagnose(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const r = await runDiagnosis({ cli: !!b.cli })
  const n = r.open.length
  return json(res, 200, {
    ...r,
    detail: n
      ? `${n} incidente(s) abierto(s): ${r.open.map((i) => `#${i.id} ${i.code} ${i.title}`).join('; ')}`
      : 'Todo en orden: servicios activos, transcripción respondiendo, sin incidentes abiertos.',
  })
}

export async function handleHeal(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const id = Number(b.id)
  if (!id || !getIncident(id)) return json(res, 404, { ok: false, error: 'unknown_incident' })
  const action = String(b.action || 'fix').toLowerCase()

  if (action === 'dismiss') {
    const inc = dismissIncident(id)
    return json(res, 200, { ok: true, incident: summarize(inc), detail: `Incidente ${id} descartado.` })
  }
  if (action !== 'fix') return json(res, 400, { ok: false, error: 'invalid_action' })

  // Same bar as code_task: the owner, and code authorization.
  if (getSpeakerMode() !== 'OWNER') {
    return json(res, 403, { ok: false, error: 'owner_only', spoken: 'Solo el señor puede ordenarme cambios en mi propio código.' })
  }
  if (await requireCodeAuth(res, 'Jarvis quiere arreglar su propio código por un incidente.')) return
  const r = await attemptCodeFix(id, { manual: true })
  if (!r.ok) {
    return json(res, 409, { ok: false, error: r.error, detail: `No pude lanzar el arreglo: ${r.error}` })
  }
  return json(res, 200, {
    ok: true, jobId: r.jobId, incident: summarize(r.incident),
    detail: 'Agente de autodesarrollo lanzado sobre el incidente; avisará al terminar.',
  })
}
