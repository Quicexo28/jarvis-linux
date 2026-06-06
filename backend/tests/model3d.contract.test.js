import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { execPath, cwd, env } from 'node:process'
import { setTimeout as delay } from 'timers/promises'

const BASE = 'http://127.0.0.1:8788'
let proc

beforeAll(async () => {
  proc = spawn(execPath, ['src/server.js'], {
    cwd: cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
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

describe('POST /api/skills/model3d/show (smoke)', () => {
  it('returns 400 for missing kind', async () => {
    const res = await fetch(`${BASE}/api/skills/model3d/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'u', y: 'v', z: '0' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('invalid_kind')
  })

  it('returns 400 for invalid kind value', async () => {
    const res = await fetch(`${BASE}/api/skills/model3d/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'mesh' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('invalid_kind')
  })
})

describe('POST /api/skills/model3d/hide (smoke)', () => {
  it('responds with ok:true or no_client when UI is not connected', async () => {
    const res = await fetch(`${BASE}/api/skills/model3d/hide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    // Either ok:true (UI connected) or 503 no_client (no UI in test env) — both valid
    expect([200, 503]).toContain(res.status)
    const body = await res.json()
    expect(body).toHaveProperty('ok')
  })
})
