import { test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { execPath, cwd } from 'node:process'
import { setTimeout as delay } from 'timers/promises'

const BASE = 'http://127.0.0.1:8788'
let proc

beforeAll(async () => {
  proc = spawn(execPath, ['src/server.js'], {
    cwd: cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
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

test('GET /api/mobile/token returns token info shape', async () => {
  const res = await fetch(`${BASE}/api/mobile/token`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.token).toMatch(/^[0-9a-f]{32}$/)
  expect(body.lanUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:8788$/)
  expect(typeof body.expiresAt).toBe('number')
  expect(body.activated).toBe(false)
  expect(typeof body.qrUrl).toBe('string')
})

test('GET /api/mobile/token returns tailscaleUrl as null or http string', async () => {
  const res = await fetch(`${BASE}/api/mobile/token`)
  const body = await res.json()
  expect(body.tailscaleUrl === null || body.tailscaleUrl.startsWith('http://')).toBe(true)
})

test('POST /api/mobile/auth with valid token returns ok:true', async () => {
  const tokenRes = await fetch(`${BASE}/api/mobile/token`)
  const { token } = await tokenRes.json()
  const res = await fetch(`${BASE}/api/mobile/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(['tailscale', 'lan', null].includes(body.via)).toBe(true)
})

test('POST /api/mobile/auth with wrong token returns 401 invalid', async () => {
  const res = await fetch(`${BASE}/api/mobile/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrongtoken' }),
  })
  expect(res.status).toBe(401)
  const body = await res.json()
  expect(body.ok).toBe(false)
  expect(body.reason).toBe('invalid')
})

test('GET /api/mobile/status returns connected:true after auth', async () => {
  const tokenRes = await fetch(`${BASE}/api/mobile/token`)
  const { token } = await tokenRes.json()
  await fetch(`${BASE}/api/mobile/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const res = await fetch(`${BASE}/api/mobile/status`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.connected).toBe(true)
  expect(typeof body.lastSeen).toBe('number')
})

test('POST /api/mobile/token/refresh generates a new token', async () => {
  const first = await (await fetch(`${BASE}/api/mobile/token`)).json()
  await fetch(`${BASE}/api/mobile/token/refresh`, { method: 'POST' })
  const second = await (await fetch(`${BASE}/api/mobile/token`)).json()
  expect(second.token).not.toBe(first.token)
  expect(second.activated).toBe(false)
})
