# Mobile QR Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a phone to connect to the Jarvis PC as a thin client by scanning a QR code shown in the System mode panel.

**Architecture:** Backend generates a one-time 10-minute token on startup; the QR encodes `http://<tailscale-or-lan-ip>:8788?token=<token>`. The phone opens that URL in a browser, the React app detects the token, calls `/api/mobile/auth`, stores the token in localStorage, and renders a simplified mobile UI (`MobileClient.tsx`). The desktop System panel shows the QR, a countdown, and active session info.

**Tech Stack:** Node ESM backend (existing), React + TypeScript + Vite + zustand frontend (existing), `qrcode` npm package for QR canvas rendering.

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `backend/src/state/mobileSession.js` | In-memory token + session state singleton |
| `backend/src/lib/tailscale.js` | `getTailscaleIp()` + `getLanIp()` |
| `backend/src/handlers/mobile.js` | 4 route handlers for `/api/mobile/*` |
| `backend/tests/mobile.contract.test.js` | Contract tests for mobile endpoints |
| `frontend/src/modes/MobileClient.tsx` | Full-screen phone UI |

### Modified files
| File | What changes |
|---|---|
| `backend/src/server.js` | Default HOST `0.0.0.0` (was `127.0.0.1`) |
| `backend/src/lib/http.js` | Add `Authorization` to CORS allowed headers |
| `backend/src/routes.js` | Register 4 new `/api/mobile/*` routes |
| `frontend/src/types.ts` | Add `'mobile'` to `Mode`; add `MobileTokenInfo`, `MobileStatus` types |
| `frontend/src/api/client.ts` | Add mobile token helpers + `Authorization` header in `request()` |
| `frontend/src/App.tsx` | Token detection on load — bypass boot — render mobile or expired screen |
| `frontend/src/AwakeApp.tsx` | Add "Conexion Movil" section in system panel (QR, countdown, status) |
| `frontend/package.json` | Add `qrcode` + `@types/qrcode` |

---

## Task 1: Backend — bind to 0.0.0.0 + fix CORS headers

**Files:**
- Modify: `backend/src/server.js:6`
- Modify: `backend/src/lib/http.js:6`

- [ ] **Step 1.1: Open `backend/src/server.js` and change the HOST default**

Replace line 6:
```js
const host = env.HOST ?? '0.0.0.0'
```

- [ ] **Step 1.2: Open `backend/src/lib/http.js` and add Authorization to allowed headers**

Replace line 6:
```js
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
```

- [ ] **Step 1.3: Verify existing tests still pass**

```bash
cd backend && npm test
```

Expected: all 9 tests pass. The HOST change does not break tests because the contract tests connect to `127.0.0.1:8788`, which a server bound to `0.0.0.0` still accepts.

- [ ] **Step 1.4: Commit**

```bash
git add backend/src/server.js backend/src/lib/http.js
git commit -m "feat(backend): bind to 0.0.0.0 and allow Authorization CORS header"
```

---

## Task 2: Backend — mobile session state

**Files:**
- Create: `backend/src/state/mobileSession.js`
- Create: `backend/tests/mobileSession.unit.test.js`

- [ ] **Step 2.1: Write the failing test**

Create `backend/tests/mobileSession.unit.test.js`:

```js
import { test, expect, beforeEach } from 'vitest'
import {
  getSession,
  activateSession,
  resetSession,
  isExpired,
} from '../src/state/mobileSession.js'

beforeEach(() => {
  resetSession()
})

test('getSession returns a token of 32 hex chars', () => {
  const s = getSession()
  expect(s.token).toMatch(/^[0-9a-f]{32}$/)
})

test('getSession returns activated=false and expiresAt ~10min from now', () => {
  const before = Date.now()
  const s = getSession()
  expect(s.activated).toBe(false)
  expect(s.expiresAt).toBeGreaterThan(before + 9 * 60 * 1000)
  expect(s.expiresAt).toBeLessThan(before + 11 * 60 * 1000)
})

test('isExpired returns false for a fresh session', () => {
  expect(isExpired()).toBe(false)
})

test('activateSession marks session activated with via and userAgent', () => {
  activateSession('Mozilla/5.0', 'tailscale')
  const s = getSession()
  expect(s.activated).toBe(true)
  expect(s.via).toBe('tailscale')
  expect(s.userAgent).toBe('Mozilla/5.0')
  expect(s.connectedAt).toBeGreaterThan(0)
})

test('isExpired returns false after activation even when expiresAt has passed', () => {
  activateSession('Mozilla/5.0', 'lan')
  getSession().expiresAt = Date.now() - 1
  expect(isExpired()).toBe(false)
})

test('resetSession generates a new token', () => {
  const first = getSession().token
  resetSession()
  const second = getSession().token
  expect(second).not.toBe(first)
  expect(second).toMatch(/^[0-9a-f]{32}$/)
})

test('resetSession clears activated state', () => {
  activateSession('ua', 'lan')
  resetSession()
  expect(getSession().activated).toBe(false)
})
```

