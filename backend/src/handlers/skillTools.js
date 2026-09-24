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
import { broadcastWake } from '../lib/wakeSignal.js'
import { broadcastPttStart, broadcastPttStop } from '../lib/pttBus.js'
import { addReminder, listReminders } from '../lib/reminders.js'
import { getCurrentState, getDevices, summarizeDay } from '../lib/mobileContext.js'
import { notifyJarvis, saveToCloud, listCloudFiles } from '../lib/cloudStorage.js'
import { runCommand, gitCheckpoint, gitRollback, scheduleRestart } from '../lib/selfCode.js'
import { startDevJob, getDevJob, listDevJobs, getActiveJob, getDevJobLog, cancelDevJob } from '../lib/devAgent.js'
import { getSpeakerMode } from '../lib/speakerContext.js'
import { agentRpc } from './agents.js'
import { requireCodeAuth } from '../lib/codeAuth.js'
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
// Timestamp of the last UI action pushed to the renderer (display cards, views,
// 3D, ring...). speech.js compares it against the turn start to catch replies
// that claim "queda en pantalla" when no UI verb actually ran.
let lastUiActionAt = 0
export function getLastUiActionAt() { return lastUiActionAt }

async function bridgeToBus(verb, payload, res) {
  // Diagnostic (#T1): one line per tool→renderer verb so a single voice repro
  // reveals whether Claude actually CALLED the tool (verb reaches here) and
  // whether a renderer was connected to receive it. Pin "el visor no responde"
  // to haiku-skipped-the-tool vs renderer-not-connected vs skill-bus-timeout.
  if (!skillBusHasClient()) {
    console.warn(`[tool] ${verb} -> renderer_not_connected (interfaz no despierta)`)
    return json(res, 503, { ok: false, error: 'renderer_not_connected', detail: 'La interfaz no está despierta.' })
  }
  const t0 = Date.now()
  try {
    const result = await skillBusRequest(verb, payload || {})
    lastUiActionAt = Date.now()
    console.log(`[tool] ${verb} -> ok (${Date.now() - t0}ms)`)
    return json(res, 200, { ok: true, result })
  } catch (e) {
    console.warn(`[tool] ${verb} -> skill_bus_failed after ${Date.now() - t0}ms: ${e.message}`)
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

/* ----- MOBILE CONTEXT (rutina del usuario) ----- */

export function handleMobileWhere(_req, res) {
  const c = getCurrentState()
  const loc = c.location
  const result = {
    place: loc?.place ?? null,
    coords: loc ? { lat: loc.lat, lon: loc.lon } : null,
    updatedAt: loc?.ts ?? null,
    battery: c.battery ? { level: c.battery.level, charging: c.battery.charging } : null,
    focus: c.focus?.mode ?? null,
    sleep: c.sleep?.state ?? null,
  }
  // Per-device battery/place (iphone, tablet, ...) when any device has reported.
  const devices = getDevices()
  if (Object.keys(devices).length) {
    result.devices = Object.fromEntries(
      Object.entries(devices).map(([name, d]) => [name, {
        battery: d.battery ? { level: d.battery.level, charging: d.battery.charging } : null,
        place: d.location?.place ?? null,
        updatedAt: d.battery?.ts ?? d.location?.ts ?? null,
      }])
    )
  }
  return json(res, 200, { ok: true, result })
}

export function handleMobileRoutine(req, res) {
  let date = null
  try { date = new URL(req.url, 'http://localhost').searchParams.get('date') } catch {}
  return json(res, 200, { ok: true, result: { summary: summarizeDay(date || undefined) } })
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

const VALID_VIEWS = ['home','house','plan2d','plan3d','space','cloud','system','mobile','utils','timer','chrono','vault']
const VALID_OVERLAYS = ['terminal','gesture_debug','clap_trainer','speaker_config']

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

export async function handleSystemWake(_req, res) {
  broadcastWake()
  return json(res, 200, { ok: true })
}

export async function handleVoiceToggle(req, res) {
  return withBody(req, (body) => {
    const payload = typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}
    return bridgeToBus('toggle_voice', payload, res)
  }, res)
}

export async function handlePttStart(_req, res) {
  broadcastPttStart()
  return json(res, 200, { ok: true })
}

export async function handlePttStop(_req, res) {
  broadcastPttStop()
  return json(res, 200, { ok: true })
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
      const result = await writeNote(speakerName, {
        body: text,
        title: body.title ? String(body.title) : undefined,
        area: body.area ? String(body.area) : undefined,
        project: body.project ? String(body.project) : undefined,
        series: body.series ? String(body.series) : undefined,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        aliases: Array.isArray(body.aliases) ? body.aliases : undefined,
      })
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

/* ----- VAULT GRAPH ----- */

// El GRAFO se sirve desde handlers/knowledge.js (solo lee disco + SQLite); esto
// es lo único que necesita al renderer, y por eso vive aquí: `bridgeToBus` es
// privado de este módulo. Enfoca un nodo del visor 3D del modo `vault`.
export async function handleVaultFocus(req, res) {
  return withBody(req, (body) => {
    const node = String(body.node || '').trim()
    if (!node) return json(res, 400, { ok: false, error: 'missing_node' })
    return bridgeToBus('vault_focus', { node }, res)
  }, res)
}

/* ----- DISPLAY / PICKER ----- */

// Timestamp of the last successful display_show request. speech.js reads it to
// detect turns where the model CLAIMED "queda en pantalla" without actually
// calling show_display (hallucinated compliance) and fires a corrective turn.
let lastDisplayShowAt = 0
export function getLastDisplayShowAt() { return lastDisplayShowAt }

// Show a card on screen with content awkward to verbalize (path/url/formula/
// text/markdown/candidates). Body is forwarded as the DisplayCardData.
export async function handleDisplayShow(req, res) {
  return withBody(req, (body) => {
    if (!body || !body.kind) return json(res, 400, { ok: false, error: 'missing_kind' })
    lastDisplayShowAt = Date.now()
    console.log(`[display] show kind=${body.kind} title=${String(body.title ?? '').slice(0, 60)}`)
    return bridgeToBus('display_show', body, res)
  }, res)
}

/**
 * POST /api/skills/speech/say { text }
 *
 * Backend-initiated speech. Until this existed the backend could only WRITE to
 * the screen: proactive notices and the verifier's corrections had no voice.
 * Goes through the renderer's own speak() (see frontend skills/speakBridge.ts),
 * so it inherits the abort + echo-gate handling a normal reply gets — a second
 * audio path would make Jarvis hear itself and answer.
 */
export async function handleSpeechSay(req, res) {
  return withBody(req, (body) => {
    const text = String(body?.text ?? '').trim()
    if (!text) return json(res, 400, { ok: false, error: 'missing_text' })
    if (text.length > 600) return json(res, 400, { ok: false, error: 'text_too_long' })
    console.log(`[speak] "${text.slice(0, 60)}"`)
    return bridgeToBus('speak_text', { text }, res)
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

const VALID_3D_KINDS = ['parametric', 'polytope', 'implicit', 'primitive', 'curve', 'graph', 'vectors', 'plane', 'line', 'polygon', 'simulation']
const VALID_SIM_SYSTEMS = ['nbody', 'blackhole', 'dynamics', 'field', 'ode']
const KIND_DETAIL = `each spec.kind must be one of: ${VALID_3D_KINDS.join(', ')}`

// Accepts a single spec ({kind:...}) or a multi-object scene ({objects:[...]} /
// legacy {specs:[...]}). Kind validation only — geometry params are validated
// leniently by the renderer, which degrades gracefully on bad math.
export function validateModel3dBody(body, res, verb) {
  const list = Array.isArray(body?.objects) ? body.objects
    : Array.isArray(body?.specs) ? body.specs
    : [body]
  if (!list.length) return json(res, 400, { ok: false, error: 'empty_objects' })
  const invalid = list.find((s) => !VALID_3D_KINDS.includes(s?.kind))
  if (invalid) return json(res, 400, { ok: false, error: 'invalid_kind', detail: KIND_DETAIL })
  // Un politopo tiene 2^n vertices y el constructor del renderer LANZA fuera de
  // 2-7. Dejar pasar un `dimension: 20` (el modelo lo pide de vez en cuando)
  // reventaba el arbol de React del visor, o sea ventana EN BLANCO. Se corta
  // aqui para que el modelo reciba un error util y reintente con algo dibujable.
  const badDim = list.find((s) => s?.kind === 'polytope'
    && !(Number.isInteger(s?.dimension) && s.dimension >= 2 && s.dimension <= 7))
  if (badDim) {
    return json(res, 400, {
      ok: false, error: 'invalid_dimension',
      detail: 'polytope.dimension must be an integer 2-7 (4 = teseracto)',
    })
  }
  // Un poligono se dibuja a partir de una lista EXPLICITA de vertices, asi que
  // aqui si hay algo que validar: sin ternas numericas la geometria sale NaN y
  // el renderer pinta una figura invisible sin ningun error visible.
  const badPoly = list.find((s) => s?.kind === 'polygon' && (
    !Array.isArray(s?.vertices) || s.vertices.length < 2 || s.vertices.length > 512
    || s.vertices.some((v) => !Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isFinite(n)))
  ))
  if (badPoly) {
    return json(res, 400, {
      ok: false, error: 'invalid_vertices',
      detail: 'polygon.vertices must be 2-512 arrays of three finite numbers [x, y, z] (math coords, z up)',
    })
  }
  // A simulation is discriminated twice (kind + system); catching a bad system
  // here gives the model a usable error instead of a silently empty scene.
  const badSystem = list.find((s) => s?.kind === 'simulation' && !VALID_SIM_SYSTEMS.includes(s?.system))
  if (badSystem) {
    return json(res, 400, {
      ok: false, error: 'invalid_system',
      detail: `simulation.system must be one of: ${VALID_SIM_SYSTEMS.join(', ')}`,
    })
  }
  return bridgeToBus(verb, body, res)
}

export async function handleModel3dShow(req, res) {
  return withBody(req, (body) => validateModel3dBody(body, res, 'model3d_show'), res)
}

export async function handleModel3dAdd(req, res) {
  return withBody(req, (body) => validateModel3dBody(body, res, 'model3d_add'), res)
}

export async function handleModel3dHide(req, res) {
  return withBody(req, () => bridgeToBus('model3d_hide', {}, res), res)
}

// Transport for a running simulation. Deliberately NOT part of show/add: those
// rebuild the scene, which would restart the physics instead of pausing it.
const SIM_ACTIONS = ['play', 'pause', 'toggle', 'reset', 'speed']

export async function handleModel3dSim(req, res) {
  return withBody(req, (body) => {
    const action = body?.action || 'toggle'
    if (!SIM_ACTIONS.includes(action)) {
      return json(res, 400, { ok: false, error: 'invalid_action', detail: `action must be one of: ${SIM_ACTIONS.join(', ')}` })
    }
    if (action === 'speed' && !(Number(body?.speed) > 0)) {
      return json(res, 400, { ok: false, error: 'invalid_speed', detail: 'speed must be a positive number' })
    }
    return bridgeToBus('model3d_sim', { action, speed: Number(body?.speed) || undefined }, res)
  }, res)
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

/* ----- RGB (PC remoto vía agente) ----- */

// El PC Windows ya tiene un CLI probado (rgb_ctl.py: OpenRGB para RAM/placa/
// fans/AIO + HID directo para el teclado). Aquí sólo armamos la línea de
// comandos y la despachamos como op `exec` por el hub. Los presets (color +
// targets + efectos) viven en presets.json de esa máquina: el hub no conoce su
// contenido, sólo pasa el nombre.
//
// Cada respuesta entra en el contexto del LLM, así que devolvemos siempre un
// string CORTO: "OK" o sólo la primera línea del error (que incluye la lista de
// presets cuando el nombre no existe, para que pueda reintentar).
const RGB_MACHINE = process.env.JARVIS_RGB_MACHINE || 'main'
const RGB_SCRIPT = process.env.JARVIS_RGB_SCRIPT || 'C:\\Users\\santi\\jarvis-rgb\\rgb_ctl.py'
// Ruta ABSOLUTA al intérprete: el agente corre como servicio SYSTEM, donde el
// launcher `py` responde "No installed Python found!" y el python.exe de
// WindowsApps es sólo el stub de la Store.
const RGB_PYTHON = process.env.JARVIS_RGB_PYTHON
  || 'C:\\Users\\santi\\AppData\\Local\\Programs\\Python\\Python311\\python.exe'
const RGB_TIMEOUT_MS = 25_000
// Shared with rgb_ctl.py's _state_path(): the public folder is the only one
// both the user's GUI and the SYSTEM-side agent can write.
const RGB_STATE_FILE = process.env.JARVIS_RGB_STATE || 'C:\\Users\\Public\\JarvisRGB\\state.json'
const RGB_TARGETS = ['all', 'pc', 'keyboard']

function shortError(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

async function rgbExec(args, res) {
  let data
  try {
    data = await agentRpc(RGB_MACHINE, {
      op: 'exec',
      params: { command: RGB_PYTHON, args: [RGB_SCRIPT, ...args], cwd: null, timeout_ms: RGB_TIMEOUT_MS, stream: false },
    })
  } catch (e) {
    return json(res, 502, { ok: false, error: `hub: ${e.message}` })
  }
  if (data?.ok === false) return json(res, 502, { ok: false, error: data.error || 'rpc_failed' })
  const r = data?.result || {}
  if (r.status === 'error') return json(res, 502, { ok: false, error: shortError(r.message) || 'agent_error' })
  if (r.timed_out) return json(res, 504, { ok: false, error: 'timeout' })
  if (r.exit_code !== 0) {
    return json(res, 500, { ok: false, error: shortError(r.stderr) || shortError(r.stdout) || `exit ${r.exit_code}` })
  }
  // Un preset inexistente sale con exit 0 y el aviso en stdout ("Preset 'x' no
  // existe (disponibles: ...)"), así que el código de salida no alcanza.
  if (/no existe/i.test(r.stdout || '')) {
    return json(res, 404, { ok: false, error: shortError(r.stdout) })
  }
  return json(res, 200, { ok: true, result: 'OK' })
}

export async function handleRgbSet(req, res) {
  return withBody(req, (body) => {
    const color = String(body.color || '').trim()
    // Nombre (red, gold...) o hex #RRGGBB — nada más llega al argv del script.
    if (!/^#?[A-Za-z0-9]{1,16}$/.test(color)) {
      return json(res, 400, { ok: false, error: 'color inválido' })
    }
    const target = String(body.target || 'all').toLowerCase()
    if (!RGB_TARGETS.includes(target)) {
      return json(res, 400, { ok: false, error: `target debe ser ${RGB_TARGETS.join('|')}` })
    }
    const args = [color, '--target', target]
    // Jarvis RGB has two brightness paths, like its desktop GUI: the keyboard
    // takes a hardware level 1-5 (this arg), and the PC side follows the colour
    // itself, so callers dim that by sending a darker one. Omitted = script default.
    if (body.brightness != null) {
      const br = Number(body.brightness)
      if (!Number.isInteger(br) || br < 1 || br > 5) {
        return json(res, 400, { ok: false, error: 'brightness debe ser 1-5' })
      }
      args.push('--brightness', String(br))
    }
    return rgbExec(args, res)
  }, res)
}

/**
 * GET /api/skills/rgb/presets — names only, for the app's preset chips.
 * `--list-presets` prints one per line (or "(sin presets)" when presets.json
 * does not exist yet), so an empty list is a normal answer, not an error.
 */
export async function handleRgbPresets(_req, res) {
  let data
  try {
    data = await agentRpc(RGB_MACHINE, {
      op: 'exec',
      params: { command: RGB_PYTHON, args: [RGB_SCRIPT, '--list-presets'], cwd: null, timeout_ms: RGB_TIMEOUT_MS, stream: false },
    })
  } catch (e) {
    return json(res, 502, { ok: false, error: `hub: ${e.message}` })
  }
  const r = data?.result || {}
  if (data?.ok === false || r.status === 'error') {
    return json(res, 502, { ok: false, error: shortError(r.message) || data?.error || 'rpc_failed' })
  }
  const presets = String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('('))
  return json(res, 200, { ok: true, presets })
}

/**
 * GET /api/skills/rgb/state — the colour Jarvis RGB last applied, whoever
 * applied it. Both sides (the Windows GUI and this backend) write the same
 * file, so the app's wheel can mirror a change made on the PC and vice versa.
 * Lives in the public folder because the GUI runs as the user and the agent as
 * SYSTEM — two different %APPDATA%.
 */
export async function handleRgbState(_req, res) {
  let data
  try {
    data = await agentRpc(RGB_MACHINE, {
      op: 'read_file',
      params: { path: { raw: RGB_STATE_FILE, os: 'Windows' }, offset: 0, length: 8192 },
    })
  } catch (e) {
    return json(res, 502, { ok: false, error: `hub: ${e.message}` })
  }
  const r = data?.result || {}
  // No file yet = nobody has applied a colour since the update; not an error.
  if (data?.ok === false || r.status === 'error') return json(res, 200, { ok: true, state: null })
  try {
    const state = JSON.parse(Buffer.from(r.data_base64 ?? '', 'base64').toString('utf8'))
    return json(res, 200, { ok: true, state })
  } catch {
    return json(res, 200, { ok: true, state: null })
  }
}

export async function handleRgbPreset(req, res) {
  return withBody(req, (body) => {
    const name = String(body.name || '').trim()
    if (!name || name.length > 40 || /[\r\n]/.test(name)) {
      return json(res, 400, { ok: false, error: 'nombre de preset inválido' })
    }
    return rgbExec(['--preset', name], res)
  }, res)
}

/* ----- SELF-CODE (autodesarrollo: ejecutar / versionar / reiniciar) ----- */

function ownerOnly(res) {
  if (getSpeakerMode() === 'OWNER') return false
  json(res, 403, { ok: false, error: 'owner_only', spoken: 'Solo el señor puede ordenarme cambios en mi propio código.' })
  return true
}

export async function handleRunCommand(req, res) {
  if (ownerOnly(res)) return
  if (await requireCodeAuth(res, 'Jarvis quiere ejecutar un comando en su propio código.')) return
  return withBody(req, async (body) => {
    const result = await runCommand({
      command: body.command,
      cwd: body.cwd || undefined,
      timeoutMs: body.timeoutMs || undefined,
    })
    return json(res, 200, result)
  }, res)
}

export async function handleCodeCheckpoint(req, res) {
  if (ownerOnly(res)) return
  if (await requireCodeAuth(res, 'Jarvis quiere crear un punto de control en su código.')) return
  return withBody(req, async (body) => {
    const result = await gitCheckpoint({ message: body.message || undefined })
    return json(res, result.ok ? 200 : 500, result)
  }, res)
}

export async function handleCodeRollback(req, res) {
  if (ownerOnly(res)) return
  if (await requireCodeAuth(res, 'Jarvis quiere revertir su código a un punto de control.')) return
  return withBody(req, async (body) => {
    const result = await gitRollback({ sha: body.sha || undefined })
    return json(res, result.ok ? 200 : 500, result)
  }, res)
}

export async function handleRestartBackend(req, res) {
  if (ownerOnly(res)) return
  if (await requireCodeAuth(res, 'Jarvis quiere reiniciarse para aplicar cambios.')) return
  return withBody(req, () => {
    json(res, 200, { ok: true, spoken: 'Reiniciándome para aplicar los cambios, señor.', restarting: true })
    scheduleRestart()
    return undefined
  }, res)
}

/* ----- SELF-CODE: tarea delegada a un agente Claude Code completo ----- */

export async function handleCodeTask(req, res) {
  if (ownerOnly(res)) return
  if (await requireCodeAuth(res, 'Jarvis quiere modificar su propio código.')) return
  return withBody(req, async (body) => {
    const result = await startDevJob({
      instruction: body.instruction || body.task || '',
      model: body.model || undefined,
      requestedBy: body.requestedBy || 'mcp',
    })
    return json(res, result.ok ? 200 : 409, result)
  }, res)
}

// Status is POST (not GET) so the MCP bridge can send { id } as a JSON body.
export async function handleCodeTaskStatus(req, res) {
  if (ownerOnly(res)) return
  return withBody(req, (body) => {
    const id = String(body.id || '').trim()
    if (id) {
      const rec = getDevJob(id)
      if (!rec) return json(res, 404, { ok: false, error: 'unknown_job' })
      return json(res, 200, { ok: true, job: rec, log: body.log ? getDevJobLog(id) : undefined })
    }
    const activeJob = getActiveJob()
    return json(res, 200, {
      ok: true,
      active: activeJob,
      recent: listDevJobs(Number(body.limit) || 5),
    })
  }, res)
}

export async function handleCodeTaskCancel(req, res) {
  if (ownerOnly(res)) return
  if (await requireCodeAuth(res, 'Jarvis quiere cancelar el cambio de código en curso.')) return
  return withBody(req, () => {
    const result = cancelDevJob()
    return json(res, result.ok ? 200 : 404, result)
  }, res)
}
