/**
 * Self-healing watchdog — Jarvis notices when it breaks, says so with an error
 * code, fixes what it safely can, and delegates the rest to the dev agent.
 *
 * Why this exists: twice the whole voice brain died (CLI 2.1.243 segfaulting,
 * then an unknown `--autocompact` flag) and the ONLY symptom was every turn
 * answering "No tengo respuesta en este momento". The cause was sitting in
 * journald both times. Nothing was watching, so the owner found out by talking
 * to a wall.
 *
 * Three layers, cheapest first:
 *
 *   1. DETECT  — any module reports through incidentBus; a periodic probe checks
 *                systemd units, the STT port and the `claude` binary; the voice
 *                pipeline reports every turn so a streak of fallbacks is seen.
 *   2. RUNTIME — a fixed playbook of SAFE actions: restart a dead service,
 *                respawn the Claude sessions. No code changes, rate limited.
 *   3. CODE    — when the evidence points INTO the repo (a stack frame in our
 *                source, a CLI flag our code passes, a tool that keeps failing
 *                the same way), offer a devAgent job with the incident as the
 *                instruction; it runs when the owner says so ("arregla el
 *                incidente N"). Guarded hard: see codeFixBlock().
 *
 * Every incident carries a stable code (JRV-AREA-NNN) and the literal error, and
 * is persisted in SQLite (`incidents`) so it survives the restart that a crash
 * or a code fix causes.
 *
 * Kill switches: JARVIS_SELFHEAL=0 (everything), JARVIS_SELFHEAL_CODE=ask|auto|off
 * (layer 3; default ask = the owner approves each code fix by voice or tool),
 * JARVIS_SELFHEAL_MAX_FIXES (per day, default 2, only for auto).
 */

import { execFile } from 'node:child_process'
import { onIssue, reportIssue } from './incidentBus.js'
import { storeDb } from './turnStore.js'

// ── catalogue ────────────────────────────────────────────────────────────────
// The code is what the owner sees and can quote back ("arregla el JRV-SVC-001").
// `fixable` = the cause can plausibly live in our repo, so layer 3 may run.
export const CODES = {
  'JRV-BRAIN-001': { title: 'El cerebro de voz no responde (respuestas de reserva seguidas)', fixable: false },
  'JRV-CLI-001':   { title: 'El binario de Claude no arranca', fixable: false },
  'JRV-CLI-002':   { title: 'El CLI de Claude rechaza una opción que le pasa el código', fixable: true },
  'JRV-CLI-003':   { title: 'La sesión de Claude muere al arrancar', fixable: false },
  'JRV-SVC-001':   { title: 'Servicio de Jarvis caído', fixable: false },
  'JRV-STT-001':   { title: 'El servicio de transcripción no responde', fixable: false },
  'JRV-EXC-001':   { title: 'Excepción no capturada en el backend', fixable: true },
  'JRV-EXC-002':   { title: 'Promesa rechazada sin manejar en el backend', fixable: true },
  'JRV-ROUTE-001': { title: 'Una ruta del backend lanzó un error', fixable: true },
  'JRV-TOOL-001':  { title: 'Una herramienta falla repetidamente', fixable: true },
  'JRV-DEV-001':   { title: 'El arreglo automático no resolvió el fallo', fixable: false },
}

// JARVIS_FAKE_CLAUDE marks a contract-test child (see tests/*.contract.test.js): it
// shares the default DB path and dies on EADDRINUSE — never a real incident.
const ENABLED = () => process.env.JARVIS_SELFHEAL !== '0' && process.env.JARVIS_FAKE_CLAUDE !== '1'
const CODE_MODE = () => {
  // Default ASK: a code change runs an agent with full permissions over the
  // repo, so a human says go. Runtime remedies (layer 2) stay automatic.
  const m = String(process.env.JARVIS_SELFHEAL_CODE || 'ask').toLowerCase()
  return ['auto', 'ask', 'off'].includes(m) ? m : 'ask'
}
const MAX_FIXES_PER_DAY = () => Number(process.env.JARVIS_SELFHEAL_MAX_FIXES ?? 2)
const PROBE_MS = () => Number(process.env.JARVIS_SELFHEAL_INTERVAL_MS ?? 3 * 60e3)
const CLI_PROBE_MS = 30 * 60e3
const BRAIN_STREAK = 3              // fallbacks in a row before it is an incident
const TOOL_REPEAT = 3               // same tool error this many times in 24 h
const NOTIFY_GAP_MS = 30 * 60e3     // per incident, so a flapping fault isn't spam
const RESTART_MAX_PER_HOUR = 3
const REFIX_GAP_MS = 24 * 3600e3    // one code-fix attempt per incident per day
const RECUR_AFTER_FIX_MS = 6 * 3600e3