- [ ] **Step 2.2: Run test to confirm it fails**

```bash
cd backend && npm test -- tests/mobileSession.unit.test.js
```

Expected: FAIL — `Cannot find module '../src/state/mobileSession.js'`

- [ ] **Step 2.3: Create `backend/src/state/mobileSession.js`**

```js
import { randomBytes } from 'crypto'

function freshSession() {
  return {
    token: randomBytes(16).toString('hex'),
    expiresAt: Date.now() + 10 * 60 * 1000,
    activated: false,
    connectedAt: null,
    lastSeen: null,
    userAgent: null,
    via: null,
  }
}

let session = freshSession()

export function getSession() { return session }

export function activateSession(userAgent, via) {
  session = { ...session, activated: true, connectedAt: Date.now(), lastSeen: Date.now(), userAgent, via }
}

export function resetSession() {
  session = freshSession()
}

export function isExpired() {
  return !session.activated && Date.now() > session.expiresAt
}
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
cd backend && npm test -- tests/mobileSession.unit.test.js
```

Expected: 7 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add backend/src/state/mobileSession.js backend/tests/mobileSession.unit.test.js
git commit -m "feat(backend): mobile session state with token lifecycle"
```

---

## Task 3: Backend — Tailscale + LAN IP detection

**Files:**
- Create: `backend/src/lib/tailscale.js`
- Create: `backend/tests/tailscale.unit.test.js`

- [ ] **Step 3.1: Write the failing test**

Create `backend/tests/tailscale.unit.test.js`:

```js
import { test, expect } from 'vitest'
import { getLanIp } from '../src/lib/tailscale.js'

test('getLanIp returns a non-loopback IPv4 address', () => {
  const ip = getLanIp()
  expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
  expect(ip).not.toBe('127.0.0.1')
})
```

- [ ] **Step 3.2: Run test to confirm it fails**

```bash
cd backend && npm test -- tests/tailscale.unit.test.js
```

Expected: FAIL — `Cannot find module '../src/lib/tailscale.js'`

- [ ] **Step 3.3: Create `backend/src/lib/tailscale.js`**

```js
import { execFile } from 'child_process'
import os from 'os'

export function getTailscaleIp() {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null)
      const ip = stdout.trim().split('\n')[0]
      resolve(ip || null)
    })
  })
}

export function getLanIp() {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}
```

- [ ] **Step 3.4: Run test to confirm it passes**

```bash
cd backend && npm test -- tests/tailscale.unit.test.js
```

Expected: 1 test passes.

- [ ] **Step 3.5: Commit**

```bash
git add backend/src/lib/tailscale.js backend/tests/tailscale.unit.test.js
git commit -m "feat(backend): Tailscale IP detection and LAN IP utility"
```

---

## Task 4: Backend — Mobile handlers + routes + contract tests

**Files:**
- Create: `backend/src/handlers/mobile.js`
- Create: `backend/tests/mobile.contract.test.js`
- Modify: `backend/src/routes.js`

- [ ] **Step 4.1: Write the failing contract tests**

Create `backend/tests/mobile.contract.test.js`:

```js
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
```

- [ ] **Step 4.2: Run tests to confirm they fail**

```bash
cd backend && npm test -- tests/mobile.contract.test.js
```

Expected: FAIL — routes return 404.

- [ ] **Step 4.3: Create `backend/src/handlers/mobile.js`**

Note: uses `import { env } from 'node:process'` to read PORT, consistent with `server.js` style.

```js
import { env } from 'node:process'
import { json, readBody } from '../lib/http.js'
import { getSession, activateSession, resetSession, isExpired } from '../state/mobileSession.js'
import { getTailscaleIp, getLanIp } from '../lib/tailscale.js'

const PORT = env.PORT ?? '8788'

