/**
 * Mobile routine context store.
 *
 * File-based persistence (no DB, mirrors reminders.js): the user's iPhone feeds
 * Jarvis ambient signals — location, battery, focus mode, sleep, foreground
 * presence — via the web page (foreground) and Apple Shortcuts automations
 * (background, event-driven POSTs). We keep a `current` snapshot plus an
 * append-only `events` log (capped) so Jarvis can answer "¿dónde estoy?" and
 * summarize the day's routine.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', '..', 'data')
const STORE = join(DATA_DIR, 'mobile-context.json')

const MAX_EVENTS = 500

function emptyStore() {
  return {
    current: {
      location: null, // { lat, lon, accuracy, place, source, ts }
      battery: null,  // { level, charging, ts }
      focus: null,    // { mode, ts }
      sleep: null,    // { state: 'asleep'|'awake', ts }
      presence: null, // { foreground, lastSeen }
    },
    // Per-device snapshots (iphone, tablet, ...). `current` stays the merged
    // last-writer view; byDevice lets Jarvis answer "¿batería de la tablet?".
    byDevice: {},
    events: [],
  }
}

function loadStore() {
  try {
    if (!existsSync(STORE)) return emptyStore()
    const parsed = JSON.parse(readFileSync(STORE, 'utf-8'))
    return {
      ...emptyStore(),
      ...parsed,
      current: { ...emptyStore().current, ...(parsed.current || {}) },
      byDevice: parsed.byDevice || {},
    }
  } catch {
    return emptyStore()
  }
}

function save(store) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf-8')
}

/** Full store (current + events). */
export function getContext() {
  return loadStore()
}

/** Latest known device state. */
export function getCurrentState() {
  return loadStore().current
}

/** Per-device snapshots ({ iphone: {battery,...}, tablet: {...} }). */
export function getDevices() {
  return loadStore().byDevice
}

/**
 * Shallow-merge a patch into `current`. Each top-level key (location/battery/
 * focus/sleep/presence) is replaced wholesale and stamped with `ts`.
 */
export function updateCurrent(patch) {
  const store = loadStore()
  const ts = new Date().toISOString()
  for (const [key, value] of Object.entries(patch || {})) {
    if (value == null) continue
    const stamped = { ...value, ts: value.ts || ts }
    store.current[key] = stamped
    if (stamped.device) {
      store.byDevice[stamped.device] = { ...store.byDevice[stamped.device], [key]: stamped }
    }
  }
  save(store)
  return store.current
}

/** Append a routine event. Keeps only the last MAX_EVENTS. */
export function recordEvent(type, { label = null, data = {}, device = null } = {}) {
  const store = loadStore()
  const entry = { type, label, data, device, ts: new Date().toISOString() }
  store.events.push(entry)
  if (store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(-MAX_EVENTS)
  }
  save(store)
  return entry
}

const EVENT_LABELS = {
  arrive: (e) => `Llegaste a ${e.label || 'un lugar'}`,
  leave: (e) => `Saliste de ${e.label || 'un lugar'}`,
  charge: () => 'Conectaste el cargador',
  unplug: () => 'Desconectaste el cargador',
  focus: (e) => `Modo concentración: ${e.data?.mode ?? e.label ?? 'cambió'}`,
  sleep: () => 'Te dormiste',
  wake: () => 'Te despertaste',
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function dayKey(ts) {
  // YYYY-MM-DD in America/Bogota
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })
}

/**
 * Human-readable summary of a day's routine events (default: today, Bogota tz).
 * Skips raw 'location'/'presence' noise; focuses on meaningful transitions.
 */
export function summarizeDay(dateISO) {
  const store = loadStore()
  const target = dateISO ? dayKey(dateISO) : dayKey(new Date().toISOString())
  const NOISE = new Set(['location', 'presence'])
  const items = store.events
    .filter((e) => dayKey(e.ts) === target && !NOISE.has(e.type))
    .map((e) => {
      const fmt = EVENT_LABELS[e.type]
      const label = fmt ? fmt(e) : e.type
      const dev = e.device && e.device !== 'iphone' ? ` (${e.device})` : ''
      return `${fmtTime(e.ts)} ${label}${dev}`
    })
  if (!items.length) return 'Sin eventos de rutina registrados hoy.'
  return items.join(' · ')
}
