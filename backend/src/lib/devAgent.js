/**
 * Dev agent — Jarvis modifies its OWN source by DELEGATING the task to a full
 * Claude Code agent run inside the repo.
 *
 * Why a delegated agent instead of the voice brain editing files directly: the
 * voice session is haiku with a tiny thinking budget and a 30 s turn budget —
 * fine for calling a timer tool, useless for a real code change. This module
 * spawns the same agent the owner would use interactively (`claude --print
 * --dangerously-skip-permissions` with cwd = repo root), so it gets Read/Edit/
 * Write/Bash/Grep, reads CLAUDE.md itself, and can run the tests.
 *
 * Lifecycle of a job:
 *   1. git checkpoint (restore point BEFORE any edit)   -> selfCode.gitCheckpoint
 *   2. spawn the agent with the instruction on stdin    -> transcript to .log
 *   3. diff against the checkpoint                      -> which files changed
 *   4. apply: restart python services / rebuild Tauri + restart UI / restart backend
 *   5. notify (Telegram + renderer toast)
 *
 * The backend restart is LAST and goes through scheduleRestart (exit 99), never
 * `systemctl --user restart jarvis-backend`: the agent and this code both live
 * in the backend's cgroup, so a systemctl restart would kill the job mid-flight.
 * Same reason the agent is told not to restart the backend or the UI itself.
 *
 * Jobs are persisted to backend/data/dev-jobs/<id>.json BEFORE the restart, so
 * `code_task_status` still answers after the backend comes back.
 *
 * SECURITY: the spawned agent runs with --dangerously-skip-permissions, i.e.
 * full owner-level power over the machine. Reachable only through the
 * owner-gated + local-only /api/skills/code/* routes (see codeAuth.js).
 */

import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { runCommand, gitCheckpoint, scheduleRestart } from './selfCode.js'
import { getCodeDir } from './claudeCli.js'
import { notifyJarvis } from './cloudStorage.js'
import { requestClient as skillBusRequest, hasClient as skillBusHasClient } from './skillBus.js'

const __dir = dirname(fileURLToPath(import.meta.url))
// backend/src/lib -> repo root is three levels up.
const REPO_ROOT = resolve(__dir, '..', '..', '..')
const JOBS_DIR = join(REPO_ROOT, 'backend', 'data', 'dev-jobs')

const CLAUDE_CMD = process.platform === 'win32' ? 'claude.cmd' : 'claude'
const DEFAULT_MODEL = process['env']['JARVIS_DEV_MODEL'] || 'sonnet'
const JOB_TIMEOUT_MS = Number(process['env']['JARVIS_DEV_JOB_TIMEOUT_MS'] || 25 * 60 * 1000)
const BUILD_TIMEOUT_MS = Number(process['env']['JARVIS_DEV_BUILD_TIMEOUT_MS'] || 15 * 60 * 1000)
const MAX_LOG_TAIL = 4000
const FAKE = () => !!process['env']['JARVIS_FAKE_CLAUDE']

// Rules the delegated agent must follow. Appended to Claude Code's own system
// prompt (it keeps all its default coding behaviour + reads CLAUDE.md itself).
const DEV_SYSTEM_PROMPT = `Eres el agente de AUTODESARROLLO de Jarvis: modificas el código fuente del propio Jarvis por encargo hablado de su dueño (Santiago).

CONTEXTO
- El directorio de trabajo es el repositorio de Jarvis. Lee CLAUDE.md antes de tocar nada: documenta arquitectura, comandos y trampas conocidas.
- Ya se tomó un checkpoint de git ANTES de tu ejecución, así que puedes editar con confianza: revertir es trivial.

REGLAS DURAS
1. NO ejecutes git push, git reset --hard, git checkout de otra rama, ni borres commits. Commit local sí, si el cambio lo merece.
2. NO toques secretos ni credenciales: backend/data/secrets.local.json, *.enc, tokens, claves. Si el cambio los necesita, para y dilo en el resumen.
3. NO reinicies jarvis-backend ni jarvis-ui, y NO ejecutes el build de Tauri: corres DENTRO del cgroup del backend y te matarías a mitad. El sistema aplica los cambios (build + restart) automáticamente cuando termines. Sí puedes reiniciar jarvis-stt, jarvis-tts y jarvis-wake si tu cambio los toca.
4. Cambio mínimo que resuelva lo pedido. Iguala el estilo del archivo. No refactorices de paso lo que no te pidieron.
5. VERIFICA antes de terminar: corre los tests del área que tocaste (backend: cd backend && npm test; frontend: cd frontend && npm test). Si fallan por tu cambio, arréglalo. Si no hay test que cubra lo que hiciste y el cambio es lógica no trivial, añade uno.
6. Si la petición es ambigua o imposible, NO inventes: haz la interpretación más razonable y dilo, o no cambies nada y explica qué falta.

SALIDA (OBLIGATORIO)
Termina SIEMPRE tu último mensaje con una línea exactamente así:
RESUMEN: <una frase en español, máximo 200 caracteres, que se leerá EN VOZ ALTA al señor>
Esa frase describe qué cambiaste y si quedó verificado. Sin rutas de archivo, sin símbolos, sin markdown: se pronuncia tal cual.`