export async function handleMobileToken(_req, res) {
  if (isExpired()) resetSession()
  const session = getSession()
  const tailscaleIp = await getTailscaleIp()
  const lanIp = getLanIp()
  const lanUrl = `http://${lanIp}:${PORT}`
  const tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${PORT}` : null
  const baseUrl = tailscaleUrl ?? lanUrl
  const qrUrl = `${baseUrl}?token=${session.token}`
  return json(res, 200, {
    token: session.token,
    lanUrl,
    tailscaleUrl,
    qrUrl,
    expiresAt: session.expiresAt,
    activated: session.activated,
  })
}

export async function handleMobileAuth(req, res) {
  try {
    const body = await readBody(req)
    const { token } = body
    const session = getSession()
    if (!token || token !== session.token) {
      return json(res, 401, { ok: false, reason: 'invalid' })
    }
    if (isExpired()) {
      return json(res, 401, { ok: false, reason: 'expired' })
    }
    const remoteIp = req.socket?.remoteAddress ?? ''
    const via = remoteIp.startsWith('100.') ? 'tailscale' : 'lan'
    activateSession(req.headers['user-agent'] ?? null, via)
    return json(res, 200, { ok: true, via })
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' })
  }
}

export function handleMobileStatus(_req, res) {
  const session = getSession()
  return json(res, 200, {
    connected: session.activated,
    lastSeen: session.lastSeen,
    via: session.via,
    userAgent: session.userAgent,
  })
}

export async function handleMobileRefresh(_req, res) {
  resetSession()
  return json(res, 200, { ok: true })
}
```

- [ ] **Step 4.4: Register routes in `backend/src/routes.js`**

Replace the entire file:

```js
import { json } from './lib/http.js'
import { handleHealth } from './handlers/health.js'
import { handleModules } from './handlers/modules.js'
import { handleDeviceAction, handleJarvisTurn } from './handlers/jarvis.js'
import { handleTelemetry } from './handlers/telemetry.js'
import {
  handleMobileToken,
  handleMobileAuth,
  handleMobileStatus,
  handleMobileRefresh,
} from './handlers/mobile.js'

export const routes = [
  { method: 'GET',  path: '/health',                   handler: handleHealth },
  { method: 'GET',  path: '/modules',                  handler: handleModules },
  { method: 'GET',  path: '/api/system/telemetry',     handler: handleTelemetry },
  { method: 'POST', path: '/api/jarvis/device-action', handler: handleDeviceAction },
  { method: 'POST', path: '/api/jarvis/turn',          handler: handleJarvisTurn },
  { method: 'GET',  path: '/api/mobile/token',         handler: handleMobileToken },
  { method: 'POST', path: '/api/mobile/auth',          handler: handleMobileAuth },
  { method: 'GET',  path: '/api/mobile/status',        handler: handleMobileStatus },
  { method: 'POST', path: '/api/mobile/token/refresh', handler: handleMobileRefresh },
]

export async function dispatch(req, res) {
  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true })
  }

  const match = routes.find((r) => r.method === req.method && r.path === req.url)
  if (!match) {
    return json(res, 404, { ok: false, error: 'not_found' })
  }

  return match.handler(req, res)
}
```

- [ ] **Step 4.5: Run all backend tests**

```bash
cd backend && npm test
```

Expected: all 23 tests pass (9 existing + 7 mobileSession + 1 tailscale + 6 mobile contract).

- [ ] **Step 4.6: Commit**

```bash
git add backend/src/handlers/mobile.js backend/src/routes.js backend/tests/mobile.contract.test.js
git commit -m "feat(backend): mobile auth endpoints (token, auth, status, refresh)"
```

---

## Task 5: Frontend — types + API client

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`
- Create: `frontend/src/api/client.test.ts`

- [ ] **Step 5.1: Write the failing tests**

Create `frontend/src/api/client.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest'
import { getMobileToken, setMobileToken, clearMobileToken } from './client'

beforeEach(() => {
  localStorage.clear()
})

test('getMobileToken returns null when nothing stored', () => {
  expect(getMobileToken()).toBeNull()
})

test('setMobileToken stores token and getMobileToken retrieves it', () => {
  setMobileToken('abc123')
  expect(getMobileToken()).toBe('abc123')
})

test('clearMobileToken removes stored token', () => {
  setMobileToken('abc123')
  clearMobileToken()
  expect(getMobileToken()).toBeNull()
})
```

- [ ] **Step 5.2: Run to confirm they fail**

```bash
cd frontend && npm test -- src/api/client.test.ts
```

Expected: FAIL — `getMobileToken is not exported from './client'`

- [ ] **Step 5.3: Update `frontend/src/types.ts`**

Replace with:

```ts
export type Mode = 'home' | 'house' | 'plan2d' | 'plan3d' | 'space' | 'cloud' | 'system' | 'mobile'
export type HoloMode = Exclude<Mode, 'plan2d' | 'plan3d' | 'space' | 'mobile'>
export type WallType = 'solid' | 'low'
export type Segment = { x1: number; y1: number; x2: number; y2: number; wallType?: WallType }
export type SavedPlan = { room: string; name: string; segments: Segment[]; updatedAt: string }
export type EntityCategory = 'furniture' | 'device'
export type EntityKind = 'sofa' | 'bed' | 'table' | 'tv' | 'lamp' | 'router' | 'camera' | 'switch' | 'sensor'
export type SceneEntity = {
  id: string; kind: EntityKind; category: EntityCategory
  x: number; y: number; z: number; rotY: number
  width: number; height: number; depth: number
  color: string; label: string
  skillName?: string; skillAction?: string; skillActions?: string[]
}
export type Viewpoint = { x: number; y: number; z: number; yawDeg: number }
export type SystemTelemetry = {
  host?: {
    cpu?: { usagePct?: number }
    gpu?: { avgUtilizationPct?: number }
    network?: { rxMbps?: number; txMbps?: number }
  }
  openclaw?: { codexTokensUsed?: number | null; codexTokensTotal?: number | null }
}
export type MobileTokenInfo = {
  token: string
  lanUrl: string
  tailscaleUrl: string | null
  qrUrl: string
  expiresAt: number
  activated: boolean
}
export type MobileStatus = {
  connected: boolean
  lastSeen: number | null
  via: 'tailscale' | 'lan' | null
  userAgent: string | null
}
```

- [ ] **Step 5.4: Update `frontend/src/api/client.ts`**

Replace with:

```ts
const STORAGE_KEY      = 'jarvis.api.base'
const MOBILE_TOKEN_KEY = 'jarvis.mobile.token'
const DEFAULT_BASE     = 'http://127.0.0.1:8788'

export function getApiBase(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  return (stored ?? DEFAULT_BASE).replace(/\/$/, '')
}

export function setApiBase(url: string): void {
  localStorage.setItem(STORAGE_KEY, url)
}

export function clearApiBase(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function getMobileToken(): string | null {
  return localStorage.getItem(MOBILE_TOKEN_KEY)
}

export function setMobileToken(token: string): void {
  localStorage.setItem(MOBILE_TOKEN_KEY, token)
}

export function clearMobileToken(): void {
  localStorage.removeItem(MOBILE_TOKEN_KEY)
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getMobileToken()
  const extraHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), ...extraHeaders },
  })
  return res.json() as Promise<T>
}
```

- [ ] **Step 5.5: Run tests**

```bash
cd frontend && npm test -- src/api/client.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5.6: Run the full frontend test suite**

