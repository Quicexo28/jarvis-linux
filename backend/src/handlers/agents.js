/**
 * Distributed-agents bridge (cerebro side).
 *
 * The Rust `hub` sidecar owns the WebSocket links to remote agents. This
 * handler is the thin HTTP seam between:
 *   - the LLM / MCP tools  ->  POST /api/agents/*  ->  hub control API (RPC)
 *   - the hub's proactive events  ->  POST /api/agents/event  ->  notifyJarvis
 *
 * The hub runs on localhost, so these calls never leave the machine; the
 * agent-facing security (per-agent tokens, allowlist, audit) lives in the hub
 * and the agents. Remote HTTP callers are already blocked by webAuth — these
 * routes are not on its remote allowlist.
 */
import { env } from 'node:process'
import { json, readBody } from '../lib/http.js'
import { notifyJarvis } from '../lib/cloudStorage.js'

const HUB_CONTROL = env.HUB_CONTROL_URL ?? 'http://127.0.0.1:8795'

async function hubFetch(path, init) {
  const res = await fetch(`${HUB_CONTROL}${path}`, init)
  if (!res.ok) throw new Error(`hub ${res.status}`)
  return res.json()
}

/** GET /api/agents/list — connected machines and their capabilities. */
export async function handleAgentsList(_req, res) {
  try {
    const data = await hubFetch('/machines')
    return json(res, 200, { ok: true, ...data })
  } catch (e) {
    // Hub down = no agents reachable, not a server error.
    return json(res, 200, { ok: true, machines: [], hub: 'offline', detail: e.message })
  }
}

/**
 * POST /api/agents/rpc — run one typed op on a machine.
 * Body: { machine, op } where op is the protocol Op (e.g.
 * { op: 'sys_info' } or { op: 'search', params: { query } }).
 */
export async function handleAgentRpc(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' })
  }
  if (!body?.machine || !body?.op) {
    return json(res, 400, { ok: false, error: 'machine_and_op_required' })
  }
  try {
    const data = await hubFetch('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine: body.machine, op: body.op }),
    })
    return json(res, 200, data)
  } catch (e) {
    return json(res, 502, { ok: false, error: 'hub_unreachable', detail: e.message })
  }
}

/**
 * POST /api/agents/wake — Wake-on-LAN a machine by its cached MACs. Forwards to
 * the hub, which broadcasts the magic packet on the LAN (does NOT route over
 * Tailscale — only wakes a machine on the laptop's own network).
 * Body: { machine }.
 */
export async function handleAgentWake(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' })
  }
  if (!body?.machine) {
    return json(res, 400, { ok: false, error: 'machine_required' })
  }
  try {
    const data = await hubFetch('/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine: body.machine }),
    })
    return json(res, 200, data)
  } catch (e) {
    return json(res, 502, { ok: false, error: 'hub_unreachable', detail: e.message })
  }
}

/**
 * POST /api/agents/event — the hub pushes connect/disconnect and watcher
 * events here; forward to the user through the existing Telegram path.
 * Loopback-only (the hub is local); webAuth bypasses local callers.
 */
export async function handleAgentEvent(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' })
  }
  const msg = typeof body?.message === 'string' ? body.message : null
  if (msg) {
    const icon = body.type === 'connected' ? '🟢'
      : body.type === 'disconnected' ? '🔴'
      : '📡'
    notifyJarvis(`${icon} ${msg}`).catch(() => {})
  }
  return json(res, 200, { ok: true })
}
