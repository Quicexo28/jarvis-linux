// Agent bridge: the duplex link between the frontend (which owns app truth and
// executes capabilities) and the backend brain (which decides what to do).
//
// Protocol over the WebSocket at /api/jarvis/agent/ws:
//   frontend -> backend
//     { type:'hello', sessionId, tools, snapshot }     announce dynamic registry
//     { type:'turn',  turnId, message, snapshot }       a user utterance
//     { type:'tool_result', id, ok, result, snapshot }  result of a tool_call
//   backend -> frontend
//     { type:'ready', sessionId, toolCount }
//     { type:'tool_call', id, capId, params }           run a capability in the UI
//     { type:'final', turnId, ok, text }                spoken reply for the turn
//     { type:'error', turnId?, detail }

import { env } from 'node:process'
import { isWebSocketUpgrade, acceptUpgrade } from './ws.js'
import { createBrain } from './brain.js'

const AGENT_WS_PATH = '/api/jarvis/agent/ws'
const TOOL_TIMEOUT_MS = Number(env.JARVIS_TOOL_TIMEOUT_MS ?? 15000)

// Module-level handle so the /api/jarvis/agent/health route can report status.
let status = { brain: null, sessions: 0 }
export function getAgentStatus() {
  return { ok: true, brain: status.brain, sessions: status.sessions }
}

export function attachAgentBridge(server, brain = createBrain()) {
  const sessions = new Map()
  status = { brain: brain.name, get sessions() { return sessions.size } }

  // Single shared 'upgrade' listener lives in server.js; it delegates here.
  // Returns true if this bridge claimed the upgrade, false to let the caller
  // try other handlers (so we never destroy sockets meant for other paths).
  function handleUpgrade(req, socket) {
    const path = String(req.url ?? '').split('?')[0]
    if (path !== AGENT_WS_PATH || !isWebSocketUpgrade(req)) return false
    const conn = acceptUpgrade(req, socket)
    if (conn) registerConnection(conn)
    return true
  }

  function registerConnection(conn) {
    const session = { id: null, conn, tools: [], snapshot: {}, pending: new Map(), seq: 0 }

    conn.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      handleMessage(session, msg).catch((err) => {
        try { conn.send({ type: 'error', detail: String(err?.message ?? err) }) } catch {}
      })
    })

    conn.on('close', () => {
      for (const p of session.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('connection_closed'))
      }
      session.pending.clear()
      if (session.id && sessions.get(session.id) === session) sessions.delete(session.id)
    })
  }

  async function handleMessage(session, msg) {
    switch (msg?.type) {
      case 'hello': {
        session.id = msg.sessionId || `sess-${Math.random().toString(36).slice(2, 8)}`
        session.tools = Array.isArray(msg.tools) ? msg.tools : []
        session.snapshot = msg.snapshot ?? {}
        sessions.set(session.id, session)
        session.conn.send({ type: 'ready', sessionId: session.id, toolCount: session.tools.length })
        return
      }
      case 'turn': {
        if (msg.snapshot) session.snapshot = msg.snapshot
        const turnId = msg.turnId ?? `t-${++session.seq}`
        try {
          const result = await brain.runTurn({
            sessionId: session.id,
            message: String(msg.message ?? ''),
            snapshot: session.snapshot,
            tools: session.tools,
            callTool: (capId, params) => requestTool(session, capId, params),
          })
          session.conn.send({ type: 'final', turnId, ok: result?.ok !== false, text: result?.text ?? '' })
        } catch (err) {
          session.conn.send({ type: 'final', turnId, ok: false, text: `Error del cerebro: ${String(err?.message ?? err)}` })
        }
        return
      }
      case 'tool_result': {
        const pending = session.pending.get(msg.id)
        if (!pending) return
        clearTimeout(pending.timer)
        session.pending.delete(msg.id)
        if (msg.snapshot) session.snapshot = msg.snapshot
        pending.resolve({ ok: msg.ok !== false, result: msg.result, snapshot: msg.snapshot })
        return
      }
      default:
        return
    }
  }

  // Ask the frontend to execute one capability and await its result.
  function requestTool(session, capId, params) {
    return new Promise((resolve, reject) => {
      const id = `tc-${++session.seq}`
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new Error(`tool_timeout:${capId}`))
      }, TOOL_TIMEOUT_MS)
      session.pending.set(id, { resolve, reject, timer })
      session.conn.send({ type: 'tool_call', id, capId, params: params ?? {} })
    })
  }

  return { sessions, brain, handleUpgrade }
}
