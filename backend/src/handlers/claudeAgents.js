/**
 * Puente con Agent Hub (~/Projects/Agent Hub, servicio `claude-agenthub`, :8796):
 * el centro de control de TODOS los agentes Claude Code del señor — los que abre
 * él en terminal y los que lanza Jarvis.
 *
 *   voz / MCP  ->  /api/skills/claude/*  ->  hub HTTP (loopback)
 *   hub        ->  POST /api/claude-agents/event  ->  voz y/o Telegram
 *
 * El hub es quien sabe de agentes; aquí solo se adapta al vocabulario de voz
 * (nombres de proyecto en vez de rutas, texto libre en vez de UUIDs) y se entrega
 * el aviso de "terminó" cuando el señor lo pidió. Sin pedirlo, Jarvis no avisa:
 * el resaltado del hub basta.
 *
 * Riesgo: launch/send ejecutan código (un agente con permisos), así que son
 * DESTRUCTIVE en toolRisk y local-only en webAuth, igual que code_task.
 */
import { env } from 'node:process'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { json, readBody } from '../lib/http.js'
import { notifyJarvis } from '../lib/cloudStorage.js'
import { hasClient, requestClient } from '../lib/skillBus.js'

const HUB = () => env.CLAUDE_HUB_URL ?? 'http://127.0.0.1:8796'
const PROJECTS_DIR = () => env.CLAUDE_HUB_PROJECTS_DIR ?? join(homedir(), 'Projects')

async function hubFetch(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${HUB()}${path}`, {
      method,
      // El hub exige este header en toda mutación (su defensa anti-CSRF).
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'x-agent-hub': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    const err = new Error('hub_unreachable')
    err.status = 502
    err.detail = `Agent Hub no responde en ${HUB()} (${e.message}). Arráncalo: systemctl --user start claude-agenthub`
    throw err
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `hub_${res.status}`)
    err.status = res.status
    err.candidates = data.candidates
    throw err
  }
  return data
}

function fail(res, e) {
  return json(res, e.status && e.status < 600 ? e.status : 500, {
    ok: false,
    error: e.message,
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.candidates ? { candidates: e.candidates } : {}),
  })
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')

/**
 * "jarvis", "app gym", "/home/…/x" → directorio real. La voz dice nombres, no rutas.
 * Busca en ~/Projects y en los directorios donde ya hubo agentes (el hub los conoce).
 * Exportada para tests.
 */
export function resolveProjectDir(name, known = [], projectsDir = PROJECTS_DIR()) {
  if (!name) return null
  if (isAbsolute(name)) return existsSync(name) ? name : null
  let dirs = []
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(projectsDir, d.name))
  } catch {}
  const all = [...new Set([...known, ...dirs])]
  const q = norm(name)
  if (!q) return null
  const base = (p) => norm(p.split('/').filter(Boolean).pop())
  return all.find((p) => base(p) === q)
    ?? all.find((p) => base(p).startsWith(q))
    ?? all.find((p) => base(p).includes(q))
    ?? null
}

/** GET /api/skills/claude/list — agentes activos (o todos con ?all=1) + uso de la cuenta. */
export async function handleClaudeList(req, res) {
  try {
    const all = new URL(req.url, 'http://x').searchParams.get('all') === '1'
    return json(res, 200, await hubFetch(`/api/agents?compact=1${all ? '&all=1' : ''}`))
  } catch (e) {
    return fail(res, e)
  }
}

/**
 * POST /api/skills/claude/launch
 * Body: { task, project?, cwd?, model?, permission_mode?, label?, notify? }
 */
export async function handleClaudeLaunch(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'invalid_json' }) }
  const task = String(body?.task ?? body?.prompt ?? '').trim()
  if (!task) return json(res, 400, { ok: false, error: 'missing_task' })
  try {
    const { projects = [] } = await hubFetch('/api/options')
    const cwd = resolveProjectDir(body.cwd ?? body.project, projects)
    if (!cwd) {
      return json(res, 400, {
        ok: false,
        error: 'project_not_found',
        detail: `No encontré el proyecto "${body.cwd ?? body.project ?? ''}". Proyectos conocidos: ${projects.map((p) => p.split('/').pop()).join(', ')}`,
      })
    }
    const data = await hubFetch('/api/agents/launch', {
      method: 'POST',
      body: {
        cwd,
        prompt: task,
        model: body.model || 'sonnet',
        permissionMode: body.permission_mode || 'auto',
        label: body.label || null,
        origin: 'jarvis',
        notify: !!body.notify,
      },
    })
    return json(res, 200, { ok: true, id: data.id, cwd, watched: data.watched })
  } catch (e) {
    return fail(res, e)
  }
}

/** Body: { agent } — id o texto libre ("el del login"). */
function agentPath(body, action) {
  const agent = String(body?.agent ?? body?.id ?? '').trim()
  if (!agent) return null
  return `/api/agents/${encodeURIComponent(agent)}/${action}`
}

/** POST /api/skills/claude/send — { agent, text }: mensaje a un agente (o reanuda uno cerrado). */
export async function handleClaudeSend(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'invalid_json' }) }
  const path = agentPath(body, 'send')
  if (!path || !String(body.text ?? '').trim()) return json(res, 400, { ok: false, error: 'agent_and_text_required' })
  try {
    return json(res, 200, await hubFetch(path, { method: 'POST', body: { text: body.text } }))
  } catch (e) {
    return fail(res, e)
  }
}

/** POST /api/skills/claude/stop — { agent }. Solo detiene agentes del hub. */
export async function handleClaudeStop(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'invalid_json' }) }
  const path = agentPath(body, 'stop')
  if (!path) return json(res, 400, { ok: false, error: 'agent_required' })
  try {
    const data = await hubFetch(path, { method: 'POST', body: {} })
    if (!data.ok) return json(res, 409, { ok: false, error: 'not_hub_agent', detail: 'Ese agente no lo lanzó el hub: hay que cerrarlo en su terminal.' })
    return json(res, 200, data)
  } catch (e) {
    return fail(res, e)
  }
}

/** POST /api/skills/claude/watch — { agent, via?: ['voice','telegram'] }: avisar al terminar. */
export async function handleClaudeWatch(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'invalid_json' }) }
  const agent = String(body?.agent ?? '').trim()
  if (!agent) return json(res, 400, { ok: false, error: 'agent_required' })
  try {
    return json(res, 200, await hubFetch('/api/watch', { method: 'POST', body: { query: agent, via: body.via } }))
  } catch (e) {
    return fail(res, e)
  }
}

/** POST /api/skills/claude/unwatch — { agent }. */
export async function handleClaudeUnwatch(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'invalid_json' }) }
  const agent = String(body?.agent ?? '').trim()
  if (!agent) return json(res, 400, { ok: false, error: 'agent_required' })
  try {
    return json(res, 200, await hubFetch('/api/watch/cancel', { method: 'POST', body: { query: agent } }))
  } catch (e) {
    return fail(res, e)
  }
}

/**
 * POST /api/skills/claude/open — { agent? }: abre el hub en una ventana app de
 * Chromium, directamente en ese agente si se indica.
 */
export async function handleClaudeOpen(req, res) {
  let body
  try { body = await readBody(req) } catch { body = {} }
  try {
    let hash = ''
    if (body?.agent) {
      const r = await hubFetch(`/api/agents/resolve?q=${encodeURIComponent(body.agent)}`)
      if (r.agent) hash = `#/${encodeURIComponent(r.agent.id)}`
    } else {
      await hubFetch('/api/health')
    }
    const browser = env.CLAUDE_HUB_BROWSER ?? 'chromium'
    const child = spawn(browser, [`--app=${HUB()}/${hash}`], { detached: true, stdio: 'ignore' })
    child.on('error', (e) => console.warn(`[claude-hub] no pude abrir ${browser}: ${e.message}`))
    child.unref()
    return json(res, 200, { ok: true, opened: `${HUB()}/${hash}` })
  } catch (e) {
    return fail(res, e)
  }
}

