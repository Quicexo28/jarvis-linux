/**
 * Focus sessions (pomodoro) owned by the BACKEND, not the renderer.
 *
 * The renderer already has timers, but a study session is more than a
 * countdown: at each boundary Jarvis has to speak, flip do-not-disturb, log the
 * block and start the next phase — and it must survive the UI sleeping or the
 * backend restarting mid-block (the voice self-dev agent restarts it). So the
 * schedule lives here, persisted in `kv`, and the renderer timer is only the
 * visible countdown.
 *
 * `advance(state, now)` is the whole state machine and is pure; the scheduler
 * around it only does I/O.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { kvGet, kvSet } from './turnStore.js'
import { logStudy, localDay } from './studyStore.js'
import { deliver } from './proactive.js'
import { hasClient, requestClient } from './skillBus.js'
import { setDnd } from '../handlers/desktopControl.js'
import { getVaultPath, isConfigured as vaultConfigured } from './obsidian.js'

const KV_KEY = 'study:active'
const MIN = 60e3

/**
 * @typedef {{subject:string, focusMin:number, breakMin:number, cycles:number,
 *   cycle:number, phase:'focus'|'break', phaseStartedAt:number, phaseEndsAt:number,
 *   startedAt:number}} StudyState
 */

/** Clamp the requested session into something sane. */
export function newSession({ subject, focusMin = 25, breakMin = 5, cycles = 4 } = {}, now = Date.now()) {
  const f = Math.max(1, Math.min(180, Math.round(Number(focusMin) || 25)))
  const b = Math.max(1, Math.min(60, Math.round(Number(breakMin) || 5)))
  const c = Math.max(1, Math.min(12, Math.round(Number(cycles) || 4)))
  return {
    subject: String(subject || 'estudio').trim() || 'estudio',
    focusMin: f, breakMin: b, cycles: c,
    cycle: 1, phase: 'focus',
    phaseStartedAt: now, phaseEndsAt: now + f * MIN,
    startedAt: now,
  }
}

function minutesWord(n) {
  return n === 1 ? 'un minuto' : `${n} minutos`
}

/**
 * The phase that just ended → what happens next.
 * @param {StudyState} s
 * @param {number} now
 * @returns {{next: StudyState|null, logMinutes: number, say: string, dnd: boolean}}
 */
export function advance(s, now = Date.now()) {
  if (s.phase === 'focus') {
    if (s.cycle >= s.cycles) {
      const total = s.focusMin * s.cycles
      return {
        next: null,
        logMinutes: s.focusMin,
        dnd: false,
        say: `Sesión de ${s.subject} terminada, señor: ${s.cycles === 1 ? 'un bloque' : `${s.cycles} bloques`}, ${minutesWord(total)} de foco. Buen trabajo.`,
      }
    }
    return {
      next: { ...s, phase: 'break', phaseStartedAt: now, phaseEndsAt: now + s.breakMin * MIN },
      logMinutes: s.focusMin,
      dnd: false,
      say: `Bloque ${s.cycle} de ${s.cycles} terminado. Descanso de ${minutesWord(s.breakMin)}.`,
    }
  }
  const cycle = s.cycle + 1
  return {
    next: { ...s, cycle, phase: 'focus', phaseStartedAt: now, phaseEndsAt: now + s.focusMin * MIN },
    logMinutes: 0,
    dnd: true,
    say: `Se acabó el descanso. Bloque ${cycle} de ${s.cycles}, ${minutesWord(s.focusMin)} de ${s.subject}.`,
  }
}

/** Focus minutes actually spent in a phase cut short (stop, or restart past its end). */
export function partialFocusMinutes(s, now = Date.now()) {
  if (!s || s.phase !== 'focus') return 0
  return Math.max(0, Math.floor((Math.min(now, s.phaseEndsAt) - s.phaseStartedAt) / MIN))
}

// ── I/O ─────────────────────────────────────────────────────────────────────

let timer = null

function load() {
  try { return JSON.parse(kvGet(KV_KEY) || 'null') } catch { return null }
}

function save(s) {
  kvSet(KV_KEY, s ? JSON.stringify(s) : 'null')
}