/** Long-running units it is SAFE to restart. Oneshot/timer units are only reported. */
const RESTARTABLE = new Set([
  'jarvis-stt', 'jarvis-tts', 'jarvis-wake', 'jarvis-ui', 'jarvis-notifier',
  'jarvis-agenthub', 'jarvis-sunshine-pc', 'jarvis-embed', 'claude-agenthub',
  'jarvis-jarvisbot', 'jarvis-cloudbot',
])

const FALLBACK_REPLY = 'No tengo respuesta en este momento.'

// Tool errors that describe the WORLD, not a bug: UI asleep, a speaker without
// permission, a built-in the voice session is denied on purpose, a machine
// that's off. Fixing code would not change any of them.
const ENVIRONMENTAL_TOOL_ERROR_RE =
  /renderer_not_connected|not_configured|risk_denied|owner_only|remote_forbidden|no such tool available|is disabled for this session|machine_offline|not_connected|offline|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timeout|cancel|abort|job_running|no_active|unknown_job|not_found|ambigua|ambiguous|invalid_|missing_|bad_request|required/i

// ── pure helpers (exported for tests) ────────────────────────────────────────

/** Strip the parts of an error that change between occurrences (ids, numbers, paths in /tmp). */
export function normalizeErrorKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\/tmp\/\S+/g, '<tmp>')
    .replace(/[0-9a-f]{8,}/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/** Does a stack trace have frames in OUR source (not node internals or deps)? */
export function stackInRepo(detail) {
  return String(detail ?? '')
    .split('\n')
    .some((l) => /\bat\b/.test(l) && /jarvis-linux\/(backend|frontend)\//.test(l) && !/node_modules/.test(l))
}

/** Tool error that is a symptom of the environment, not of our code. */
export function isEnvironmentalToolError(err) {
  return ENVIRONMENTAL_TOOL_ERROR_RE.test(String(err ?? ''))
}

/**
 * Parse `systemctl --user list-units --all --plain --no-legend` rows.
 * @returns {Array<{unit: string, name: string, load: string, active: string, sub: string}>}
 */
export function parseUnits(out) {
  return String(out ?? '')
    .split('\n')
    .map((l) => l.replace(/^[●*\s]+/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [unit, load, active, sub] = l.split(/\s+/)
      return { unit, name: String(unit || '').replace(/\.(service|timer)$/, ''), load, active, sub }
    })
    .filter((u) => u.unit && u.unit.endsWith('.service'))
}

/**
 * Why layer 3 (a code fix) must NOT run for this incident now, or null.
 * Pure: all state comes in as arguments.
 */
export function codeFixBlock(inc, { mode, now, fixesToday, maxPerDay, jobActive, hasCodeDir }) {
  if (mode === 'off') return 'disabled'
  if (!hasCodeDir) return 'no_code_dir'
  const meta = CODES[inc.code]
  if (!meta?.fixable) return 'not_code_fixable'
  if (['fixing', 'fixed', 'ignored', 'resolved'].includes(inc.status)) return `status_${inc.status}`
  if (inc.lastFixTs && now - inc.lastFixTs < REFIX_GAP_MS) return 'already_tried_today'
  // A crash kills the process, so one occurrence is all we ever get to see.
  const minCount = inc.code === 'JRV-EXC-001' ? 1 : inc.code === 'JRV-TOOL-001' ? TOOL_REPEAT : 2
  if (inc.count < minCount) return 'not_recurring_yet'
  if ((inc.code === 'JRV-EXC-001' || inc.code === 'JRV-EXC-002' || inc.code === 'JRV-ROUTE-001') && !stackInRepo(inc.detail)) {
    return 'stack_outside_repo'
  }
  if (inc.code === 'JRV-TOOL-001' && isEnvironmentalToolError(inc.message)) return 'environmental'
  if (jobActive) return 'dev_job_running'
  if (fixesToday >= maxPerDay) return 'daily_budget_spent'
  if (mode === 'ask') return 'awaiting_owner'
  return null
}

/** The instruction handed to the dev agent. Exported so tests pin its contract. */
export function buildFixInstruction(inc) {
  const meta = CODES[inc.code] || { title: inc.code }
  return [
    `AUTODIAGNÓSTICO — incidente ${inc.code} (#${inc.id}): ${meta.title}.`,
    '',
    `Mensaje: ${inc.message}`,
    `Origen: ${inc.source}. Ocurrencias: ${inc.count} (primera ${new Date(inc.firstTs).toISOString()}, última ${new Date(inc.lastTs).toISOString()}).`,
    inc.ctx && Object.keys(inc.ctx).length ? `Contexto: ${JSON.stringify(inc.ctx).slice(0, 600)}` : '',
    '',
    'Detalle literal (stack / stderr / salida):',
    '```',
    String(inc.detail || '(sin detalle)').slice(0, 4000),
    '```',
    '',
    'Tarea: encuentra la CAUSA RAÍZ en el código de Jarvis y arréglala.',
    '1. Localiza el origen leyendo el código señalado; no adivines.',
    '2. Si puedes, escribe primero un test que reproduzca el fallo y compruébalo fallando; luego arréglalo y compruébalo pasando.',
    '3. Cambio mínimo. No refactorices de paso. No silencies el error con un try/catch vacío: eso esconde el síntoma, no lo arregla.',
    '4. Si la causa está FUERA del código (un servicio externo, la red, un binario, credenciales, hardware), NO cambies nada y explica en el RESUMEN qué tiene que hacer el señor.',
  ].filter((l) => l !== null).join('\n')
}

// ── storage ──────────────────────────────────────────────────────────────────

let migrated = false
function db() {
  const d = storeDb()
  if (!d) return null
  if (!migrated) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT NOT NULL UNIQUE,
        code        TEXT NOT NULL,
        source      TEXT,
        message     TEXT,
        detail      TEXT,
        ctx         TEXT,
        first_ts    INTEGER NOT NULL,
        last_ts     INTEGER NOT NULL,
        count       INTEGER NOT NULL DEFAULT 1,
        status      TEXT NOT NULL DEFAULT 'open',
        actions     TEXT,
        job_id      TEXT,
        last_fix_ts INTEGER,
        fixed_ts    INTEGER,
        notified_ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_last ON incidents(last_ts);
    `)
    migrated = true
  }
  return d
}

function rowToIncident(r) {
  if (!r) return null
  return {
    id: r.id, key: r.key, code: r.code, source: r.source, message: r.message, detail: r.detail,
    ctx: safeJson(r.ctx, {}), firstTs: r.first_ts, lastTs: r.last_ts, count: r.count,
    status: r.status, actions: safeJson(r.actions, []), jobId: r.job_id,
    lastFixTs: r.last_fix_ts, fixedTs: r.fixed_ts, notifiedTs: r.notified_ts,
    title: CODES[r.code]?.title ?? r.code,
  }
}

function safeJson(s, dflt) {
  try { return s ? JSON.parse(s) : dflt } catch { return dflt }
}

export function getIncident(id) {
  const d = db()
  if (!d) return null
  return rowToIncident(d.prepare('SELECT * FROM incidents WHERE id = ?').get(Number(id)))
}

function getByKey(key) {
  const d = db()
  if (!d) return null
  return rowToIncident(d.prepare('SELECT * FROM incidents WHERE key = ?').get(key))
}

/** Incidents, newest first. `open` = everything not resolved/ignored. */
export function listIncidents({ open = false, limit = 30 } = {}) {
  const d = db()
  if (!d) return []
  const rows = open
    ? d.prepare("SELECT * FROM incidents WHERE status NOT IN ('resolved','ignored') ORDER BY last_ts DESC LIMIT ?").all(limit)
    : d.prepare('SELECT * FROM incidents ORDER BY last_ts DESC LIMIT ?').all(limit)
  return rows.map(rowToIncident)
}

function update(id, fields) {
  const d = db()
  if (!d) return
  const cols = {
    status: 'status', jobId: 'job_id', lastFixTs: 'last_fix_ts', fixedTs: 'fixed_ts',
    notifiedTs: 'notified_ts', actions: 'actions',
  }
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(fields)) {
    if (!cols[k]) continue
    sets.push(`${cols[k]} = ?`)
    vals.push(k === 'actions' ? JSON.stringify(v) : v)
  }
  if (!sets.length) return
  d.prepare(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

function addAction(inc, action, result) {
  const actions = [...(inc.actions || []), { ts: Date.now(), action, result }].slice(-20)
  inc.actions = actions
  update(inc.id, { actions })
}

/** Insert or bump. Returns {incident, isNew, reopened, recurredAfterFix}. */
function upsert(rec) {
  const d = db()
  if (!d) return null
  const key = rec.key || rec.code
  const prev = getByKey(key)
  const now = rec.ts || Date.now()
  if (!prev) {
    d.prepare(`INSERT INTO incidents (key, code, source, message, detail, ctx, first_ts, last_ts, count, status, actions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', '[]')`)
      .run(key, rec.code, rec.source ?? null, String(rec.message ?? '').slice(0, 500),
        String(rec.detail ?? '').slice(-6000), JSON.stringify(rec.ctx ?? {}), now, now)
    return { incident: getByKey(key), isNew: true, reopened: false, recurredAfterFix: false }
  }
  const closed = ['resolved', 'fixed', 'remediated'].includes(prev.status)
  const recurredAfterFix = prev.status === 'fixed' && prev.fixedTs && now - prev.fixedTs < RECUR_AFTER_FIX_MS
  const status = prev.status === 'ignored' ? 'ignored' : closed ? 'open' : prev.status
  d.prepare(`UPDATE incidents SET last_ts = ?, count = count + 1, message = ?, detail = ?, ctx = ?, status = ? WHERE id = ?`)
    .run(now, String(rec.message ?? prev.message).slice(0, 500),
      String(rec.detail || prev.detail || '').slice(-6000), JSON.stringify(rec.ctx ?? prev.ctx ?? {}), status, prev.id)
  return { incident: getByKey(key), isNew: false, reopened: closed, recurredAfterFix }
}

/** Mark resolved (the fault is gone) — e.g. the probe sees the service up again. */
export function resolveIncident(id, how = 'resuelto') {
  const inc = getIncident(id)
  if (!inc) return null
  addAction(inc, 'resolve', how)
  update(inc.id, { status: 'resolved' })
  return getIncident(id)
}

/** The owner says "ignore it": stays visible, never notified or fixed again. */
export function dismissIncident(id) {
  const inc = getIncident(id)
  if (!inc) return null
  addAction(inc, 'dismiss', 'descartado por el señor')
  update(inc.id, { status: 'ignored' })
  return getIncident(id)
}

// ── shell ────────────────────────────────────────────────────────────────────

function sh(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        signal: err?.signal ?? null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      })
    })
  })
}

