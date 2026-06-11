/**
 * Push-to-talk endpoints. Pressed/released by global Hyprland binds (curl) or
 * any external trigger; the in-app key path sends body.ptt on process-speech
 * instead. Start clears VOICE_MUTED (an explicit key press overrides mute,
 * same as the wake word) and pushes ptt_set to the renderer so it opens the
 * mic even when continuous listening is off.
 */

import { json } from '../lib/http.js'
import { setPttActive, isPttActive } from '../lib/pttState.js'
import { markInteraction, setVoiceMuted } from '../lib/attentionState.js'
import { requestClient, hasClient } from '../lib/skillBus.js'

function pushToRenderer(active) {
  if (!hasClient()) return
  requestClient('ptt_set', { active }).catch(() => {})
}

export async function handlePttStart(_req, res) {
  setPttActive(true)
  setVoiceMuted(false)
  markInteraction()
  pushToRenderer(true)
  return json(res, 200, { ok: true, active: true })
}

export async function handlePttStop(_req, res) {
  setPttActive(false)
  pushToRenderer(false)
  return json(res, 200, { ok: true, active: false })
}

export async function handlePttStatus(_req, res) {
  return json(res, 200, { ok: true, active: isPttActive() })
}
