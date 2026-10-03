/**
 * Calendar — the owner's agenda from iCalendar (.ics) feeds.
 *
 * Why ICS and not the Google Calendar API: the API needs an OAuth client,
 * consent screen and token refresh living in the backend. Every Google (and
 * Outlook, iCloud, Proton…) calendar already publishes a private "secret
 * address in iCal format" — one URL, read-only, no credentials to rotate. It is
 * exactly what an assistant needs to answer "¿qué tengo hoy?". Creating events
 * is out of scope on purpose (that would need the API); reminders already cover
 * "avísame a las X".
 *
 * Config: JARVIS_CALENDAR_ICS = comma-separated URLs (or local file paths).
 * Optional JARVIS_CALENDAR_NAMES = same order, display names ("Personal,U").
 *
 * The parser is deliberately small but handles what real feeds contain:
 * line folding, TZID / UTC / floating / all-day dates, RRULE (DAILY, WEEKLY
 * with BYDAY, MONTHLY with BYMONTHDAY or nth-weekday, YEARLY; INTERVAL, COUNT,
 * UNTIL), EXDATE, RECURRENCE-ID overrides and cancelled events. Recurrences are
 * expanded in WALL-CLOCK time of the event's zone, so a 9:00 meeting stays at
 * 9:00 across a DST change.
 */

import { readFile } from 'node:fs/promises'

const DEFAULT_TZ = 'America/Bogota'
const CACHE_MS = 5 * 60e3
const FETCH_TIMEOUT_MS = 10_000
const MAX_ITER = 3000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// ── time zones ───────────────────────────────────────────────────────────────

// Outlook/Exchange feeds name zones the Windows way; Intl only knows IANA.
const WINDOWS_TZ = {
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Romance Standard Time': 'Europe/Paris',
  'W. Europe Standard Time': 'Europe/Berlin',
  'GMT Standard Time': 'Europe/London',
  UTC: 'UTC',
}

function validTz(tz) {
  const name = WINDOWS_TZ[tz] || tz
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return name
  } catch {
    return DEFAULT_TZ
  }
}

/** Offset (ms) of `tz` from UTC at instant `utcMs`. */
function tzOffset(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const g = (t) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** Wall-clock time in `tz` → UTC ms. Two passes settle DST edges. Exported for tests. */
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  let utc = guess - tzOffset(guess, tz)
  utc = guess - tzOffset(utc, tz)
  return utc
}

/** UTC ms → wall-clock parts in `tz`. */
function utcToZoned(utcMs, tz) {
  const t = new Date(utcMs + tzOffset(utcMs, tz))
  return {
    y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(),
    h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), wd: t.getUTCDay(),
  }
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Split an ICS document into property lines, undoing RFC 5545 folding. */
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean)
}

function parseLine(line) {
  // NAME;PARAM=V;PARAM2="a:b":VALUE — the value starts at the first ':' that is
  // not inside a quoted parameter.
  let inQ = false
  let idx = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQ = !inQ
    else if (c === ':' && !inQ) { idx = i; break }
  }
  if (idx < 0) return null
  const head = line.slice(0, idx).split(';')
  const params = {}
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(idx + 1) }
}

function unescapeText(v) {
  return String(v ?? '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim()
}

/**
 * Parse an ICS date/datetime into {utc, allDay, tz, wall}. Exported for tests.
 * @param {string} value
 * @param {object} params  property params (TZID, VALUE)
 */
export function parseIcsDate(value, params = {}, fallbackTz = DEFAULT_TZ) {
  const v = String(value).trim()
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  const allDay = params.VALUE === 'DATE' || h === undefined
  const tz = z ? 'UTC' : validTz(params.TZID || fallbackTz)
  const wall = { y: +y, mo: +mo, d: +d, h: allDay ? 0 : +h, mi: allDay ? 0 : +mi, s: allDay ? 0 : +s }
  // All-day dates are calendar days in the OWNER's zone, not in UTC.
  const zone = allDay ? fallbackTz : tz
  return { utc: zonedToUtc(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, zone), allDay, tz: zone, wall }
}

function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return 0
  const [, sign, w, d, h, mi, s] = m
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000
  return sign === '-' ? -ms : ms
}

function parseRrule(v) {
  const r = {}
  for (const part of String(v).split(';')) {
    const [k, val] = part.split('=')
    if (k && val !== undefined) r[k.toUpperCase()] = val
  }
  return r
}