async function journalTail(unit, n = 8) {
  const r = await sh('journalctl', ['--user', '-u', unit, '-n', String(n), '--no-pager', '-o', 'cat'])
  return r.stdout.trim()
}

// ── notify ───────────────────────────────────────────────────────────────────

function formatNotice(inc, actionText) {
  const lines = [
    `⚠️ Jarvis · ${inc.code} (#${inc.id})`,
    inc.title,
    inc.message,
  ]
  if (inc.detail) lines.push('', String(inc.detail).trim().split('\n').slice(-6).join('\n').slice(0, 700))
  if (actionText) lines.push('', `Acción: ${actionText}`)
  return lines.join('\n')
}

async function notify(inc, actionText, { speak = false, force = false } = {}) {
  const now = Date.now()
  if (!force && inc.notifiedTs && now - inc.notifiedTs < NOTIFY_GAP_MS) return
  update(inc.id, { notifiedTs: now })
  inc.notifiedTs = now
  const text = formatNotice(inc, actionText)
  console.warn(`[selfheal] ${text.replace(/\n+/g, ' | ')}`)
  try {
    const { notifyJarvis } = await import('./cloudStorage.js')
    await notifyJarvis(text)
  } catch {}
  if (speak) {
    try {
      const { hasClient, requestClient } = await import('./skillBus.js')
      const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false })) % 24
      if (hasClient() && h >= 7 && h < 23) {
        const spoken = `Señor, detecté un fallo: ${inc.title.toLowerCase()}. Código ${inc.code.replace(/-/g, ' ')}.` +
          (actionText ? ` ${actionText}.` : '')
        await requestClient('speak_text', { text: spoken.slice(0, 280) }, 20000)
      }
    } catch {}
  }
}