/** Mirror each focus block into the vault, where the habit notes live. */
function vaultLog(subject, minutes, now = Date.now()) {
  if (!vaultConfigured()) return
  try {
    const dir = join(getVaultPath(), '04-Habitos')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'Estudio.md')
    if (!existsSync(file)) {
      writeFileSync(file, '---\naliases: [estudio, sesiones de estudio]\ntags: [habito, estudio]\n---\n\n# Estudio\n\nBloques de foco registrados por Jarvis.\n\n', 'utf-8')
    }
    const hhmm = new Date(now).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: false })
    appendFileSync(file, `- ${localDay(now)} ${hhmm} · ${subject} · ${minutes} min\n`, 'utf-8')
  } catch (e) {
    console.warn('[study] vault log failed —', e?.message)
  }
}

function record(subject, minutes, now) {
  if (minutes < 1) return
  logStudy(subject, minutes, now)
  vaultLog(subject, minutes, now)
}

/** The visible countdown. Best effort: no renderer ⇒ the schedule still runs. */
async function showTimer(s) {
  if (!hasClient()) return
  const label = s.phase === 'focus' ? `Foco · ${s.subject}` : 'Descanso'
  try {
    await requestClient('timer_create', { durationMs: Math.max(1000, s.phaseEndsAt - Date.now()), label }, 5000)
  } catch { /* renderer busy or asleep */ }
}

async function cancelTimer(s) {
  if (!hasClient() || !s) return
  const label = s.phase === 'focus' ? `Foco · ${s.subject}` : 'Descanso'
  try { await requestClient('timer_cancel', { label }, 5000) } catch { /* nada que cancelar */ }
}

function arm(s) {
  clearTimeout(timer)
  timer = null
  if (!s) return
  timer = setTimeout(() => { onPhaseEnd().catch((e) => console.warn('[study] phase end failed —', e?.message)) },
    Math.max(0, s.phaseEndsAt - Date.now()))
  if (typeof timer.unref === 'function') timer.unref()
}

async function onPhaseEnd() {
  const s = load()
  if (!s) return
  const now = Date.now()
  const step = advance(s, now)
  record(s.subject, step.logMinutes, now)
  save(step.next)
  await setDnd(step.dnd).catch(() => {})
  console.log(`[study] ${s.phase} ${s.cycle}/${s.cycles} done -> ${step.next ? step.next.phase : 'end'}`)
  await deliver(step.say)
  if (step.next) {
    await showTimer(step.next)
    arm(step.next)
  }
}

export function studyStatus(now = Date.now()) {
  const s = load()
  if (!s) return { active: false }
  return {
    active: true,
    subject: s.subject,
    phase: s.phase,
    cycle: s.cycle,
    cycles: s.cycles,
    remainingMin: Math.max(0, Math.ceil((s.phaseEndsAt - now) / MIN)),
    focusMin: s.focusMin,
    breakMin: s.breakMin,
  }
}

export async function startStudy(opts = {}) {
  if (load()) return { ok: false, error: 'ya_activa', status: studyStatus() }
  const s = newSession(opts)
  save(s)
  await setDnd(true).catch(() => {})
  if (hasClient()) {
    try { await requestClient('mode_open', { mode: 'timer' }, 5000) } catch { /* sin vista */ }
  }
  await showTimer(s)
  arm(s)
  console.log(`[study] start ${s.subject} ${s.focusMin}/${s.breakMin} x${s.cycles}`)
  return { ok: true, status: studyStatus() }
}

export async function stopStudy(now = Date.now()) {
  const s = load()
  if (!s) return { ok: false, error: 'sin_sesion' }
  const partial = partialFocusMinutes(s, now)
  record(s.subject, partial, now)
  save(null)
  arm(null)
  await setDnd(false).catch(() => {})
  await cancelTimer(s)
  const done = (s.cycle - 1) * s.focusMin + partial
  return { ok: true, subject: s.subject, focusedMinutes: done }
}

/**
 * Boot: pick the session back up. A phase that ended while the backend was
 * down is closed out quietly (logged, not announced — nobody asked what
 * happened at 3 a.m.), and the session is dropped rather than resumed out of
 * nowhere.
 */
export function restoreStudy(now = Date.now()) {
  const s = load()
  if (!s) return
  if (s.phaseEndsAt > now) {
    arm(s)
    console.log(`[study] restored ${s.subject} (${s.phase} ${s.cycle}/${s.cycles})`)
    return
  }
  record(s.subject, partialFocusMinutes(s, now), now)
  save(null)
  setDnd(false).catch(() => {})
  console.log('[study] stale session closed at boot')
}
