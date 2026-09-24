/**
 * Contract for the remote-safe agents door (/api/agents/control).
 *
 * The gate that matters: exec/file ops must NOT be forwarded to the hub unless
 * JARVIS_AGENTS_REMOTE_EXEC is set, because this route — unlike /api/agents/rpc
 * — is reachable from the phone with just a web token.
 */
import { test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { execPath, cwd } from 'node:process'
import { setTimeout as delay } from 'timers/promises'

const BASE = 'http://127.0.0.1:8788'
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

async function control(body) {
  return fetch(`${BASE}/api/agents/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET /api/agents/list lists known machines with an online flag', async () => {
  const res = await fetch(`${BASE}/api/agents/list`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(Array.isArray(body.machines)).toBe(true)
  expect(['online', 'offline']).toContain(body.hub)
  expect(typeof body.execUnlocked).toBe('boolean')
  for (const m of body.machines) {
    expect(typeof m.name).toBe('string')
    expect(typeof m.online).toBe('boolean')
  }
})

test('exec is refused on the remote-safe route by default', async () => {
  const res = await control({ machine: 'main', op: { op: 'exec', params: { command: 'whoami', args: [], stream: false } } })
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toBe('op_not_allowed')
  expect(body.op).toBe('exec')
})

test('write_file and read_file are refused too', async () => {
  for (const op of ['read_file', 'write_file']) {
    const res = await control({ machine: 'main', op: { op } })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('op_not_allowed')
  }
})

test('a read-only op is forwarded (result depends on the machine being up)', async () => {
  const res = await control({ machine: 'main', op: { op: 'sys_info' } })
  // 200 with an envelope when the hub answers, 502 when the hub is down —
  // never a 403, which would mean the allowlist rejected a safe op.
  expect([200, 502]).toContain(res.status)
  const body = await res.json()
  expect(typeof body.ok).toBe('boolean')
})

test('this laptop is listed as a machine and answers for itself', async () => {
  const list = await (await fetch(`${BASE}/api/agents/list`)).json()
  const local = list.machines.find((m) => m.local)
  // The hub only knows machines running an agent, so without this entry the
  // machine hosting Jarvis would be the one PC missing from the list.
  expect(local).toBeTruthy()
  expect(local.online).toBe(true)

  const res = await control({ machine: local.name, op: { op: 'sys_info' } })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.result.status).toBe('sys_info')
  expect(body.result.cpu_percent).toBeGreaterThanOrEqual(0)
  expect(body.result.cpu_percent).toBeLessThanOrEqual(100)
  expect(body.result.mem_total_mb).toBeGreaterThan(0)
})

test('the local machine refuses exec like any other', async () => {
  const list = await (await fetch(`${BASE}/api/agents/list`)).json()
  const local = list.machines.find((m) => m.local)
  const res = await control({ machine: local.name, op: { op: 'exec', params: { command: 'whoami', args: [], stream: false } } })
  expect(res.status).toBe(403)
  expect((await res.json()).error).toBe('op_not_allowed')
})

test('malformed bodies are rejected before touching the hub', async () => {
  expect((await control({ machine: 'main' })).status).toBe(400)
  expect((await control({ op: { op: 'sys_info' } })).status).toBe(400)
})