```bash
cd frontend && npm test
```

Expected: all tests pass.

- [ ] **Step 5.7: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(frontend): mobile token helpers and Authorization header in request()"
```

---

## Task 6: Frontend — App.tsx token detection + mobile bypass

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/modes/MobileClient.tsx` (temporary stub — replaced in Task 7)

- [ ] **Step 6.1: Create a temporary stub for `frontend/src/modes/MobileClient.tsx`**

This is replaced in Task 7. The stub unblocks TypeScript compilation.

```tsx
export function MobileClient() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: '#050510', color: '#00e5ff', fontFamily: 'monospace' }}>
      Mobile — coming soon
    </div>
  )
}
```

- [ ] **Step 6.2: Replace `frontend/src/App.tsx`**

```tsx
import { useState, useEffect } from 'react'
import { useBootStore } from './state/bootStore'
import { DormantLayer } from './components/DormantLayer'
import { ListeningLayer } from './components/ListeningLayer'
import { RadialTransition } from './components/RadialTransition'
import { AwakeApp } from './AwakeApp'
import { MobileClient } from './modes/MobileClient'
import {
  getApiBase,
  setApiBase,
  setMobileToken,
  getMobileToken,
  clearMobileToken,
  clearApiBase,
} from './api/client'
import './App.css'

type MobileState = 'checking' | 'mobile' | 'expired' | 'desktop'

function hasMobileSignal(): boolean {
  const urlToken = new URLSearchParams(window.location.search).get('token')
  return !!(urlToken || localStorage.getItem('jarvis.mobile.token'))
}

export default function App() {
  const bootState   = useBootStore((s) => s.bootState)
  const silentWake  = useBootStore((s) => s.silentWake)
  const [transitionDone, setTransitionDone] = useState(false)
  const [awakeVisible, setAwakeVisible]     = useState(false)
  const [mobileState, setMobileState]       = useState<MobileState>(
    hasMobileSignal() ? 'checking' : 'desktop'
  )

  useEffect(() => {
    if (mobileState !== 'checking') return
    async function detect() {
      const urlToken    = new URLSearchParams(window.location.search).get('token')
      const storedToken = getMobileToken()
      const tokenToTry  = urlToken ?? storedToken
      if (!tokenToTry) { setMobileState('desktop'); return }

      if (urlToken) {
        setApiBase(window.location.origin)
        setMobileToken(urlToken)
        const url = new URL(window.location.href)
        url.searchParams.delete('token')
        window.history.replaceState({}, '', url.toString())
      }

      try {
        const res = await fetch(`${getApiBase()}/api/mobile/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tokenToTry }),
        })
        if (res.ok) {
          setMobileState('mobile')
        } else {
          clearMobileToken()
          clearApiBase()
          setMobileState(urlToken ? 'expired' : 'desktop')
        }
      } catch {
        clearMobileToken()
        clearApiBase()
        setMobileState('desktop')
      }
    }
    detect()
  }, [mobileState])

  useEffect(() => {
    if (mobileState !== 'desktop') return
    silentWake()
  }, [mobileState, silentWake])

  useEffect(() => {
    if (bootState !== 'AWAKE') { setTransitionDone(false); setAwakeVisible(false) }
  }, [bootState])

  useEffect(() => {
    if (bootState !== 'AWAKE' || transitionDone) return
    const t = setTimeout(() => setAwakeVisible(true), 600)
    return () => clearTimeout(t)
  }, [bootState, transitionDone])

  if (mobileState === 'checking') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050510', color: '#00e5ff', fontFamily: 'monospace', fontSize: 12 }}>
        Conectando...
      </div>
    )
  }

  if (mobileState === 'mobile') return <MobileClient />

  if (mobileState === 'expired') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050510', color: '#ccd6f6', fontFamily: 'monospace', gap: 12 }}>
        <div style={{ color: '#ff6b6b', fontSize: 14 }}>QR expirado</div>
        <div style={{ fontSize: 11, opacity: 0.6 }}>Pide al PC que genere un nuevo codigo QR.</div>
      </div>
    )
  }

  return (
    <>
      <DormantLayer />
      {bootState === 'LISTENING' && <ListeningLayer />}
      {bootState === 'AWAKE' && !transitionDone && (
        <RadialTransition onComplete={() => setTransitionDone(true)} />
      )}
      {bootState === 'AWAKE' && (
        <div style={{ opacity: awakeVisible ? 1 : 0, transition: 'opacity 0.2s ease', position: 'fixed', inset: 0 }}>
          <AwakeApp />
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 6.3: Run the full frontend test suite**

```bash
cd frontend && npm test
```

Expected: all tests pass.

- [ ] **Step 6.4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/modes/MobileClient.tsx
git commit -m "feat(frontend): token detection on load, mobile bypass in App.tsx"
```

---

## Task 7: Frontend — MobileClient.tsx (phone UI)

**Files:**
- Modify: `frontend/src/modes/MobileClient.tsx` (replace stub from Task 6)

- [ ] **Step 7.1: Install `qrcode` (needed in Task 8 — install now to avoid a second install step)**

```bash
cd frontend && npm install qrcode && npm install --save-dev @types/qrcode
```

- [ ] **Step 7.2: Replace `frontend/src/modes/MobileClient.tsx` with the full implementation**

```tsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { request, getApiBase } from '../api/client'
import type { SystemTelemetry } from '../types'

type ChatMessage = { role: 'user' | 'jarvis'; text: string }

const QUICK_ACTIONS = [
  { label: 'Sala ON',  entity: 'sala', action: 'on'  },
  { label: 'Sala OFF', entity: 'sala', action: 'off' },
  { label: 'TV ON',    entity: 'tv',   action: 'on'  },
  { label: 'TV OFF',   entity: 'tv',   action: 'off' },
  { label: 'AC ON',    entity: 'ac',   action: 'on'  },
  { label: 'AC OFF',   entity: 'ac',   action: 'off' },
]

export function MobileClient() {
  const [messages, setMessages]   = useState<ChatMessage[]>([])
  const [input, setInput]         = useState('')
  const [sending, setSending]     = useState(false)
  const [online, setOnline]       = useState(true)
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null)
  const recognitionRef            = useRef<any>(null)

  const pushMsg = (role: ChatMessage['role'], text: string) =>
    setMessages((prev) => [...prev.slice(-19), { role, text }])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return
    pushMsg('user', text)
    setInput('')
    setSending(true)
    try {
      const res = await request<{ ok: boolean; reply: string }>('/api/jarvis/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context: { source: 'mobile' } }),
      })
      pushMsg('jarvis', res.reply ?? '...')
    } catch {
      pushMsg('jarvis', 'Sin respuesta del servidor.')
    } finally {
      setSending(false)
    }
  }, [])

  const handleAction = useCallback(async (entity: string, action: string, label: string) => {
    try {
      await request('/api/jarvis/device-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: entity, label, skillName: entity, action }),
      })
      pushMsg('jarvis', `${label} ejecutado.`)
    } catch {
      pushMsg('jarvis', `Error al ejecutar ${label}.`)
    }
  }, [])

  const startVoice = useCallback(() => {
    const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition
    if (!SR) return
    const rec = new SR()
    rec.lang = 'es-ES'
    rec.onresult = (e: any) => sendMessage(e.results[0][0].transcript)
    rec.start()
    recognitionRef.current = rec
  }, [sendMessage])

  // Poll telemetry every 30s
  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const res = await request<SystemTelemetry>('/api/system/telemetry')
        if (!cancelled) setTelemetry(res)
      } catch {}
    }
    pull()
    const timer = setInterval(pull, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  // Heartbeat every 15s for connection indicator
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch(`${getApiBase()}/health`)
        if (!cancelled) setOnline(res.ok)
      } catch {
        if (!cancelled) setOnline(false)
      }
    }
    check()
    const timer = setInterval(check, 15_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const s: Record<string, React.CSSProperties> = {
    root:       { display: 'flex', flexDirection: 'column', height: '100dvh', background: '#050510', color: '#ccd6f6', fontFamily: 'monospace', fontSize: 12, overflowY: 'auto' },
    header:     { position: 'sticky', top: 0, zIndex: 10, background: '#0a0a1a', borderBottom: '1px solid #00e5ff33', padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    dot:        { width: 8, height: 8, borderRadius: '50%', background: online ? '#64ffda' : '#ff6b6b', boxShadow: `0 0 6px ${online ? '#64ffda' : '#ff6b6b'}` },
    section:    { padding: '12px 16px', borderBottom: '1px solid #ffffff11' },
    label:      { fontSize: 9, letterSpacing: '2px', color: '#00e5ff', opacity: 0.7, marginBottom: 8 },
    inputRow:   { display: 'flex', gap: 8, marginTop: 8 },
    textInput:  { flex: 1, background: 'transparent', border: '1px solid #ffffff33', borderRadius: 3, padding: '6px 10px', color: '#ccd6f6', fontSize: 12, fontFamily: 'monospace' },
    btn:        { background: 'transparent', border: '1px solid #00e5ff66', borderRadius: 3, color: '#00e5ff', padding: '6px 12px', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace' },
    grid:       { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
    actionBtn:  { background: 'transparent', border: '1px solid #ffffff22', borderRadius: 3, padding: '10px 6px', color: '#ccd6f6', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace' },
  }

  const bubble = (role: string): React.CSSProperties => ({
    background:  role === 'jarvis' ? '#00e5ff18' : '#ffffff14',
    border:      role === 'jarvis' ? '1px solid #00e5ff33' : 'none',
    borderRadius: 4, padding: '6px 10px', marginBottom: 6,
    alignSelf:   role === 'jarvis' ? 'flex-start' : 'flex-end',
    maxWidth:    '85%', lineHeight: 1.5,
  })

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={{ fontSize: 10, letterSpacing: '2px', color: '#00e5ff' }}>JARVIS</span>
        <div style={s.dot} />
      </div>

      {/* Jarvis chat */}
      <div style={s.section}>
        <div style={s.label}>JARVIS</div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 80 }}>
          {messages.length === 0 && <div style={{ opacity: 0.4, fontSize: 11 }}>Hola. Que necesitas?</div>}
          {messages.map((m, i) => <div key={i} style={bubble(m.role)}>{m.text}</div>)}
        </div>
        <div style={s.inputRow}>
          <input
            style={s.textInput}
            value={input}
            placeholder="Escribe a Jarvis..."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !sending) sendMessage(input) }}
          />
          <button style={s.btn} onClick={startVoice}>mic</button>
          <button style={s.btn} onClick={() => sendMessage(input)} disabled={sending}>
            {sending ? '...' : 'ok'}
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div style={s.section}>
        <div style={s.label}>ACCIONES RAPIDAS</div>
        <div style={s.grid}>
          {QUICK_ACTIONS.map((a) => (
            <button key={a.label} style={s.actionBtn} onClick={() => handleAction(a.entity, a.action, a.label)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* System stats */}
      <div style={s.section}>
        <div style={s.label}>SISTEMA</div>
        {telemetry ? (
          <div style={{ display: 'flex', gap: 16, opacity: 0.7 }}>
            <span>CPU {(telemetry.host?.cpu?.usagePct ?? 0).toFixed(0)}%</span>
            <span>GPU {(telemetry.host?.gpu?.avgUtilizationPct ?? 0).toFixed(0)}%</span>
            <span>Net {(telemetry.host?.network?.rxMbps ?? 0).toFixed(1)} Mbps</span>
          </div>
        ) : (
          <div style={{ opacity: 0.4 }}>{online ? 'Cargando...' : 'Sin conexion...'}</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 7.3: Run the full frontend test suite**

```bash
cd frontend && npm test
```

Expected: all tests pass.

- [ ] **Step 7.4: Commit**

```bash
git add frontend/src/modes/MobileClient.tsx frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): MobileClient single-scroll phone UI"
```

---

## Task 8: Frontend — AwakeApp.tsx "Conexion Movil" panel + QR

**Files:**
- Modify: `frontend/src/AwakeApp.tsx`

The system panel currently lives at lines 262-276 in `frontend/src/AwakeApp.tsx`.

- [ ] **Step 8.1: Add two imports to `frontend/src/AwakeApp.tsx`**

After the existing import block (after line 14 `import type { SystemTelemetry } from './types'`), add:

```tsx
import QRCode from 'qrcode'
import type { MobileTokenInfo, MobileStatus } from './types'
```

- [ ] **Step 8.2: Add state and refs inside `AwakeApp()` after line 42 (`const [overlayVisible...]`)**

```tsx
const [mobileToken, setMobileTokenInfo] = useState<MobileTokenInfo | null>(null)
const [mobileStatus, setMobileStatus]   = useState<MobileStatus | null>(null)
const [countdown, setCountdown]         = useState<string>('')
const qrCanvasRef                       = useRef<HTMLCanvasElement>(null)
```

- [ ] **Step 8.3: Add four effects inside `AwakeApp()` before the `return` statement**

Add after the existing useEffect blocks (before `const now = ...` or the `return`):

```tsx
useEffect(() => {
  if (zoomedMode !== 'system') return
  let cancelled = false
  async function fetchToken() {
    try {
      const res = await fetch(`${getApiBase()}/api/mobile/token`)
      const data = await res.json() as MobileTokenInfo
      if (!cancelled) setMobileTokenInfo(data)
    } catch {}
  }
  fetchToken()
  return () => { cancelled = true }
}, [zoomedMode])

useEffect(() => {
  if (zoomedMode !== 'system') return
  let cancelled = false
  async function fetchStatus() {
    try {
      const res = await fetch(`${getApiBase()}/api/mobile/status`)
      const data = await res.json() as MobileStatus
      if (!cancelled) setMobileStatus(data)
    } catch {}
  }
  fetchStatus()
  const timer = setInterval(fetchStatus, 10_000)
  return () => { cancelled = true; clearInterval(timer) }
}, [zoomedMode])

useEffect(() => {
  if (!mobileToken || !qrCanvasRef.current) return
  QRCode.toCanvas(qrCanvasRef.current, mobileToken.qrUrl, { width: 120, margin: 1 })
}, [mobileToken])

useEffect(() => {
  if (zoomedMode !== 'system' || !mobileToken) return
  const tick = () => {
    if (mobileToken.activated) { setCountdown('Sesion activa'); return }
    const diff = mobileToken.expiresAt - Date.now()
    if (diff <= 0) { setCountdown('Expirado'); return }
    const m = Math.floor(diff / 60_000)
    const sec = Math.floor((diff % 60_000) / 1000)
    setCountdown(`Expira en ${m}:${String(sec).padStart(2, '0')}`)
  }
  tick()
  const timer = setInterval(tick, 1_000)
  return () => clearInterval(timer)
}, [zoomedMode, mobileToken])
```

- [ ] **Step 8.4: Replace the system panel JSX block**

Find the block starting with `{/* System panel */}` and ending with the closing `</GlassPanel>` + `)}` (around lines 262-276). Replace the entire block with:

```tsx
{/* System panel */}
{isPanelMode && zoomedMode === 'system' && (
  <GlassPanel className="mode-panel">
    <div className="label">Sistema</div>

    {/* Conexion Movil */}
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 9, letterSpacing: '2px', color: 'var(--cyan, #00e5ff)', opacity: 0.7, marginBottom: 8 }}>
        CONEXION MOVIL
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <canvas ref={qrCanvasRef} style={{ borderRadius: 4 }} />
          <div style={{ fontSize: 9, color: '#ffd700' }}>{countdown}</div>
          <button
            className="btn"
            style={{ fontSize: 9 }}
            onClick={async () => {
              await fetch(`${getApiBase()}/api/mobile/token/refresh`, { method: 'POST' })
              const res = await fetch(`${getApiBase()}/api/mobile/token`)
              setMobileTokenInfo(await res.json())
            }}
          >
            nuevo QR
          </button>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10 }}>
          {mobileToken?.tailscaleUrl ? (
            <div style={{ border: '1px solid #00e5ff44', borderRadius: 4, padding: 8 }}>
              <div style={{ fontSize: 8, color: '#00e5ff', marginBottom: 2 }}>TAILSCALE</div>
              <div style={{ wordBreak: 'break-all', opacity: 0.9 }}>{mobileToken.tailscaleUrl}</div>
            </div>
          ) : (
            <div style={{ fontSize: 9, color: '#ffd700', opacity: 0.8 }}>
              Tailscale no detectado — QR usa LAN
            </div>
          )}
          <div style={{ border: '1px solid #ffffff22', borderRadius: 4, padding: 8 }}>
            <div style={{ fontSize: 8, opacity: 0.5, marginBottom: 2 }}>LAN</div>
            <div style={{ wordBreak: 'break-all', opacity: 0.7 }}>{mobileToken?.lanUrl ?? '—'}</div>
          </div>
          {mobileStatus?.connected && (
            <div style={{ border: '1px solid #64ffda33', borderRadius: 4, padding: 8 }}>
              <div style={{ fontSize: 8, color: '#64ffda', marginBottom: 2 }}>SESION ACTIVA</div>
              <div style={{ opacity: 0.8 }}>
                {mobileStatus.lastSeen
                  ? `Hace ${Math.round((Date.now() - mobileStatus.lastSeen) / 60_000)} min`
                  : 'Conectado'}
                {mobileStatus.via ? ` · ${mobileStatus.via}` : ''}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

    {/* Telemetria */}
    {SYSTEM_TELEMETRY_ENABLED ? (
      <div style={{ color: 'var(--text-dim)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span>CPU: {(systemTelemetry?.host?.cpu?.usagePct ?? 0).toFixed(1)}%</span>
        <span>GPU: {(systemTelemetry?.host?.gpu?.avgUtilizationPct ?? 0).toFixed(1)}%</span>
        <span>Red: {(systemTelemetry?.host?.network?.rxMbps ?? 0).toFixed(2)} / {(systemTelemetry?.host?.network?.txMbps ?? 0).toFixed(2)} Mbps</span>
      </div>
    ) : (
      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Telemetria desactivada.</div>
    )}
  </GlassPanel>
)}
```

- [ ] **Step 8.5: Run the full frontend test suite**

```bash
cd frontend && npm test
```

Expected: all tests pass.

- [ ] **Step 8.6: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors. If `qrcode` types are missing, add `"types": ["qrcode"]` under `compilerOptions` in `tsconfig.json`, or ensure `@types/qrcode` is installed.

- [ ] **Step 8.7: Commit**

```bash
git add frontend/src/AwakeApp.tsx
git commit -m "feat(frontend): Conexion Movil QR panel in System mode"
```

---

## Task 9: End-to-end smoke test

**No new files.** Manual verification of the complete flow.

- [ ] **Step 9.1: Start backend**

```bash
cd backend && npm run dev
```

Expected output: `Jarvis backend on http://0.0.0.0:8788`

- [ ] **Step 9.2: Start frontend**

```bash
cd frontend && npm run dev
```

Expected: Vite dev server starts on `http://localhost:5173`.

- [ ] **Step 9.3: Verify QR panel in System mode**

Open `http://localhost:5173` in the browser. Navigate to the System mode from the dock. Verify:
- QR canvas renders a scannable black-and-white code
- LAN URL is shown (e.g., `http://192.168.x.x:8788`)
- Countdown timer ticks down from ~10:00
- "nuevo QR" button generates a fresh code

- [ ] **Step 9.4: Test mobile flow in the same browser (simulate phone)**

Open DevTools — Network tab — find the response from `/api/mobile/token` and copy `qrUrl`.
Open a new browser tab, paste the `qrUrl`, and hit Enter. Verify:
- Brief "Conectando..." appears
- MobileClient renders (header with "JARVIS", 3 sections)
- Chat works: type a message and get a reply
- Quick action buttons send device-action requests (check Network tab for the POST)
- System stats appear within ~2s

- [ ] **Step 9.5: Test expired QR**

In the System panel, click "nuevo QR" to generate a new token. Then paste the old `qrUrl` in a new tab. Verify: "QR expirado" screen appears.

- [ ] **Step 9.6: Test auto-reconnect via localStorage**

With MobileClient open, hard-refresh (Ctrl+Shift+R). Verify: "Conectando..." flashes briefly, then MobileClient returns without re-scanning.

- [ ] **Step 9.7: Run all tests**

```bash
cd backend && npm test && cd ../frontend && npm test
```

Expected: all tests pass.

- [ ] **Step 9.8: Final commit**

```bash
git add -A
git commit -m "feat: mobile QR pairing complete — phone connects to PC as thin client"
```

---

## Summary

| Task | What it builds |
|---|---|
| 1 | Backend binds 0.0.0.0, CORS allows Authorization |
| 2 | In-memory session state with token lifecycle |
| 3 | Tailscale + LAN IP detection |
| 4 | `/api/mobile/*` endpoints + contract tests |
| 5 | Frontend types + mobile token helpers in `client.ts` |
| 6 | `App.tsx` token detection, mobile bypass before boot |
| 7 | `MobileClient.tsx` — phone UI (chat, quick actions, stats) |
| 8 | `AwakeApp.tsx` — QR panel in System mode |
| 9 | Manual end-to-end smoke test |