// --- job registry ------------------------------------------------------------

/** @type {{ id: string, proc: import('child_process').ChildProcess|null, timer: any }|null} */
let active = null

function ensureJobsDir() {
  try { mkdirSync(JOBS_DIR, { recursive: true }) } catch {}
}

function jobPath(id) { return join(JOBS_DIR, `${id}.json`) }
function logPath(id) { return join(JOBS_DIR, `${id}.log`) }

function newJobId() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

function writeJob(rec) {
  ensureJobsDir()
  try { writeFileSync(jobPath(rec.id), JSON.stringify(rec, null, 2), 'utf-8') } catch {}
  return rec
}

function appendLog(id, text) {
  ensureJobsDir()
  try { appendFileSync(logPath(id), text, 'utf-8') } catch {}
}

/** Read a job record from disk (survives the backend restart the job triggers). */
export function getDevJob(id) {
  try {
    const rec = JSON.parse(readFileSync(jobPath(id), 'utf-8'))
    return rec
  } catch {
    return null
  }
}

/** Most recent jobs, newest first. */
export function listDevJobs(limit = 10) {
  ensureJobsDir()
  let files = []
  try {
    files = readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit)
  } catch {}
  return files.map((f) => {
    try { return JSON.parse(readFileSync(join(JOBS_DIR, f), 'utf-8')) } catch { return null }
  }).filter(Boolean)
}

/** The job currently running in THIS process, if any. */
export function getActiveJob() {
  if (!active) return null
  return getDevJob(active.id)
}

/** Tail of a job's transcript log, for debugging a failed run. */
export function getDevJobLog(id, chars = MAX_LOG_TAIL) {
  try {
    const s = readFileSync(logPath(id), 'utf-8')
    return s.length > chars ? s.slice(-chars) : s
  } catch {
    return ''
  }
}

// --- result parsing ----------------------------------------------------------

/**
 * Pull the spoken one-liner out of the agent's final message.
 * Exported for tests.
 */