// ── layer 2: runtime playbook ────────────────────────────────────────────────

const restarts = new Map() // unit -> [ts...]
const lastRemedy = new Map() // incident id -> ts
const REMEDY_GAP_MS = 5 * 60e3

function canRestart(unit, now = Date.now()) {
  const hist = (restarts.get(unit) || []).filter((t) => now - t < 3600e3)
  restarts.set(unit, hist)
  return hist.length < RESTART_MAX_PER_HOUR
}

async function restartUnit(inc, unit) {
  if (!canRestart(unit)) {
    addAction(inc, `restart ${unit}`, 'omitido: tope de reinicios por hora')
    return `no reinicio ${unit}: ya lo intenté ${RESTART_MAX_PER_HOUR} veces esta hora`
  }
  restarts.get(unit).push(Date.now())
  const r = await sh('systemctl', ['--user', 'restart', unit], 60000)
  // Give it a moment and look again: "restart returned 0" is not "it is up".
  await new Promise((res) => setTimeout(res, 4000))
  const st = await sh('systemctl', ['--user', 'is-active', unit])
  const up = st.stdout.trim() === 'active'
  addAction(inc, `restart ${unit}`, up ? 'activo' : `sigue ${st.stdout.trim() || 'caído'} ${r.stderr.trim()}`.trim())
  if (up) update(inc.id, { status: 'remediated' })
  return up ? `reinicié ${unit} y volvió` : `reinicié ${unit} pero sigue caído`
}

