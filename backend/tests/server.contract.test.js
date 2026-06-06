import { test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { execPath, cwd, env } from 'node:process'
import { setTimeout as delay } from 'timers/promises'

const BASE = 'http://127.0.0.1:8788'
let proc

beforeAll(async () => {
  proc = spawn(execPath, ['src/server.js'], {
    cwd: cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Don't spawn the real Claude CLI in contract tests — assert structure only.
    env: { ...env, JARVIS_FAKE_CLAUDE: '1' },
  })
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

test('GET /health returns ok status', async () => {
  const res = await fetch(`${BASE}/health`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({ status: 'ok', service: 'jarvis-backend' })
})

test('GET /modules returns the static module list', async () => {
  const res = await fetch(`${BASE}/modules`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.modules).toEqual(['tv', 'cloud', 'system', 'jarvis-turn', 'telemetry'])
})

test('OPTIONS request returns 200 with CORS headers', async () => {
  const res = await fetch(`${BASE}/health`, { method: 'OPTIONS' })
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
})

test('POST /api/jarvis/turn returns reply structure with no focus', async () => {
  const res = await fetch(`${BASE}/api/jarvis/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'hola', sessionId: 'test' }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(typeof body.reply).toBe('string')
  expect(Array.isArray(body.actions)).toBe(true)
  expect(body.uiHints).toBeDefined()
  expect(body.meta.sessionId).toBe('test')
})

test('POST /api/jarvis/turn with focused entity infers action from "apaga"', async () => {
  const res = await fetch(`${BASE}/api/jarvis/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'apaga',
      context: { focusedEntity: { id: 'e1', label: 'Lampara', skillName: 'light' } },
    }),
  })
  const body = await res.json()
  expect(body.actions.length).toBe(1)
  expect(body.actions[0]).toMatchObject({ type: 'device_action', targetId: 'e1', action: 'off' })
})

test('POST /api/jarvis/device-action echoes a queued action', async () => {
  const res = await fetch(`${BASE}/api/jarvis/device-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entityId: 'e1', label: 'TV', skillName: 'tv', action: 'on' }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.status).toBe('queued')
  expect(body.action).toMatchObject({ entityId: 'e1', label: 'TV', skillName: 'tv', action: 'on' })
})

test('GET on unknown route returns 404 with not_found', async () => {
  const res = await fetch(`${BASE}/this-does-not-exist`)
  expect(res.status).toBe(404)
  const body = await res.json()
  expect(body).toEqual({ ok: false, error: 'not_found' })
})

test('POST with malformed JSON to /api/jarvis/turn returns 400', async () => {
  const res = await fetch(`${BASE}/api/jarvis/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  })
  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.ok).toBe(false)
  expect(body.error).toBe('invalid_json')
})
