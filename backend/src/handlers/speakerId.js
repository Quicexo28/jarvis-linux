/**
 * Speaker ID management endpoints (multi-speaker).
 *
 * Supports multiple registered speakers, each with their own subdirectory
 * under the speaker samples root. Proxies management commands to the
 * Python STT service which handles the actual embedding computation.
 */

import { readdir, stat, unlink, writeFile, mkdir, rm, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join, extname } from 'path'
import { json, readBody } from '../lib/http.js'

const VOICE_BASE = join(import.meta.dirname, '..', '..', 'voice', 'samples')
const SPEAKER_DIR = globalThis.process?.env?.SPEAKER_SAMPLES_DIR || join(VOICE_BASE, 'speaker')
const STT_URL = globalThis.process?.env?.STT_URL || 'http://127.0.0.1:8790'

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm'])

// Sanitize a speaker name to a safe directory name. Returns '' when invalid —
// callers must reject empty names (there is no "default" fallback).
function safeName(name) {
  return (name || '').replace(/[^a-zA-Z0-9\-_ ]/g, '').trim()
}

async function ensureSpeakerDir(speaker) {
  const safe = safeName(speaker)
  const dir = safe ? join(SPEAKER_DIR, safe) : SPEAKER_DIR
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  return dir
}

// Best-effort: tell the STT service to recompute one speaker's embeddings.
async function notifyReloadSpeaker(speaker) {
  try {
    await fetch(`${STT_URL}/speaker-id/speakers/${encodeURIComponent(speaker)}/reload`, {
      method: 'POST',
    })
  } catch {}
}

/**
 * GET /api/speaker-id/samples?speaker=<name>
 */
export async function handleSpeakerIdList(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const speaker = url.searchParams.get('speaker')

  if (speaker) {
    // Read-only: never create the dir here — a stale UI selection polling a
    // deleted profile would otherwise resurrect it as an empty ghost.
    const safe = safeName(speaker)
    const dir = safe ? join(SPEAKER_DIR, safe) : SPEAKER_DIR
    if (!existsSync(dir)) {
      return json(res, 200, { ok: true, samples: [], speaker: safe, directory: dir })
    }
    const files = await readdir(dir)
    const samples = []
    for (const f of files) {
      const ext = extname(f).toLowerCase()
      if (!AUDIO_EXTS.has(ext) || f.startsWith('_')) continue
      const info = await stat(join(dir, f))
      samples.push({ filename: f, size: info.size, createdAt: info.birthtime.toISOString() })
    }
    return json(res, 200, { ok: true, samples, speaker: safeName(speaker), directory: dir })
  }

  await ensureSpeakerDir()
  const entries = await readdir(SPEAKER_DIR, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const dir = join(SPEAKER_DIR, entry.name)
    const files = await readdir(dir)
    const samples = []
    for (const f of files) {
      const ext = extname(f).toLowerCase()
      if (!AUDIO_EXTS.has(ext) || f.startsWith('_')) continue
      const info = await stat(join(dir, f))
      samples.push({ filename: f, size: info.size, createdAt: info.birthtime.toISOString() })
    }
    result.push({ speaker: entry.name, samples })
  }
  return json(res, 200, { ok: true, speakers: result, directory: SPEAKER_DIR })
}

/**
 * POST /api/speaker-id/samples?speaker=<name>
 */
export async function handleSpeakerIdUpload(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const speaker = safeName(url.searchParams.get('speaker'))
  if (!speaker) return json(res, 400, { ok: false, error: 'missing_speaker' })
  const dir = await ensureSpeakerDir(speaker)

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)

  if (!body.length) return json(res, 400, { ok: false, error: 'empty_body' })

  const contentType = req.headers['content-type'] || ''
  let ext = '.wav'
  if (contentType.includes('ogg')) ext = '.ogg'
  else if (contentType.includes('mp3') || contentType.includes('mpeg')) ext = '.mp3'

  const timestamp = Date.now()
  const filename = `speaker-${timestamp}${ext}`
  const filepath = join(dir, filename)

  await writeFile(filepath, body)

  return json(res, 201, { ok: true, filename, size: body.length, speaker: safeName(speaker) })
}

/**
 * DELETE /api/speaker-id/samples?file=<filename>&speaker=<name>
 */
export async function handleSpeakerIdDelete(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const filename = url.searchParams.get('file')
  const speaker = safeName(url.searchParams.get('speaker'))

  if (!speaker) return json(res, 400, { ok: false, error: 'missing_speaker' })
  if (!filename) return json(res, 400, { ok: false, error: 'missing_file_param' })

  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return json(res, 400, { ok: false, error: 'invalid_filename' })
  }

  const filepath = join(SPEAKER_DIR, speaker, filename)
  if (!existsSync(filepath)) {
    return json(res, 404, { ok: false, error: 'file_not_found' })
  }

  await unlink(filepath)
  // Recompute the speaker's embeddings so the deleted sample stops influencing
  // matching (otherwise the stale embedding makes it effectively "reappear").
  await notifyReloadSpeaker(speaker)
  return json(res, 200, { ok: true, deleted: filename, speaker })
}

