/**
 * HTTP bridge for Jarvis MCP tools.
 *
 * The MCP server (backend/mcp-server/jarvis-mcp.js) runs as a child of the
 * Claude CLI process and cannot share state with the backend directly. Instead
 * each MCP tool calls one of the endpoints below, and we translate to a
 * skillBus verb (renderer state mutation) or to a backend service
 * (reminders.js, cloudStorage.js).
 */

import { json, readBody } from '../lib/http.js'
import { requestClient as skillBusRequest, hasClient as skillBusHasClient } from '../lib/skillBus.js'
import { addReminder, listReminders } from '../lib/reminders.js'
import { notifyJarvis, saveToCloud, listCloudFiles } from '../lib/cloudStorage.js'
import {
  writeTask,
  writeNote,
  listOpenTasks,
  searchNotes,
  updatePersonalization,
} from '../lib/obsidian.js'

// All timer/chrono endpoints route through the renderer skill bus, where the
// authoritative store lives. If no renderer is connected (DORMANT/LISTENING),
// we fail explicitly so Claude can apologize instead of silently dropping.
async function bridgeToBus(verb, payload, res) {
  if (!skillBusHasClient()) {
    return json(res, 503, { ok: false, error: 'renderer_not_connected', detail: 'La interfaz no está despierta.' })
  }
  try {
    const result = await skillBusRequest(verb, payload || {})
    return json(res, 200, { ok: true, result })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'skill_bus_failed', detail: e.message })
  }
}

async function withBody(req, handler, res) {
  try {
    const body = req.method === 'GET' ? {} : await readBody(req)
    return handler(body || {})
  } catch (e) {
    return json(res, 400, { ok: false, error: 'bad_request', detail: e.message })
  }
}

/* ----- TIMER ----- */

export async function handleTimerStart(req, res) {
  return withBody(req, async (body) => {
    const seconds = Number(body.seconds || 0)
    if (!Number.isFinite(seconds) || seconds < 1) {
      return json(res, 400, { ok: false, error: 'invalid_seconds' })
    }
    // Open the timer panel automatically, then create the timer.
    if (skillBusHasClient()) {
      try { await skillBusRequest('mode_open', { mode: 'timer' }) } catch {}
    }
    return bridgeToBus('timer_create', { durationMs: Math.round(seconds * 1000), label: body.label || undefined }, res)
  }, res)
}

export async function handleTimerPause(req, res) {
  return withBody(req, (body) => bridgeToBus('timer_pause', { label: body.label || undefined }, res), res)
}

export async function handleTimerResume(req, res) {
  return withBody(req, (body) => bridgeToBus('timer_resume', { label: body.label || undefined }, res), res)
}

export async function handleTimerAdd(req, res) {
  return withBody(req, (body) => {
    const seconds = Number(body.seconds || 0)
    if (!Number.isFinite(seconds) || seconds < 1) {
      return json(res, 400, { ok: false, error: 'invalid_seconds' })
    }
    return bridgeToBus('timer_add', { deltaMs: Math.round(seconds * 1000), label: body.label || undefined }, res)
  }, res)
}

export async function handleTimerCancel(req, res) {
  return withBody(req, (body) => {
    const payload = body.all ? { all: true } : { label: body.label || undefined }
    return bridgeToBus('timer_cancel', payload, res)
  }, res)
}

export async function handleTimerReset(req, res) {
  return withBody(req, (body) => bridgeToBus('timer_reset', { label: body.label || undefined }, res), res)
}

export async function handleTimerList(req, res) {
  return bridgeToBus('timer_list', {}, res)
}

/* ----- CHRONO ----- */

export async function handleChronoStart(req, res) {
  return withBody(req, async (body) => {
    if (skillBusHasClient()) {
      try { await skillBusRequest('mode_open', { mode: 'chrono' }) } catch {}
    }
    return bridgeToBus('chrono_start', { label: body.label || undefined }, res)
  }, res)
}

export async function handleChronoPause(req, res) {
  return withBody(req, (body) => bridgeToBus('chrono_pause', { label: body.label || undefined }, res), res)
}

export async function handleChronoResume(req, res) {
  // chrono store doesn't differentiate; start handles both paths.
  return withBody(req, (body) => bridgeToBus('chrono_start', { label: body.label || undefined }, res), res)
}

export async function handleChronoReset(req, res) {
  return withBody(req, (body) => bridgeToBus('chrono_reset', { label: body.label || undefined }, res), res)
}

export async function handleChronoLap(req, res) {
  return withBody(req, (body) => bridgeToBus('chrono_lap', { label: body.label || undefined }, res), res)
}

