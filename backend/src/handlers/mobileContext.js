/**
 * Mobile routine context ingestion.
 *
 * Endpoints the iPhone hits to feed Jarvis ambient signals:
 *   - the web page (MobileClient.tsx) posts live location/presence while open;
 *   - Apple Shortcuts automations post background events (arrive/leave a place,
 *     charger plugged/unplugged, focus mode, sleep/wake).
 *
 * Auth: a fixed long-lived MOBILE_INGEST_TOKEN (so Shortcuts never expire) OR
 * the currently-activated mobile session token (so the web page reuses its
 * Bearer token). Both checked against `Authorization: Bearer` and `?token=`.
 */

import { env } from 'node:process'
import { json, readBody } from '../lib/http.js'
import { getSession } from '../state/mobileSession.js'
import {
  getContext,
  getCurrentState,
  getDevices,
  updateCurrent,
  recordEvent,
  summarizeDay,
} from '../lib/mobileContext.js'

/** Which device is reporting (iphone default; tablet, etc.). */
function deviceOf(body) {
  const d = String(body.device || '').trim().toLowerCase()
  return /^[a-z0-9_-]{1,24}$/.test(d) ? d : 'iphone'
}

function extractToken(req) {
  const auth = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m) return m[1].trim()
  try {
    const url = new URL(req.url, 'http://localhost')
    return url.searchParams.get('token')
  } catch {
    return null
  }
}

function checkIngestAuth(req) {
  const token = extractToken(req)
  if (!token) return false
  const ingest = env.MOBILE_INGEST_TOKEN
  if (ingest && token === ingest) return true
  const session = getSession()
  if (session.activated && token === session.token) return true
  return false
}

async function withAuthBody(req, res, handler) {
  if (!checkIngestAuth(req)) {
    return json(res, 401, { ok: false, error: 'unauthorized' })
  }
  try {
    const body = req.method === 'GET' ? {} : await readBody(req)
    return handler(body || {})
  } catch (e) {
    return json(res, 400, { ok: false, error: 'bad_request', detail: e.message })
  }
}

/* ----- INGEST (POST) ----- */

export async function handleCtxLocation(req, res) {
  return withAuthBody(req, res, (body) => {
    const lat = Number(body.lat)
    const lon = Number(body.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json(res, 400, { ok: false, error: 'invalid_coords' })
    }
    const device = deviceOf(body)
    const location = {
      lat,
      lon,
      accuracy: Number.isFinite(Number(body.accuracy)) ? Number(body.accuracy) : null,
      place: body.place || null,
      source: body.source || 'web',
      device,
    }
    updateCurrent({ location })
    recordEvent('location', { label: location.place, data: { lat, lon }, device })
    return json(res, 200, { ok: true })
  })
}

export async function handleCtxPlace(req, res) {
  return withAuthBody(req, res, (body) => {
    const event = body.event === 'leave' ? 'leave' : 'arrive'
    const place = String(body.place || '').trim()
    if (!place) return json(res, 400, { ok: false, error: 'missing_place' })
    const device = deviceOf(body)
    recordEvent(event, { label: place, device })
    // Arriving updates current place; leaving clears it.
    const prev = getCurrentState().location || {}
    updateCurrent({ location: { ...prev, place: event === 'arrive' ? place : null, source: 'shortcut', device } })
    return json(res, 200, { ok: true, event, place })
  })
}

export async function handleCtxBattery(req, res) {
  return withAuthBody(req, res, (body) => {
    let level = Number(body.level)
    // Accept 0-1 or 0-100; normalize to 0-1.
    if (Number.isFinite(level) && level > 1) level = level / 100
    const charging = body.charging === true || body.charging === 'true' || body.charging === 1
    const device = deviceOf(body)
    // Charge/unplug transition is per-device (tablet plug must not mask phone state).
    const prev = getDevices()[device]?.battery || (device === 'iphone' ? getCurrentState().battery : null)
    updateCurrent({ battery: { level: Number.isFinite(level) ? level : null, charging, device } })
    if (!prev || prev.charging !== charging) {
      recordEvent(charging ? 'charge' : 'unplug', { data: { level }, device })
    }
    return json(res, 200, { ok: true })
  })
}

export async function handleCtxFocus(req, res) {
  return withAuthBody(req, res, (body) => {
    const mode = body.mode == null ? null : String(body.mode)
    const device = deviceOf(body)
    updateCurrent({ focus: { mode, device } })
    recordEvent('focus', { label: mode, data: { mode }, device })
    return json(res, 200, { ok: true })
  })
}

export async function handleCtxSleep(req, res) {
  return withAuthBody(req, res, (body) => {
    const state = body.state === 'asleep' ? 'asleep' : 'awake'
    const device = deviceOf(body)
    updateCurrent({ sleep: { state, device } })
    recordEvent(state === 'asleep' ? 'sleep' : 'wake', { device })
    return json(res, 200, { ok: true })
  })
}

export async function handleCtxPresence(req, res) {
  return withAuthBody(req, res, (body) => {
    const foreground = body.foreground === true || body.foreground === 'true' || body.foreground === 1
    updateCurrent({ presence: { foreground, lastSeen: new Date().toISOString(), device: deviceOf(body) } })
    return json(res, 200, { ok: true })
  })
}

/* ----- READ (GET) ----- */

export function handleCtxCurrent(req, res) {
  if (!checkIngestAuth(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
  return json(res, 200, { ok: true, current: getCurrentState(), devices: getDevices() })
}

export function handleCtxSummary(req, res) {
  if (!checkIngestAuth(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
  let date = null
  try {
    date = new URL(req.url, 'http://localhost').searchParams.get('date')
  } catch {}
  return json(res, 200, { ok: true, summary: summarizeDay(date || undefined), events: getContext().events.slice(-50) })
}