/** Parse every VEVENT of an ICS document. Exported for tests. */
export function parseIcs(text, fallbackTz = DEFAULT_TZ) {
  const events = []
  let cur = null
  for (const raw of unfold(text)) {
    if (raw === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue }
    if (raw === 'END:VEVENT') {
      if (cur?.start) events.push(cur)
      cur = null
      continue
    }
    if (!cur) continue
    const p = parseLine(raw)
    if (!p) continue
    switch (p.name) {
      case 'UID': cur.uid = p.value; break
      case 'SUMMARY': cur.title = unescapeText(p.value); break
      case 'LOCATION': cur.location = unescapeText(p.value); break
      case 'DESCRIPTION': cur.description = unescapeText(p.value).slice(0, 500); break
      case 'STATUS': cur.status = p.value.toUpperCase(); break
      case 'DTSTART': cur.start = parseIcsDate(p.value, p.params, fallbackTz); break
      case 'DTEND': cur.end = parseIcsDate(p.value, p.params, fallbackTz); break
      case 'DURATION': cur.duration = parseDuration(p.value); break
      case 'RRULE': cur.rrule = parseRrule(p.value); break
      case 'RECURRENCE-ID': cur.recurrenceId = parseIcsDate(p.value, p.params, fallbackTz); break
      case 'EXDATE':
        for (const d of p.value.split(',')) {
          const x = parseIcsDate(d, p.params, fallbackTz)
          if (x) cur.exdates.push(x.utc)
        }
        break
      default: break
    }
  }
  return events
}

// ── recurrence ───────────────────────────────────────────────────────────────

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/** Day of month of the nth `weekday` (0=Sun) in y/mo; n<0 counts from the end. */
function nthWeekday(y, mo, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay()
    const d = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7
    return d <= daysInMonth(y, mo) ? d : null
  }
  const last = daysInMonth(y, mo)
  const lastWd = new Date(Date.UTC(y, mo - 1, last)).getUTCDay()
  const d = last - ((lastWd - weekday + 7) % 7) + (n + 1) * 7
  return d >= 1 ? d : null
}

/**
 * Occurrence start times (UTC ms) of a recurring event, in [fromMs, toMs).
 * Exported for tests.
 */
export function expandRrule(ev, fromMs, toMs) {
  const r = ev.rrule
  const { wall, tz } = ev.start
  const freq = r.FREQ
  const interval = Math.max(1, Number(r.INTERVAL) || 1)
  const count = r.COUNT ? Number(r.COUNT) : Infinity
  const until = r.UNTIL ? parseIcsDate(r.UNTIL, {}, tz)?.utc ?? Infinity : Infinity
  const byday = r.BYDAY ? r.BYDAY.split(',') : null
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null
  const at = (y, mo, d) => zonedToUtc(y, mo, d, wall.h, wall.mi, wall.s, tz)

  const out = []
  let emitted = 0
  const emit = (utc) => {
    if (utc < ev.start.utc) return true // before DTSTART never counts
    if (utc > until || emitted >= count) return false
    emitted++
    if (utc >= fromMs && utc < toMs) out.push(utc)
    return utc < toMs
  }

  // Fast-forward: a daily event that started years ago would otherwise burn
  // MAX_ITER on the past and never reach the window. Only safe without COUNT
  // (COUNT needs every earlier occurrence counted).
  const fw = utcToZoned(fromMs, tz)
  const dayDiff = Math.floor((Date.UTC(fw.y, fw.mo - 1, fw.d) - Date.UTC(wall.y, wall.mo - 1, wall.d)) / 86400e3)
  const unitsBefore = count !== Infinity || dayDiff <= 0 ? 0
    : freq === 'DAILY' ? dayDiff - 1
      : freq === 'WEEKLY' ? Math.floor(dayDiff / 7) - 1
        : freq === 'MONTHLY' ? (fw.y - wall.y) * 12 + (fw.mo - wall.mo) - 1
          : freq === 'YEARLY' ? fw.y - wall.y - 1 : 0
  const skip = Math.max(0, Math.floor(unitsBefore / interval) * interval)

  let guard = 0
  if (freq === 'DAILY') {
    for (let i = skip; guard++ < MAX_ITER; i += interval) {
      const t = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d + i))
      if (!emit(at(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()))) break
    }
  } else if (freq === 'WEEKLY') {
    const days = (byday || [WEEKDAYS[new Date(Date.UTC(wall.y, wall.mo - 1, wall.d)).getUTCDay()]])
      .map((s) => WEEKDAYS.indexOf(s.slice(-2))).filter((x) => x >= 0)
    // Weeks start on Monday (RFC default WKST=MO).
    const startWd = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d)).getUTCDay()
    const monday = wall.d - ((startWd + 6) % 7)
    const order = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    outer: for (let w = skip; guard++ < MAX_ITER; w += interval) {
      for (const wd of order) {
        const t = new Date(Date.UTC(wall.y, wall.mo - 1, monday + w * 7 + ((wd + 6) % 7)))
        if (!emit(at(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()))) break outer
      }
    }
  } else if (freq === 'MONTHLY') {
    outer: for (let i = skip; guard++ < MAX_ITER; i += interval) {
      const t = new Date(Date.UTC(wall.y, wall.mo - 1 + i, 1))
      const y = t.getUTCFullYear()
      const mo = t.getUTCMonth() + 1
      let dayList
      if (byday) {
        dayList = byday.map((s) => {
          const m = s.match(/^([+-]?\d+)?([A-Z]{2})$/)
          return m ? nthWeekday(y, mo, WEEKDAYS.indexOf(m[2]), Number(m[1] || 1)) : null
        })
      } else {
        dayList = (bymonthday || [wall.d]).map((d) => (d < 0 ? daysInMonth(y, mo) + d + 1 : d))
      }
      // A 31st in a 30-day month simply doesn't happen (RFC behaviour).
      for (const d of dayList.filter((d) => d && d <= daysInMonth(y, mo)).sort((a, b) => a - b)) {
        if (!emit(at(y, mo, d))) break outer
      }
    }
  } else if (freq === 'YEARLY') {
    for (let i = skip; guard++ < MAX_ITER; i += interval) {
      const y = wall.y + i
      if (wall.d > daysInMonth(y, wall.mo)) continue // 29 Feb
      if (!emit(at(y, wall.mo, wall.d))) break
    }
  } else {
    // Unsupported frequency (HOURLY…): show the first occurrence only.
    emit(ev.start.utc)
  }
  const ex = new Set(ev.exdates)
  return out.filter((u) => !ex.has(u))
}

