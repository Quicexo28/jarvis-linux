import { json, readBody } from '../lib/http.js'
import { addWatcher, listWatchers, cancelWatchers, runWatcherNow } from '../lib/watchers.js'

// /api/skills/watcher/* — scheduled read-only checks (lib/watchers.js).
// list is READ in toolRisk; create/cancel/run are write (owner/known only).

async function body(req) {
  try { return (await readBody(req)) || {} } catch { return {} }
}

const view = (w) => ({
  id: w.id, task: w.task, at: w.at, every_minutes: w.everyMinutes,
  last_status: w.lastStatus, last_result: w.lastResult,
})

/** POST { task, at?: "HH:MM", every_minutes?: number } */
export async function handleWatcherCreate(req, res) {
  const b = await body(req)
  const r = addWatcher({ task: b.task, at: b.at || null, everyMinutes: b.every_minutes ?? b.everyMinutes ?? null })
  if (!r.ok) return json(res, 400, r)
  return json(res, 200, { ok: true, watcher: view(r.watcher) })
}

export async function handleWatcherList(_req, res) {
  return json(res, 200, { ok: true, watchers: listWatchers().map(view) })
}

/** POST { id? , match? } — match is a piece of the task text. */
export async function handleWatcherCancel(req, res) {
  const b = await body(req)
  const n = cancelWatchers({ id: b.id || null, match: b.match || null })
  if (n < 0) return json(res, 409, { ok: false, error: 'ambigua', detail: `${-n} vigilantes coinciden; pide cuál (o usa list para ver los ids).` })
  if (!n) return json(res, 404, { ok: false, error: 'not_found', detail: 'No hay ningún vigilante así.' })
  return json(res, 200, { ok: true, cancelled: n })
}

/** POST { id } — run it now (to try a new watcher). Waits for the result. */
export async function handleWatcherRun(req, res) {
  const b = await body(req)
  const r = await runWatcherNow(String(b.id || ''))
  if (!r) return json(res, 404, { ok: false, error: 'not_found', detail: 'No hay ningún vigilante con ese id.' })
  return json(res, 200, { ok: true, ...r })
}