export async function handleChronoCancel(req, res) {
  return withBody(req, (body) => {
    const payload = body.all ? { all: true } : { label: body.label || undefined }
    return bridgeToBus('chrono_cancel', payload, res)
  }, res)
}

export async function handleChronoList(req, res) {
  return bridgeToBus('chrono_list', {}, res)
}

/* ----- REMINDER ----- */

export async function handleReminderCreate(req, res) {
  return withBody(req, async (body) => {
    const text = String(body.text || '').trim()
    const whenIso = String(body.when_iso || '').trim()
    if (!text || !whenIso) {
      return json(res, 400, { ok: false, error: 'missing_fields' })
    }
    const when = new Date(whenIso)
    if (isNaN(when.getTime())) {
      return json(res, 400, { ok: false, error: 'invalid_when_iso' })
    }
    const repeat = ['hourly','daily','weekly'].includes(body.repeat) ? body.repeat : null
    const entry = addReminder({ text, fireAt: when.toISOString(), repeat })
    return json(res, 200, { ok: true, result: { id: entry.id, fireAt: entry.fireAt, repeat: entry.repeat } })
  }, res)
}

export async function handleReminderList(req, res) {
  const items = listReminders().slice(0, 20).map((r) => ({ id: r.id, text: r.text, fireAt: r.fireAt, repeat: r.repeat }))
  return json(res, 200, { ok: true, result: { reminders: items } })
}

/* ----- NOTIFY ----- */

export async function handleNotifyNow(req, res) {
  return withBody(req, async (body) => {
    const text = String(body.text || '').trim()
    if (!text) return json(res, 400, { ok: false, error: 'missing_text' })
    const sent = await notifyJarvis(text).catch(() => false)
    return json(res, 200, { ok: true, result: { sent: !!sent } })
  }, res)
}

/* ----- VIEW / NAVIGATION ----- */

const VALID_VIEWS = ['home','house','plan2d','plan3d','space','cloud','system','mobile','utils','timer','chrono']
const VALID_OVERLAYS = ['terminal','gesture_debug','gesture_trainer','clap_trainer','speaker_config']

export async function handleViewOpen(req, res) {
  return withBody(req, (body) => {
    const view = String(body.view || '').toLowerCase()
    if (!VALID_VIEWS.includes(view)) {
      return json(res, 400, { ok: false, error: 'invalid_view', detail: `view must be one of ${VALID_VIEWS.join(', ')}` })
    }
    return bridgeToBus('view_open', { view }, res)
  }, res)
}

export async function handleViewClose(req, res) {
  return bridgeToBus('view_close', {}, res)
}

export async function handleViewCurrent(req, res) {
  return bridgeToBus('view_current', {}, res)
}

export async function handleRingRotate(req, res) {
  return withBody(req, (body) => {
    const direction = body.direction === 'left' ? 'left' : 'right'
    const steps = Math.max(1, Math.min(10, Number(body.steps || 1)))
    return bridgeToBus('ring_rotate', { direction, steps }, res)
  }, res)
}

export async function handleOverlayOpen(req, res) {
  return withBody(req, (body) => {
    const name = String(body.name || '').toLowerCase()
    if (!VALID_OVERLAYS.includes(name)) {
      return json(res, 400, { ok: false, error: 'invalid_overlay', detail: `name must be one of ${VALID_OVERLAYS.join(', ')}` })
    }
    return bridgeToBus('overlay_open', { name }, res)
  }, res)
}

export async function handleOverlayClose(req, res) {
  return withBody(req, (body) => {
    const name = String(body.name || '').toLowerCase()
    if (!VALID_OVERLAYS.includes(name)) {
      return json(res, 400, { ok: false, error: 'invalid_overlay' })
    }
    return bridgeToBus('overlay_close', { name }, res)
  }, res)
}

export async function handleSystemSleep(req, res) {
  return bridgeToBus('sleep_system', {}, res)
}

export async function handleVoiceToggle(req, res) {
  return withBody(req, (body) => {
    const payload = typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}
    return bridgeToBus('toggle_voice', payload, res)
  }, res)
}

export async function handleClapToggle(req, res) {
  return withBody(req, (body) => {
    const payload = typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}
    return bridgeToBus('toggle_clap_wake', payload, res)
  }, res)
}

/* ----- TIME ----- */

