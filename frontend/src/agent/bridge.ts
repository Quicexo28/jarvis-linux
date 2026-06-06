// Frontend side of the agent bridge: a WebSocket client to the backend brain.
//
// The frontend OWNS execution — when the brain asks for a tool_call we run it
// through the local registry and reply with the result + a fresh snapshot. A
// turn resolves when the backend sends the matching 'final'. See bridge.js for
// the protocol.
import { getApiBase } from '../api/client'
import { executeCapability, toToolSchemas } from './registry'
import { buildSnapshot } from './snapshot'

const SESSION_ID = 'jarvis-core-main'
const READY_TIMEOUT_MS = 5000
const TURN_TIMEOUT_MS = 30000

type TurnResult = { ok: boolean; text: string }
type Pending = { resolve: (v: TurnResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

let ws: WebSocket | null = null
let ready = false
let readyPromise: Promise<void> | null = null
let seq = 0
const pendingTurns = new Map<string, Pending>()

function wsUrl(): string {
  // http://host:port -> ws://host:port, https -> wss
  const base = getApiBase().replace(/^http/i, 'ws')
  return `${base}/api/jarvis/agent/ws`
}

function safeParse(data: unknown): any | null {
  try { return JSON.parse(String(data)) } catch { return null }
}

function failAllTurns(reason: string): void {
  for (const p of pendingTurns.values()) { clearTimeout(p.timer); p.reject(new Error(reason)) }
  pendingTurns.clear()
}

function ensureConnected(): Promise<void> {
  if (ready && ws && ws.readyState === WebSocket.OPEN) return Promise.resolve()
  if (readyPromise) return readyPromise

  readyPromise = new Promise<void>((resolve, reject) => {
    let settled = false
    try { ws = new WebSocket(wsUrl()) } catch (err) { readyPromise = null; reject(err as Error); return }

    const timer = setTimeout(() => {
      if (!settled) { settled = true; readyPromise = null; reject(new Error('ws_timeout')) }
    }, READY_TIMEOUT_MS)

    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: 'hello', sessionId: SESSION_ID, tools: toToolSchemas(), snapshot: buildSnapshot() }))
    }
    ws.onmessage = (ev) => {
      const msg = safeParse(ev.data)
      if (!msg) return
      if (msg.type === 'ready') {
        ready = true
        if (!settled) { settled = true; clearTimeout(timer); resolve() }
        return
      }
      void handleServerMessage(msg)
    }
    ws.onclose = () => {
      ready = false; readyPromise = null; ws = null
      failAllTurns('ws_closed')
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error('ws_closed')) }
    }
    ws.onerror = () => { /* onclose handles cleanup */ }
  })

  return readyPromise
}

async function handleServerMessage(msg: any): Promise<void> {
  if (msg.type === 'tool_call') {
    const outcome = await executeCapability(msg.capId, msg.params ?? {})
    ws?.send(JSON.stringify({
      type: 'tool_result',
      id: msg.id,
      ok: outcome.ok,
      result: outcome.result,
      snapshot: outcome.snapshot,
    }))
    return
  }
  if (msg.type === 'final') {
    const p = pendingTurns.get(msg.turnId)
    if (!p) return
    clearTimeout(p.timer); pendingTurns.delete(msg.turnId)
    p.resolve({ ok: msg.ok !== false, text: msg.text ?? '' })
    return
  }
  if (msg.type === 'error' && msg.turnId) {
    const p = pendingTurns.get(msg.turnId)
    if (!p) return
    clearTimeout(p.timer); pendingTurns.delete(msg.turnId)
    p.resolve({ ok: false, text: String(msg.detail ?? 'Error del agente.') })
  }
}

// Send a natural-language turn to the brain and resolve with its spoken reply.
export async function sendTurnToBrain(message: string): Promise<TurnResult> {
  await ensureConnected()
  const turnId = `turn-${++seq}`
  return new Promise<TurnResult>((resolve, reject) => {
    const timer = setTimeout(() => { pendingTurns.delete(turnId); reject(new Error('turn_timeout')) }, TURN_TIMEOUT_MS)
    pendingTurns.set(turnId, { resolve, reject, timer })
    ws?.send(JSON.stringify({ type: 'turn', turnId, message, snapshot: buildSnapshot() }))
  })
}