/**
 * POST /api/speaker-id/reset?speaker=<name>
 *
 * From-scratch re-enrollment of a VISIBLE profile: wipe its WAV samples and
 * reload. The encrypted owner voiceprint (owner_voiceprint.enc) is NOT touched:
 * it is a hidden system identity managed via scripts/create-voiceprint.sh, and
 * deleting it from the UI twice killed recognition for hours. Regenerate or
 * remove it deliberately, never as a side effect of a profile reset.
 */
export async function handleSpeakerIdReset(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const speaker = safeName(url.searchParams.get('speaker'))
  if (!speaker) return json(res, 400, { ok: false, error: 'missing_speaker' })

  // 1. Wipe all audio samples in the speaker dir (keep the dir + _config.json).
  let removed = 0
  const dir = join(SPEAKER_DIR, speaker)
  if (existsSync(dir)) {
    for (const f of await readdir(dir)) {
      if (f.startsWith('_')) continue
      if (!AUDIO_EXTS.has(extname(f).toLowerCase())) continue
      try { await unlink(join(dir, f)); removed++ } catch {}
    }
  }
  await ensureSpeakerDir(speaker)

  // 2. Full reload so the in-memory speaker set drops the old embeddings.
  let reload = null
  try {
    const upstream = await fetch(`${STT_URL}/speaker-id/reload`, { method: 'POST' })
    reload = await upstream.json().catch(() => null)
  } catch {}

  return json(res, 200, { ok: true, speaker, samplesRemoved: removed, seedRemoved: false, reload })
}

/**
 * POST /api/speaker-id/reload
 */
export async function handleSpeakerIdReload(_req, res) {
  try {
    const upstream = await fetch(`${STT_URL}/speaker-id/reload`, { method: 'POST' })
    if (!upstream.ok) {
      return json(res, 502, { ok: false, error: 'stt_reload_failed', status: upstream.status })
    }
    const data = await upstream.json()
    return json(res, 200, { ok: true, ...data })
  } catch (err) {
    return json(res, 502, { ok: false, error: 'stt_unreachable', detail: err.message })
  }
}

/**
 * GET /api/speaker-id/status
 */
export async function handleSpeakerIdStatus(_req, res) {
  try {
    const upstream = await fetch(`${STT_URL}/speaker-id/status`)
    if (!upstream.ok) {
      return json(res, 502, { ok: false, error: 'stt_status_failed' })
    }
    const data = await upstream.json()
    return json(res, 200, { ok: true, ...data })
  } catch (err) {
    return json(res, 502, { ok: false, error: 'stt_unreachable', detail: err.message })
  }
}

/**
 * PUT /api/speaker-id/threshold
 */
export async function handleSpeakerIdThreshold(req, res) {
  try {
    const body = await readBody(req)
    const name = safeName(body.name)
    const threshold = Number(body.threshold)
    if (!name) {
      return json(res, 400, { ok: false, error: 'missing_speaker' })
    }
    // ECAPA cosine scores run lower than resemblyzer's — floor matches Python.
    if (isNaN(threshold) || threshold < 0.30 || threshold > 0.95) {
      return json(res, 400, { ok: false, error: 'threshold must be 0.30-0.95' })
    }

    const upstream = await fetch(`${STT_URL}/speaker-id/threshold`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, threshold }),
    })
    if (!upstream.ok) {
      return json(res, 502, { ok: false, error: 'stt_threshold_failed' })
    }
    const data = await upstream.json()
    return json(res, 200, { ok: true, ...data })
  } catch (err) {
    return json(res, 502, { ok: false, error: 'stt_unreachable', detail: err.message })
  }
}

// --- Rejected samples (_rejected/ quarantine from the consistency filter) ---

function rejectedDir(speaker) {
  return join(SPEAKER_DIR, speaker, '_rejected')
}

function validFilename(filename) {
  return filename && !filename.includes('/') && !filename.includes('\\') && !filename.includes('..')
}

/**
 * GET /api/speaker-id/rejected?speaker=<name>
 * Lists quarantined samples (echo/noise refs excluded by the consistency filter).
 */