export async function handleTimeNow(req, res) {
  const now = new Date()
  const bogota = now.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'long' })
  // -05:00 offset for Colombia (no DST).
  const iso = now.toISOString()
  return json(res, 200, {
    ok: true,
    result: {
      iso_utc: iso,
      iso_bogota_offset: now.toISOString().replace('Z', '-05:00'),
      readable_bogota: bogota,
      timezone: 'America/Bogota',
      offset: '-05:00',
    },
  })
}

/* ----- OBSIDIAN ----- */

export async function handleObsidianTaskCreate(req, res) {
  return withBody(req, async (body) => {
    const text = String(body.text || '').trim()
    if (!text) return json(res, 400, { ok: false, error: 'missing_text' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const result = await writeTask(speakerName, { text, source: 'voice' })
      return json(res, 200, { ok: true, result })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

export async function handleObsidianNoteCreate(req, res) {
  return withBody(req, async (body) => {
    const text = String(body.body || '').trim()
    if (!text) return json(res, 400, { ok: false, error: 'missing_body' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const result = await writeNote(speakerName, { body: text })
      return json(res, 200, { ok: true, result })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

export async function handleObsidianTaskList(req, res) {
  const params = new URLSearchParams(req.url.split('?')[1] || '')
  const rawSpeaker = params.get('speaker')
  const speakerName = rawSpeaker ? decodeURIComponent(rawSpeaker) : null
  try {
    const tasks = await listOpenTasks(speakerName)
    return json(res, 200, { ok: true, result: { tasks } })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
  }
}

export async function handleObsidianNoteSearch(req, res) {
  return withBody(req, async (body) => {
    const query = String(body.query || '').trim()
    if (!query) return json(res, 400, { ok: false, error: 'missing_query' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const matches = await searchNotes(speakerName, query)
      return json(res, 200, { ok: true, result: { matches } })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

export async function handleObsidianPersonalize(req, res) {
  return withBody(req, async (body) => {
    const fact = String(body.fact || '').trim()
    if (!fact) return json(res, 400, { ok: false, error: 'missing_fact' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const result = await updatePersonalization(speakerName, { fact })
      return json(res, 200, { ok: true, result })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

/* ----- DISPLAY / PICKER ----- */

// Show a card on screen with content awkward to verbalize (path/url/formula/
// text/markdown/candidates). Body is forwarded as the DisplayCardData.
export async function handleDisplayShow(req, res) {
  return withBody(req, (body) => {
    if (!body || !body.kind) return json(res, 400, { ok: false, error: 'missing_kind' })
    return bridgeToBus('display_show', body, res)
  }, res)
}

export async function handleDisplayHide(req, res) {
  return withBody(req, () => bridgeToBus('display_hide', {}, res), res)
}

// Open a native OS picker so the owner points at a file/folder visually.
export async function handlePickFile(req, res) {
  return withBody(req, (body) => bridgeToBus('pick_file', {
    title: body.title || undefined,
    multiple: !!body.multiple,
    directory: !!body.directory,
  }, res), res)
}

/* ----- MODEL 3D ----- */

export async function handleModel3dShow(req, res) {
  return withBody(req, (body) => {
    const kind = body?.kind
    if (!['parametric', 'polytope', 'implicit'].includes(kind)) {
      return json(res, 400, { ok: false, error: 'invalid_kind', detail: 'kind must be parametric, polytope, or implicit' })
    }
    return bridgeToBus('model3d_show', body, res)
  }, res)
}

export async function handleModel3dHide(req, res) {
  return withBody(req, () => bridgeToBus('model3d_hide', {}, res), res)
}

/* ----- CLOUD ----- */

export async function handleCloudSave(req, res) {
  return withBody(req, async (body) => {
    const content = String(body.content || '').trim()
    if (!content) return json(res, 400, { ok: false, error: 'missing_content' })
    const filename = body.filename ? String(body.filename) : `jarvis-note-${Date.now()}.txt`
    const category = body.category ? String(body.category) : undefined
    try {
      const saved = saveToCloud(content, filename, category)
      notifyJarvis(`📁 Jarvis guardó un archivo en tu nube: ${saved.filename}`).catch(() => {})
      return json(res, 200, { ok: true, result: { filename: saved.filename, path: saved.path } })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'cloud_failed', detail: e.message })
    }
  }, res)
}

export async function handleCloudList(req, res) {
  const params = new URLSearchParams(req.url.split('?')[1] || '')
  const rawLimit = params.get('limit')
  const limit = rawLimit !== null
    ? Math.max(1, Math.min(50, parseInt(rawLimit, 10) || 12))
    : 12
  try {
    const files = listCloudFiles(null, limit)
    return json(res, 200, { ok: true, result: { files } })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'cloud_failed', detail: e.message })
  }
}