async function respawnBrain(inc) {
  try {
    const { resetSessions } = await import('./claudeCli.js')
    const n = resetSessions()
    addAction(inc, 'respawn sessions', `${n} sesiones reiniciadas`)
    return `reinicié ${n} sesiones del cerebro`
  } catch (e) {
    addAction(inc, 'respawn sessions', `falló: ${e?.message}`)
    return 'no pude reiniciar las sesiones'
  }
}

/** Run the safe, code-free remedy for this incident. Returns a sentence or ''. */
async function remediate(inc) {
  switch (inc.code) {
    case 'JRV-SVC-001': {
      const unit = inc.ctx?.unit
      if (unit && RESTARTABLE.has(unit.replace(/\.service$/, ''))) return restartUnit(inc, unit)
      return ''
    }
    case 'JRV-STT-001':
      return restartUnit(inc, 'jarvis-stt.service')
    case 'JRV-BRAIN-001': {
      // Respawn first, then check the binary itself: if `claude --version`
      // dies, a respawn can't help and the owner needs to know THAT.
      const what = await respawnBrain(inc)
      await probeCli({ force: true })
      return what
    }
    default:
      return ''
  }
}

// ── layer 3: code fix ────────────────────────────────────────────────────────

function fixesToday(now = Date.now()) {
  const d = db()
  if (!d) return 0
  const since = now - 24 * 3600e3
  return d.prepare('SELECT COUNT(*) AS n FROM incidents WHERE last_fix_ts >= ?').get(since)?.n ?? 0
}

/**
 * Try to launch a code fix. `manual` = the owner asked for it explicitly, which
 * skips the "ask" gate and the recurrence threshold but NOT the safety ones.
 */
export async function attemptCodeFix(id, { manual = false } = {}) {
  const inc = getIncident(id)
  if (!inc) return { ok: false, error: 'unknown_incident' }
  const { getActiveJob, startDevJob } = await import('./devAgent.js')
  const { getCodeDir } = await import('./claudeCli.js')
  const block = codeFixBlock(manual ? { ...inc, count: Math.max(inc.count, 99), status: inc.status === 'ignored' ? 'open' : inc.status } : inc, {
    mode: manual ? 'auto' : CODE_MODE(),
    now: Date.now(),
    fixesToday: fixesToday(),
    maxPerDay: manual ? Infinity : MAX_FIXES_PER_DAY(),
    jobActive: !!getActiveJob(),
    hasCodeDir: !!getCodeDir(),
  })
  // Manual requests may target non-"fixable" codes too (the owner knows best),
  // as long as the safety gates hold.
  const hardBlocks = ['no_code_dir', 'dev_job_running', 'status_fixing', 'disabled']
  if (block && (!manual || hardBlocks.includes(block))) return { ok: false, error: block, incident: inc }

  const job = await startDevJob({
    instruction: buildFixInstruction(inc),
    requestedBy: manual ? 'autodiagnostico (pedido por el señor)' : 'autodiagnostico',
    incidentId: inc.id,
  })
  if (!job.ok) {
    addAction(inc, 'code fix', `no arrancó: ${job.error}`)
    return { ok: false, error: job.error, incident: inc }
  }
  addAction(inc, 'code fix', `job ${job.jobId}`)
  update(inc.id, { status: 'fixing', jobId: job.jobId, lastFixTs: Date.now() })
  return { ok: true, jobId: job.jobId, incident: getIncident(inc.id) }
}