export async function handleRejectedList(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const speaker = safeName(url.searchParams.get('speaker'))
  if (!speaker) return json(res, 400, { ok: false, error: 'missing_speaker' })

  const dir = rejectedDir(speaker)
  const samples = []
  if (existsSync(dir)) {
    for (const f of await readdir(dir)) {
      const ext = extname(f).toLowerCase()
      if (!AUDIO_EXTS.has(ext)) continue
      const info = await stat(join(dir, f))
      samples.push({ filename: f, size: info.size, createdAt: info.birthtime.toISOString() })
    }
  }
  return json(res, 200, { ok: true, speaker, samples })
}

/**
 * POST /api/speaker-id/rejected/restore?speaker=<name>&file=<filename>
 * Moves a quarantined sample back into the active set and reloads the speaker.
 * The consistency filter may re-reject it at load if it's still inconsistent.
 */
export async function handleRejectedRestore(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const speaker = safeName(url.searchParams.get('speaker'))
  const filename = url.searchParams.get('file')
  if (!speaker) return json(res, 400, { ok: false, error: 'missing_speaker' })
  if (!validFilename(filename)) return json(res, 400, { ok: false, error: 'invalid_filename' })

  const src = join(rejectedDir(speaker), filename)
  if (!existsSync(src)) return json(res, 404, { ok: false, error: 'file_not_found' })

  await rename(src, join(SPEAKER_DIR, speaker, filename))
  await notifyReloadSpeaker(speaker)
  return json(res, 200, { ok: true, restored: filename, speaker })
}

/**
 * DELETE /api/speaker-id/rejected?speaker=<name>&file=<filename>
 */
export async function handleRejectedDelete(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const speaker = safeName(url.searchParams.get('speaker'))
  const filename = url.searchParams.get('file')
  if (!speaker) return json(res, 400, { ok: false, error: 'missing_speaker' })
  if (!validFilename(filename)) return json(res, 400, { ok: false, error: 'invalid_filename' })

  const filepath = join(rejectedDir(speaker), filename)
  if (!existsSync(filepath)) return json(res, 404, { ok: false, error: 'file_not_found' })

  await unlink(filepath)
  return json(res, 200, { ok: true, deleted: filename, speaker })
}

/**
 * POST /api/speaker-id/wake/reload
 * Re-embeds the text-dependent wake-word templates (_wake/) in the STT service.
 */
export async function handleWakeReload(_req, res) {
  try {
    const upstream = await fetch(`${STT_URL}/speaker-id/speakers/_wake/reload`, { method: 'POST' })
    if (!upstream.ok) {
      return json(res, 502, { ok: false, error: 'stt_wake_reload_failed', status: upstream.status })
    }
    const data = await upstream.json()
    return json(res, 200, { ok: true, ...data })
  } catch (err) {
    return json(res, 502, { ok: false, error: 'stt_unreachable', detail: err.message })
  }
}

// --- Multi-speaker management ---

/**
 * GET /api/speaker-id/speakers
 */
export async function handleSpeakersList(_req, res) {
  try {
    const upstream = await fetch(`${STT_URL}/speaker-id/speakers`)
    if (!upstream.ok) {
      return json(res, 502, { ok: false, error: 'stt_speakers_failed' })
    }
    const data = await upstream.json()
    return json(res, 200, { ok: true, ...data })
  } catch (err) {
    return json(res, 502, { ok: false, error: 'stt_unreachable', detail: err.message })
  }
}

/**
 * POST /api/speaker-id/speakers — body: { name }
 */
export async function handleSpeakersCreate(req, res) {
  try {
    const body = await readBody(req)
    const name = body?.name
    if (!name || typeof name !== 'string') {
      return json(res, 400, { ok: false, error: 'missing name' })
    }

    const safe = safeName(name)
    if (!safe) {
      return json(res, 400, { ok: false, error: 'invalid name' })
    }
    await ensureSpeakerDir(safe)

    try {
      await fetch(`${STT_URL}/speaker-id/speakers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
    } catch {}

    return json(res, 201, { ok: true, name: safe })
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message })
  }
}

/**
 * DELETE /api/speaker-id/speakers?name=<name>
 */
export async function handleSpeakersDelete(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const safe = safeName(url.searchParams.get('name'))
  if (!safe) return json(res, 400, { ok: false, error: 'missing name param' })

  // Ask STT first: it knows whether this name is the protected hidden owner.
  let sttData = {}
  try {
    const upstream = await fetch(`${STT_URL}/speaker-id/speakers/${encodeURIComponent(safe)}`, {
      method: 'DELETE',
    })
    if (upstream.status === 403) {
      return json(res, 403, { ok: false, error: 'owner_protected' })
    }
    sttData = await upstream.json()
  } catch {}

  // Delete the directory on the Node side so the removal is real even when the
  // STT service is down — otherwise the profile reappears on next open.
  const dir = join(SPEAKER_DIR, safe)
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true })
  }

  return json(res, 200, { ok: true, name: safe, ...sttData })
}