/**
 * Concrete occurrences of parsed events within [fromMs, toMs), sorted.
 * Exported for tests.
 */
export function occurrences(events, fromMs, toMs, calendar = null) {
  const overrides = new Map() // uid -> Set(original start utc)
  for (const e of events) {
    if (e.recurrenceId && e.uid) {
      if (!overrides.has(e.uid)) overrides.set(e.uid, new Set())
      overrides.get(e.uid).add(e.recurrenceId.utc)
    }
  }
  const out = []
  for (const e of events) {
    if (e.status === 'CANCELLED') continue
    const dur = e.end ? e.end.utc - e.start.utc : (e.duration || (e.start.allDay ? 86400e3 : 0))
    const starts = e.rrule && !e.recurrenceId
      ? expandRrule(e, fromMs - dur, toMs).filter((u) => !overrides.get(e.uid)?.has(u))
      : [e.start.utc]
    for (const s of starts) {
      const end = s + dur
      // Overlaps the window (an event already in progress counts).
      if (end > fromMs && s < toMs || (dur === 0 && s >= fromMs && s < toMs)) {
        out.push({
          title: e.title || '(sin título)',
          start: new Date(s).toISOString(),
          end: new Date(end).toISOString(),
          allDay: !!e.start.allDay,
          location: e.location || null,
          calendar,
        })
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

// ── sources ──────────────────────────────────────────────────────────────────

const cache = new Map() // src -> {ts, events}

function sources() {
  const urls = String(process.env.JARVIS_CALENDAR_ICS || '').split(',').map((s) => s.trim()).filter(Boolean)
  const names = String(process.env.JARVIS_CALENDAR_NAMES || '').split(',').map((s) => s.trim())
  return urls.map((src, i) => ({ src, name: names[i] || null }))
}

export function calendarConfigured() {
  return sources().length > 0
}

async function loadSource(src) {
  const hit = cache.get(src)
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.events
  let text
  if (/^https?:\/\//i.test(src) || /^webcal:\/\//i.test(src)) {
    const url = src.replace(/^webcal:/i, 'https:')
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } else {
    text = await readFile(src, 'utf-8')
  }
  const events = parseIcs(text)
  cache.set(src, { ts: Date.now(), events })
  return events
}

/**
 * Events in a window. `from` defaults to the start of today (owner's zone).
 * @returns {Promise<{ok: boolean, events: object[], errors: string[], error?: string}>}
 */
export async function agenda({ from, days = 1 } = {}) {
  const srcs = sources()
  if (!srcs.length) return { ok: false, error: 'calendar_not_configured', events: [], errors: [] }
  const start = from ? new Date(from).getTime() : startOfLocalDay(Date.now())
  const end = start + Math.max(1, Math.min(Number(days) || 1, 60)) * 86400e3
  const events = []
  const errors = []
  await Promise.all(srcs.map(async ({ src, name }) => {
    try {
      events.push(...occurrences(await loadSource(src), start, end, name))
    } catch (e) {
      // Never the full URL: it IS the secret.
      errors.push(`${name || 'calendario'}: ${e?.message}`)
    }
  }))
  events.sort((a, b) => a.start.localeCompare(b.start))
  return { ok: errors.length < srcs.length, events, errors, from: new Date(start).toISOString(), to: new Date(end).toISOString() }
}

export function startOfLocalDay(ms, tz = DEFAULT_TZ) {
  const z = utcToZoned(ms, tz)
  return zonedToUtc(z.y, z.mo, z.d, 0, 0, 0, tz)
}

/** "9:30 a. m." in the owner's zone, for spoken summaries. */
export function spokenTime(iso, tz = DEFAULT_TZ) {
  return new Date(iso).toLocaleTimeString('es-CO', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
}