/** devAgent calls this when a job that came from an incident finishes. */
export function onFixJobDone(incidentId, { ok, summary, jobId }) {
  const inc = getIncident(incidentId)
  if (!inc) return
  addAction(inc, 'code fix result', `${ok ? 'aplicado' : 'fallido'} (${jobId}): ${String(summary || '').slice(0, 200)}`)
  update(inc.id, ok ? { status: 'fixed', fixedTs: Date.now() } : { status: 'failed' })
}

// ── the pipeline every report goes through ───────────────────────────────────

async function handleIssue(rec) {
  if (!ENABLED() || !rec?.code) return
  const up = upsert(rec)
  if (!up?.incident) return
  const inc = up.incident

  if (inc.status === 'ignored') return

  if (up.recurredAfterFix) {
    // The fix didn't hold. Don't loop a second agent at it — tell the owner.
    update(inc.id, { status: 'failed' })
    addAction(inc, 'recurrence', 'volvió a ocurrir después del arreglo automático')
    const cp = inc.jobId ? ` (job ${inc.jobId}; se puede revertir con code_rollback)` : ''
    reportIssue({
      code: 'JRV-DEV-001', source: 'selfheal', key: `refix:${inc.key}`,
      message: `${inc.code} #${inc.id} reapareció tras el arreglo automático${cp}`,
      detail: inc.detail,
    })
    return
  }

  const speak = /^JRV-(BRAIN|CLI)/.test(inc.code)
  // A fault that keeps reporting (every probe, every failed turn) must not get
  // its remedy re-run each time — once per REMEDY_GAP_MS is plenty.
  let action = ''
  const lastR = lastRemedy.get(inc.id) || 0
  if (Date.now() - lastR > REMEDY_GAP_MS) {
    lastRemedy.set(inc.id, Date.now())
    action = await remediate(inc).catch((e) => `remedio falló: ${e?.message}`)
  }

  const fresh = getIncident(inc.id)
  const fix = await maybeAutoFix(fresh)
  const fixText = fix?.ok
    ? `lancé un agente para arreglar el código (job ${fix.jobId})`
    : fix?.error === 'awaiting_owner'
      ? `puedo intentar arreglarlo en el código: diga "arregla el incidente ${inc.id}"`
      : ''

  // Notify on first sight, on reopening, or whenever something was DONE.
  if (up.isNew || up.reopened || action || fixText) {
    await notify(getIncident(inc.id), [action, fixText].filter(Boolean).join('; '), {
      speak: speak || !!fix?.ok,
      force: !!fix?.ok,
    })
  }
}

async function maybeAutoFix(inc) {
  if (!inc || !CODES[inc.code]?.fixable) return null
  try {
    return await attemptCodeFix(inc.id)
  } catch (e) {
    console.warn('[selfheal] code fix failed to start —', e?.message)
    return null
  }
}

// ── turn health (fed by the voice pipeline) ──────────────────────────────────

let fallbackStreak = 0

/**
 * Called once per answered turn. A streak of fallback replies is the signature
 * of a dead brain; tool errors that keep repeating are code bugs.
 * @param {{reply?: string, meta?: any}} t
 */
