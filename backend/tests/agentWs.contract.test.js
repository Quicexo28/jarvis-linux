import { test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { execPath, cwd } from 'node:process'
import { setTimeout as delay } from 'timers/promises'

const BASE = 'http://127.0.0.1:8788'
const WS_URL = 'ws://127.0.0.1:8788/api/jarvis/agent/ws'
let proc

beforeAll(async () => {
  proc = spawn(execPath, ['src/server.js'], { cwd: cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error('server failed to boot in 4s')
})

afterAll(() => {
  if (proc && !proc.killed) proc.kill('SIGTERM')
})

test('GET /api/jarvis/agent/health reports the active brain', async () => {
  const res = await fetch(`${BASE}/api/jarvis/agent/health`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.brain).toBe('heuristic')
})

test('full WS turn: hello -> turn -> tool_call -> tool_result -> final', async () => {
  if (typeof WebSocket === 'undefined') {
    // Node < 21 has no global WebSocket; skip rather than fail.
    return
  }

  const toolCalls = []
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const timer = setTimeout(() => { try { ws.close() } catch {}; reject(new Error('ws_test_timeout')) }, 5000)

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'ready') {
        ws.send(JSON.stringify({ type: 'turn', turnId: 't1', message: 'abre el sistema', snapshot: {} }))
      } else if (msg.type === 'tool_call') {
        toolCalls.push(msg)
        ws.send(JSON.stringify({
          type: 'tool_result',
          id: msg.id,
          ok: true,
          result: { ok: true, detail: 'Abrí Sistema' },
          snapshot: { zoomedMode: 'system' },
        }))
      } else if (msg.type === 'final') {
        clearTimeout(timer)
        try { ws.close() } catch {}
        resolve({ final: msg, toolCalls })
      }
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'hello',
        sessionId: 'test-sess',
        tools: [{ name: 'nav.goto', description: 'navega', input_schema: { type: 'object', properties: {} } }],
        snapshot: {},
      }))
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws_error')) }
  })

  expect(result.toolCalls).toHaveLength(1)
  expect(result.toolCalls[0].capId).toBe('nav.goto')
  expect(result.toolCalls[0].params).toEqual({ mode: 'system' })
  expect(result.final.ok).toBe(true)
  expect(result.final.text).toMatch(/sistema/i)
})
