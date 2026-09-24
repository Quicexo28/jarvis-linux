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
import { readFileSync } from 'node:fs'
import { json, readBody } from '../lib/http.js'
import { notifyJarvis } from '../lib/cloudStorage.js'
import { LOCAL_OPS, localMachineEntry, localMachineName, localOp } from '../lib/localAgent.js'

const HUB_CONTROL = env.HUB_CONTROL_URL ?? 'http://127.0.0.1:8795'
const TOKENS_FILE = new URL('../../data/agent-tokens.json', import.meta.url)

/**
 * Ops the remote app (phone/tablet, token-authenticated) may run through
 * /api/agents/control. Read-only introspection plus Wake-on-LAN: none of them
 * can run code or move bytes off the remote machine.
 */
const REMOTE_SAFE_OPS = new Set(['sys_info', 'list_processes', 'search', 'wake'])
/** Only reachable remotely when JARVIS_AGENTS_REMOTE_EXEC=1 (opt-in). */
const REMOTE_POWER_OPS = new Set(['exec', 'read_file', 'write_file'])

/** True when the operator deliberately unlocked remote exec/file ops. */
export function remoteExecUnlocked() {
  return env.JARVIS_AGENTS_REMOTE_EXEC === '1'
}

async function hubFetch(path, init) {
  const res = await fetch(`${HUB_CONTROL}${path}`, init)
  if (!res.ok) throw new Error(`hub ${res.status}`)
  return res.json()
}

/**
 * Machines that have a token issued, whether or not they are connected now.
 * The hub only knows about live links, but an OFFLINE machine is exactly the
 * one the UI must still list (to Wake-on-LAN it).
 */
function knownMachineNames() {
  try {
    return Object.keys(JSON.parse(readFileSync(TOKENS_FILE, 'utf8')))
  } catch {
    return []
  }
}

/**
 * GET /api/agents/list — every known machine, connected or not.
 * Connected ones carry the hub's metadata (os, version, capabilities) plus
 * `online: true`; known-but-offline ones are stubs so the UI can offer wake.
 * The laptop itself leads the list (`local: true`): it hosts the hub, so it
 * never appears as an agent, but it is the machine the user asks about first.
 */
export async function handleAgentsList(_req, res) {
  let connected = []
  let hub = 'online'
  let detail
  try {
    const data = await hubFetch('/machines')
    connected = Array.isArray(data.machines) ? data.machines : []
  } catch (e) {
    // Hub down = no agents reachable, not a server error.
    hub = 'offline'
    detail = e.message
  }
  const online = new Set(connected.map((m) => m.name))
  const offline = knownMachineNames()
    .filter((name) => !online.has(name))
    .map((name) => ({ name, os: null, agent_version: null, capabilities: [], online: false }))
  // A real agent with the laptop's own name (unlikely, but possible) wins:
  // it is a live link, and two cards with one name would be unusable.
  const local = online.has(localMachineName()) ? [] : [localMachineEntry()]
  const machines = [...local, ...connected.map((m) => ({ ...m, online: true, local: false })), ...offline]
  return json(res, 200, { ok: true, machines, hub, execUnlocked: remoteExecUnlocked(), ...(detail ? { detail } : {}) })
}

/**
 * True when `machine` is this laptop and no agent is impersonating its name.
 * Checked against the live hub rather than assumed, so a real agent link always
 * wins over the in-process shim.
 */
async function servedLocally(machine) {
  if (machine !== localMachineName()) return false
  try {
    const data = await hubFetch('/machines')
    return !(data.machines ?? []).some((m) => m.name === machine)
  } catch {
    return true // hub down: the laptop is still right here.
  }
}

/**
 * Run one typed op on a machine through the hub and return its envelope
 * ({ ok: true, result } | { ok: false, error }). Shared by the HTTP route below
 * and by backend-side skills that drive a remote machine (e.g. rgb_*), so those
 * don't have to loop back through localhost HTTP.
 */
export async function agentRpc(machine, op) {
  return hubFetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine, op }),
  })
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
    if (await servedLocally(body.machine)) {
      return json(res, 200, { ok: true, result: await localOp(body.op) })
    }
    const data = await agentRpc(body.machine, body.op)
    return json(res, 200, data)
  } catch (e) {
    return json(res, 502, { ok: false, error: 'hub_unreachable', detail: e.message })
  }
}

/**
 * POST /api/agents/control — the remote-safe door to the same hub.
 *
 * /api/agents/rpc stays local-only (webAuth DANGEROUS) because it can spawn
 * processes on another machine. This route is reachable from the phone app
 * with a valid web token but only forwards ops in REMOTE_SAFE_OPS; exec and
 * file ops need JARVIS_AGENTS_REMOTE_EXEC=1 on top of the token.
 * Body: { machine, op } — `op` is the protocol Op, plus the pseudo-op
 * { op: 'wake' } which maps to the hub's Wake-on-LAN route.
 */
export async function handleAgentsControl(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' })
  }
  const machine = body?.machine
  const name = body?.op?.op
  if (!machine || !name) {
    return json(res, 400, { ok: false, error: 'machine_and_op_required' })
  }
  const allowed = REMOTE_SAFE_OPS.has(name) || (remoteExecUnlocked() && REMOTE_POWER_OPS.has(name))
  if (!allowed) {
    return json(res, 403, { ok: false, error: 'op_not_allowed', op: name })
  }
  try {
    if (await servedLocally(machine)) {
      // The laptop answers for itself; LOCAL_OPS is a subset of the remote-safe
      // allowlist, so anything else comes back as an error result, not an exec.
      if (!LOCAL_OPS.has(name)) {
        return json(res, 403, { ok: false, error: 'op_not_allowed', op: name })
      }
      return json(res, 200, { ok: true, result: await localOp(body.op) })
    }
    if (name === 'wake') {
      const data = await hubFetch('/wake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machine }),
      })
      return json(res, 200, data)
    }
    return json(res, 200, await agentRpc(machine, body.op))
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