export function noteTurn({ reply, meta } = {}) {
  if (!ENABLED()) return
  const failed = reply === FALLBACK_REPLY || (meta?.isError && !meta?.tools?.length) ||
    /^timeout after/.test(String(meta?.error ?? ''))
  if (failed) {
    fallbackStreak++
    if (fallbackStreak >= BRAIN_STREAK) {
      reportIssue({
        code: 'JRV-BRAIN-001', source: 'speech', key: 'brain:fallback',
        message: `${fallbackStreak} turnos seguidos sin respuesta del modelo`,
        detail: [meta?.error, lastSessionStderr()].filter(Boolean).join('\n'),
        ctx: { model: meta?.model ?? null },
      })
    }
  } else {
    if (fallbackStreak >= BRAIN_STREAK) {
      const inc = getByKey('brain:fallback')
      if (inc && inc.status !== 'resolved') resolveIncident(inc.id, 'el cerebro volvió a responder')
    }
    fallbackStreak = 0
  }
  for (const e of meta?.toolErrors ?? []) {
    const s = String(e)
    const i = s.indexOf(':')
    const tool = (i > 0 ? s.slice(0, i) : 'tool').replace(/^mcp__\w+__/, '')
    const msg = i > 0 ? s.slice(i + 1).trim() : s
    if (isEnvironmentalToolError(msg)) continue
    reportIssue({
      code: 'JRV-TOOL-001', source: 'tool', key: `tool:${tool}:${normalizeErrorKey(msg)}`,
      message: `${tool}: ${msg}`.slice(0, 300), detail: msg, ctx: { tool },
    })
  }
}

let stderrGetter = () => ''
function lastSessionStderr() {
  try { return stderrGetter() } catch { return '' }
}

// ── probes ───────────────────────────────────────────────────────────────────

let lastCliProbe = 0

async function probeCli({ force = false } = {}) {
  const now = Date.now()
  if (!force && now - lastCliProbe < CLI_PROBE_MS) return null
  lastCliProbe = now
  const bin = process.env.JARVIS_CLAUDE_BIN || 'claude'
  const r = await sh(bin, ['--version'], 15000)
  if (r.ok && r.stdout.trim()) {
    const inc = getByKey('cli:broken')
    if (inc && !['resolved', 'ignored'].includes(inc.status)) resolveIncident(inc.id, `claude --version responde: ${r.stdout.trim()}`)
    return { ok: true, version: r.stdout.trim() }
  }
  const dump = await sh('coredumpctl', ['list', '--no-pager', '--since', '-30min'])
  reportIssue({
    code: 'JRV-CLI-001', source: 'probe', key: 'cli:broken',
    message: `\`${bin} --version\` falló (código ${r.code}${r.signal ? `, señal ${r.signal}` : ''})`,
    detail: [r.stderr.trim(), r.stdout.trim(), /claude/.test(dump.stdout) ? `coredumps:\n${dump.stdout.trim().split('\n').slice(-3).join('\n')}` : '']
      .filter(Boolean).join('\n') || '(sin salida)',
    ctx: { bin, path: process.env.PATH },
  })
  return { ok: false, code: r.code, signal: r.signal, stderr: r.stderr.trim() }
}

async function probeUnits() {
  const r = await sh('systemctl', ['--user', 'list-units', 'jarvis-*', 'claude-agenthub*', '--all', '--plain', '--no-legend', '--no-pager'])
  if (!r.ok && !r.stdout) return []
  const units = parseUnits(r.stdout)
  const out = []
  for (const u of units) {
    if (u.name === 'jarvis-backend') continue // that's us
    // Only `failed` counts. `inactive` is what a deliberate `systemctl stop`
    // leaves behind, and restarting something the owner just stopped is a bug.
    const key = `svc:${u.unit}`
    if (u.active === 'failed') {
      const tail = await journalTail(u.unit)
      reportIssue({
        code: 'JRV-SVC-001', source: 'probe', key,
        message: `${u.unit} está en estado failed`,
        detail: tail, ctx: { unit: u.unit },
      })
      out.push({ unit: u.unit, state: 'failed' })
    } else {
      // Not failed = healthy. Not only `active`: a oneshot run by a timer goes
      // back to `inactive` after a clean run, and its incident stayed open forever.
      const inc = getByKey(key)
      if (inc && !['resolved', 'ignored'].includes(inc.status)) resolveIncident(inc.id, `${u.unit} ya no está en failed (${u.active})`)
    }
  }
  return out
}