/** Primera frase útil del resumen, sin markdown, apta para decir en voz. Exportada para tests. */
export function spokenSummary(text, max = 170) {
  if (!text) return ''
  const plain = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const first = plain.match(/^.+?[.!?](\s|$)/)?.[0]?.trim() ?? plain
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

/**
 * POST /api/claude-agents/event — el hub avisa que terminó un agente vigilado.
 * Body: { id, title, status, project, summary, error, via: ['voice'|'telegram'] }
 */
export async function handleClaudeAgentEvent(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'invalid_json' }) }
  const title = String(body?.title ?? 'un agente').slice(0, 120)
  const failed = body?.status === 'error'
  const via = Array.isArray(body?.via) ? body.via : ['voice', 'telegram']
  const summary = spokenSummary(body?.error || body?.summary)
  const delivered = []

  if (via.includes('voice') && hasClient()) {
    const spoken = failed
      ? `Señor, el agente ${title} terminó con error. ${summary}`
      : `Señor, el agente ${title} terminó. ${summary}`
    try {
      await requestClient('speak_text', { text: spoken.slice(0, 590) })
      delivered.push('voice')
    } catch (e) {
      console.warn(`[claude-hub] aviso por voz falló: ${e.message}`)
    }
  }
  // Telegram también si la voz no pudo (interfaz dormida): el aviso no se pierde.
  if (via.includes('telegram') || !delivered.length) {
    const icon = failed ? '⚠️' : '🤖'
    const where = body?.project ? ` (${body.project})` : ''
    const ok = await notifyJarvis(`${icon} Agente terminado: ${title}${where}\n${String(body?.error || body?.summary || '').slice(0, 800)}`).catch(() => false)
    if (ok) delivered.push('telegram')
  }
  console.log(`[claude-hub] terminó "${title}" (${body?.status}) → ${delivered.join('+') || 'sin canal'}`)
  return json(res, 200, { ok: true, delivered })
}