export function extractSummary(resultText) {
  const text = String(resultText || '').trim()
  if (!text) return ''
  const m = text.match(/^RESUMEN:\s*(.+)$/im)
  if (m) return m[1].trim().slice(0, 300)
  // No marker (agent ignored the contract): use the last non-empty line.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] || ''
  return last.replace(/[*_`#>]/g, '').slice(0, 300)
}

/**
 * Map changed repo paths to the follow-up actions needed to apply them.
 * Mirrors the "Relaunching after updates" table in CLAUDE.md.
 * Exported for tests.
 *
 * @param {string[]} files repo-relative paths
 * @returns {{ services: string[], buildFrontend: boolean, restartBackend: boolean, daemonReload: boolean, npmInstall: boolean }}
 */
export function planApply(files) {
  const plan = {
    services: [],
    buildFrontend: false,
    restartBackend: false,
    daemonReload: false,
    npmInstall: false,
  }
  const addService = (s) => { if (!plan.services.includes(s)) plan.services.push(s) }

  for (const raw of files) {
    const f = String(raw || '').replace(/\\/g, '/').trim()
    if (!f) continue

    if (f.startsWith('backend/voice/python/')) {
      if (f.includes('stt_service')) addService('jarvis-stt')
      else if (f.includes('xtts_service') || f.includes('tts_service')) addService('jarvis-tts')
      else if (f.includes('wake_service')) addService('jarvis-wake')
      else if (f.endsWith('requirements.txt')) { addService('jarvis-stt'); addService('jarvis-tts') }
      // speaker_id.py and other shared modules are imported by the STT service.
      else addService('jarvis-stt')
      continue
    }
    if (f.startsWith('frontend/')) {
      // Tauri binary embeds the built frontend: any source/config change needs a rebuild.
      if (f.startsWith('frontend/src') || f.startsWith('frontend/package') ||
          f.startsWith('frontend/vite') || f.startsWith('frontend/index.html') ||
          f.startsWith('frontend/tsconfig')) {
        plan.buildFrontend = true
      }
      continue
    }
    if (f.startsWith('backend/')) {
      // Data files (job records, tokens, reminders) are runtime state, not code.
      if (f.startsWith('backend/data/')) continue
      if (f.startsWith('backend/tests/')) continue
      if (f.endsWith('package.json') || f.endsWith('package-lock.json')) plan.npmInstall = true
      plan.restartBackend = true
      continue
    }
    if (f.startsWith('scripts/linux/') && f.endsWith('.service')) {
      plan.daemonReload = true
      continue
    }
  }
  return plan
}

// --- git helpers -------------------------------------------------------------

async function changedSince(sha) {
  const tracked = await runCommand({ command: `git diff --name-only ${sha}`, cwd: REPO_ROOT, timeoutMs: 60_000 })
  const untracked = await runCommand({ command: 'git ls-files --others --exclude-standard', cwd: REPO_ROOT, timeoutMs: 60_000 })
  const out = new Set()
  for (const chunk of [tracked.stdout, untracked.stdout]) {
    for (const line of String(chunk || '').split('\n')) {
      const f = line.trim()
      if (f) out.add(f)
    }
  }
  return [...out]
}

// --- apply -------------------------------------------------------------------

async function applyChanges(rec) {
  const plan = planApply(rec.changedFiles || [])
  const done = []

  if (plan.daemonReload) {
    await runCommand({ command: 'systemctl --user daemon-reload', cwd: REPO_ROOT, timeoutMs: 60_000 })
    done.push('daemon-reload')
  }
  for (const svc of plan.services) {
    const r = await runCommand({ command: `systemctl --user restart ${svc}`, cwd: REPO_ROOT, timeoutMs: 120_000 })
    done.push(`${svc}:${r.ok ? 'ok' : 'fail'}`)
  }
  if (plan.buildFrontend) {
    // Assets are embedded in the Tauri binary — build BEFORE restarting the UI or
    // the restarted process serves stale code (CLAUDE.md).
    const build = await runCommand({
      command: 'npm run tauri:build -- --no-bundle',
      cwd: join(REPO_ROOT, 'frontend'),
      timeoutMs: BUILD_TIMEOUT_MS,
    })
    done.push(`tauri-build:${build.ok ? 'ok' : 'fail'}`)
    if (!build.ok) {
      rec.applyError = `tauri build failed: ${(build.stderr || build.stdout || '').slice(-800)}`
    } else {
      const r = await runCommand({ command: 'systemctl --user restart jarvis-ui', cwd: REPO_ROOT, timeoutMs: 120_000 })
      done.push(`jarvis-ui:${r.ok ? 'ok' : 'fail'}`)
    }
  }
  if (plan.npmInstall) {
    const r = await runCommand({ command: 'npm install', cwd: join(REPO_ROOT, 'backend'), timeoutMs: BUILD_TIMEOUT_MS })
    done.push(`npm-install:${r.ok ? 'ok' : 'fail'}`)
  }

  rec.applied = done
  rec.restartPending = plan.restartBackend
  return plan
}

async function announce(text) {
  notifyJarvis(text).catch(() => {})
  if (skillBusHasClient()) {
    try { await skillBusRequest('notify', { text: text.slice(0, 200) }, 5000) } catch {}
  }
}

// --- runner ------------------------------------------------------------------

function spawnAgent(rec) {
  return new Promise((resolvePromise) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model', rec.model,
      '--append-system-prompt', DEV_SYSTEM_PROMPT,
    ]
    // shell:false — the system prompt contains quotes/newlines that a shell
    // would mangle. `claude` resolves via the systemd user PATH (mise shims).
    const proc = spawn(CLAUDE_CMD, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let buf = ''
    let resultText = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(payload)
    }

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch {}
      finish({ ok: false, error: 'timeout', resultText })
    }, JOB_TIMEOUT_MS)

    proc.stdout.on('data', (d) => {
      const chunk = String(d)
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { appendLog(rec.id, line + '\n'); continue }
        // Condensed activity trail: tool calls + assistant text. Full JSON would
        // make the log unreadable for a human debugging a failed run.
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text?.trim()) appendLog(rec.id, `\n[texto] ${block.text.trim()}\n`)
            else if (block.type === 'tool_use') appendLog(rec.id, `[tool] ${block.name} ${JSON.stringify(block.input).slice(0, 300)}\n`)
          }
        } else if (msg.type === 'result') {
          resultText = typeof msg.result === 'string' ? msg.result : ''
          appendLog(rec.id, `\n[result] is_error=${msg.is_error} turns=${msg.num_turns} cost=${msg.total_cost_usd}\n${resultText}\n`)
          if (msg.is_error) finish({ ok: false, error: 'agent_error', resultText })
        }
      }
    })

    proc.stderr.on('data', (d) => appendLog(rec.id, `[stderr] ${String(d)}`))

    try {
      proc.stdin.write(rec.instruction)
      proc.stdin.end()
    } catch {}

    proc.on('close', (code) => {
      finish(code === 0 ? { ok: true, resultText } : { ok: false, error: `exit_${code}`, resultText })
    })
    proc.on('error', (e) => finish({ ok: false, error: `spawn_failed: ${e?.message}`, resultText }))

    // The slot was reserved synchronously in startDevJob; fill in what cancel needs.
    // A cancel that landed while the checkpoint was still running has no process
    // to kill yet, so it just flags the slot — honour it now.
    if (active && active.id === rec.id) {
      active.proc = proc
      active.timer = timer
      if (active.cancelled) { try { proc.kill('SIGTERM') } catch {} }
    }
  })
}

async function runJob(rec) {
  try {
    const res = FAKE()
      ? { ok: true, resultText: 'RESUMEN: cambio simulado en modo de prueba.' }
      : await spawnAgent(rec)

    rec.summary = extractSummary(res.resultText)
    rec.changedFiles = await changedSince(rec.checkpoint)

    if (!res.ok) {
      rec.status = 'failed'
      rec.error = res.error
      rec.endedAt = new Date().toISOString()
      writeJob(rec)
      await announce(`⚠️ Autodesarrollo fallido (${rec.error}).\n${rec.instruction.slice(0, 200)}\n${rec.summary || ''}`)
      return rec
    }

    rec.status = 'applying'
    rec.endedAt = new Date().toISOString()
    writeJob(rec)

    if (rec.changedFiles.length) await applyChanges(rec)
    else rec.applied = []

    rec.status = rec.applyError ? 'failed' : 'done'
    writeJob(rec)

    const files = rec.changedFiles.length
    await announce(
      `🛠️ Autodesarrollo listo.\n${rec.summary || 'Sin resumen.'}\n` +
      `Archivos: ${files}. Aplicado: ${(rec.applied || []).join(', ') || 'nada que reiniciar'}` +
      (rec.applyError ? `\n❌ ${rec.applyError}` : '') +
      (rec.restartPending ? '\n🔄 Reiniciando backend…' : '')
    )

    // Backend restart LAST: it kills this process (systemd Restart=on-failure
    // brings it back). The record is already on disk, so status survives.
    if (rec.restartPending && !FAKE()) scheduleRestart(1500)
    return rec
  } catch (e) {
    rec.status = 'failed'
    rec.error = String(e?.message || e)
    rec.endedAt = new Date().toISOString()
    writeJob(rec)
    await announce(`⚠️ Autodesarrollo fallido: ${rec.error}`)
    return rec
  } finally {
    active = null
  }
}

/**
 * Start a self-coding job. Returns as soon as the agent is launched — the work
 * happens in the background and is announced when it finishes.
 *
 * @param {{ instruction: string, model?: string, requestedBy?: string }} opts
 */
export async function startDevJob({ instruction, model, requestedBy } = {}) {
  const text = String(instruction || '').trim()
  if (!text) return { ok: false, error: 'empty_instruction', spoken: 'No entendí qué debo cambiar en mi código, señor.' }
  if (active) {
    return {
      ok: false, error: 'job_running', jobId: active.id,
      spoken: 'Ya estoy trabajando en otro cambio de mi código, señor. Déjeme terminarlo primero.',
    }
  }

  // Reserve the single-job slot SYNCHRONOUSLY: the checkpoint below awaits, and
  // two voice turns arriving in that window would otherwise both pass the check
  // above and end up with two agents editing the repo at once.
  const id = newJobId()
  active = { id, proc: null, timer: null }

  const cp = await gitCheckpoint({ message: `pre self-code: ${text.slice(0, 60)}` })
  if (!cp.ok) {
    active = null
    return { ok: false, error: cp.error, spoken: 'No pude crear un punto de restauración, señor. No voy a tocar el código sin él.' }
  }

  const rec = {
    id,
    instruction: text,
    model: model || DEFAULT_MODEL,
    requestedBy: requestedBy || 'voz',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    checkpoint: cp.sha,
    branch: cp.branch,
    repo: getCodeDir() || REPO_ROOT,
    summary: '',
    changedFiles: [],
    applied: [],
    error: null,
  }
  writeJob(rec)
  appendLog(rec.id, `# ${rec.startedAt} model=${rec.model} checkpoint=${rec.checkpoint}\n# ${text}\n`)

  // Fire and forget: the HTTP caller (and the voice turn) must not block for
  // minutes. Completion is announced via Telegram + renderer toast.
  runJob(rec).catch(() => {})

  return {
    ok: true,
    jobId: rec.id,
    checkpoint: rec.checkpoint,
    model: rec.model,
    spoken: 'Me pongo con ello, señor. Le aviso en cuanto termine y lo deje aplicado.',
  }
}

/** Kill the running job. The checkpoint stays, so a rollback is still possible. */
export function cancelDevJob() {
  if (!active) return { ok: false, error: 'no_active_job', spoken: 'No hay ningún cambio de código en curso, señor.' }
  const id = active.id
  active.cancelled = true
  try { active.proc?.kill('SIGTERM') } catch {}
  return { ok: true, jobId: id, spoken: 'Cambio de código cancelado, señor.' }
}
