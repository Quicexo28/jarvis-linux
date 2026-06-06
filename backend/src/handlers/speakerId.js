/**
 * Speaker ID management endpoints (multi-speaker).
 *
 * Supports multiple registered speakers, each with their own subdirectory
 * under the speaker samples root. Proxies management commands to the
 * Python STT service which handles the actual embedding computation.
 */

import { readdir, stat, unlink, writeFile, mkdir, rm } from 'fs/promises'
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
    const dir = await ensureSpeakerDir(speaker)
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
    if (isNaN(threshold) || threshold < 0.5 || threshold > 0.95) {
      return json(res, 400, { ok: false, error: 'threshold must be 0.50-0.95' })
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

  // Delete the directory on the Node side so the removal is real even when the
  // STT service is down — otherwise the profile reappears on next open.
  const dir = join(SPEAKER_DIR, safe)
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true })
  }

  // Best-effort: tell STT to drop it from memory and config.
  let sttData = {}
  try {
    const upstream = await fetch(`${STT_URL}/speaker-id/speakers/${encodeURIComponent(safe)}`, {
      method: 'DELETE',
    })
    sttData = await upstream.json()
  } catch {}

  return json(res, 200, { ok: true, name: safe, ...sttData })
}