async function probeStt() {
  const base = process.env.STT_URL || 'http://localhost:8790'
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
    if (res.ok) {
      const inc = getByKey('stt:down')
      if (inc && !['resolved', 'ignored'].includes(inc.status)) resolveIncident(inc.id, 'STT responde')
      return true
    }
    throw new Error(`HTTP ${res.status}`)
  } catch (e) {
    // Only an incident if systemd thinks it should be up — otherwise the unit
    // probe already reports the real state.
    const st = await sh('systemctl', ['--user', 'is-active', 'jarvis-stt'])
    if (st.stdout.trim() === 'active') {
      reportIssue({
        code: 'JRV-STT-001', source: 'probe', key: 'stt:down',
        message: `jarvis-stt está activo pero ${base}/health no responde`,
        detail: `${e?.message}\n${await journalTail('jarvis-stt.service', 6)}`,
      })
    }
    return false
  }
}

/**
 * One full diagnosis. Reports anything wrong through the bus (which runs the
 * remedies) and returns a summary for the voice / the HTTP caller.
 */
export async function runDiagnosis({ cli = false } = {}) {
  const [units, stt, cliRes] = await Promise.all([
    probeUnits().catch(() => []),
    probeStt().catch(() => false),
    probeCli({ force: cli }).catch(() => null),
  ])
  // Let the bus handlers persist what the probes just reported.
  await new Promise((r) => setTimeout(r, 50))
  return {
    ok: true,
    services: units,
    stt: stt ? 'ok' : 'caído',
    cli: cliRes,
    brainFallbackStreak: fallbackStreak,
    open: listIncidents({ open: true, limit: 10 }).map(summarize),
  }
}

/** Compact, voice-friendly view of an incident. */
export function summarize(inc) {
  return {
    id: inc.id, code: inc.code, title: inc.title, message: inc.message, status: inc.status,
    count: inc.count, last: new Date(inc.lastTs).toISOString(), jobId: inc.jobId,
    lastAction: inc.actions?.[inc.actions.length - 1] ?? null,
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────

let timer = null

/**
 * Wire the bus, install the process-level handlers and arm the probe loop.
 * `opts.sessionStderr` returns the last Claude-session stderr tail.
 */
export function startSelfHeal({ sessionStderr } = {}) {
  if (!ENABLED() || timer) return
  if (sessionStderr) stderrGetter = sessionStderr
  onIssue((rec) => { handleIssue(rec).catch((e) => console.warn('[selfheal] handle failed —', e?.message)) })

  // A crash used to leave nothing but the default Node trace in journald. Now
  // it is persisted (synchronously — the process is about to die) so the next
  // boot can pick it up and, if the stack is ours, fix it.
  process.on('uncaughtException', (err) => {
    try {
      upsert({
        code: 'JRV-EXC-001', source: 'process',
        key: `exc:${normalizeErrorKey(err?.message)}`,
        message: String(err?.message || err).slice(0, 300),
        detail: String(err?.stack || err),
      })
    } catch {}
    console.error('[selfheal] uncaughtException —', err?.stack || err)
    process.exit(1)
  })
  // Unlike a throw, a lost rejection doesn't corrupt the stack we're on, so
  // staying alive (and reporting it) beats taking the whole voice down.
  process.on('unhandledRejection', (reason) => {
    console.error('[selfheal] unhandledRejection —', reason?.stack || reason)
    reportIssue({
      code: 'JRV-EXC-002', source: 'process',
      key: `rej:${normalizeErrorKey(reason?.message ?? reason)}`,
      message: String(reason?.message ?? reason).slice(0, 300),
      detail: String(reason?.stack ?? reason),
    })
  })

  // Crash from the previous life: the incident was written, but nothing could
  // be done before exit. Do it now that we're up.
  setTimeout(() => {
    for (const inc of listIncidents({ open: true, limit: 20 })) {
      if (inc.code === 'JRV-EXC-001' && inc.status === 'open' && Date.now() - inc.lastTs < 3600e3) {
        notify(inc, 'el backend se reinició tras el fallo').catch(() => {})
        maybeAutoFix(inc).catch(() => {})
      }
    }
    runDiagnosis({ cli: true }).catch(() => {})
  }, 30000).unref?.()

  timer = setInterval(() => { runDiagnosis().catch(() => {}) }, PROBE_MS())
  timer.unref?.()
  console.log(`[selfheal] armado: sondeo cada ${Math.round(PROBE_MS() / 60e3)} min, arreglo de código=${CODE_MODE()}`)
}

export function stopSelfHeal() {
  if (timer) clearInterval(timer)
  timer = null
}
