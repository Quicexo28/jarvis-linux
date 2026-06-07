/**
 * UI state handler — lets the frontend request window state transitions
 * (PIP ↔ AWAKE) and gesture toggle via HTTP, which the backend relays
 * to the connected renderer through the skill bus.
 *
 * POST /api/jarvis/ui-state   { state: 'pip'|'awake' }
 * POST /api/skills/gestures/toggle  { enabled: boolean }
 */

import { json, readBody } from '../lib/http.js'
import { requestClient, hasClient } from '../lib/skillBus.js'

const VALID_UI_STATES = new Set(['pip', 'awake'])

export async function handleUiState(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'bad_request' })
  }

  const state = String(body?.state ?? '').toLowerCase()
  if (!VALID_UI_STATES.has(state)) {
    return json(res, 400, { ok: false, error: 'invalid_state', valid: [...VALID_UI_STATES] })
  }

  if (!hasClient()) {
    return json(res, 503, { ok: false, error: 'renderer_not_connected' })
  }

  const verb = state === 'pip' ? 'boot_pip' : 'boot_awake'
  try {
    const result = await requestClient(verb, {})
    return json(res, 200, { ok: true, state, result })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'skill_bus_failed', detail: e.message })
  }
}

export async function handleGestureToggle(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'bad_request' })
  }

  const enabled = Boolean(body?.enabled)

  if (!hasClient()) {
    return json(res, 503, { ok: false, error: 'renderer_not_connected' })
  }

  try {
    const result = await requestClient('gesture_set', { enabled })
    return json(res, 200, { ok: true, enabled, result })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'skill_bus_failed', detail: e.message })
  }
}
