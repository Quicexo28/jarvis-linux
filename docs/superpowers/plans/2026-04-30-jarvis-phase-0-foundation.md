# Jarvis Phase 0 — Foundation Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize git, set up test infrastructure, and refactor the existing backend (`server.js`) and frontend (`App.tsx`) into a modular layout that subsequent phases can extend without rewriting.

**Architecture:** Pure refactor. No user-facing change, no new endpoints, no new UI. Backend keeps the same HTTP contract; frontend keeps the same screens and behavior. Code moves into focused files with single responsibilities, and we add characterization tests that capture current behavior so later phases refactor with confidence.

**Tech Stack:** Node.js (ESM, no deps), Vitest (frontend + backend tests), Zustand (state stores, scaffolded empty), TypeScript, React 19, Vite 8.

**Spec reference:** `docs/superpowers/specs/2026-04-30-jarvis-claude-integration-design.md` §13 row 0.

**Note on `.gitignore`:** Phase 0 ignores common build artifacts and the `backend/data/` runtime tree. Patterns for secret/environment files are intentionally **deferred to Phase 1** — that phase introduces the first secret (Anthropic-related credentials) and is the right time to add them.

---

## Pre-flight: Working directory

All commands assume cwd is `C:/proyecto/jarvis-desktop` unless explicitly noted otherwise.

```bash
cd C:/proyecto/jarvis-desktop
```

---

## Task 1: Initialize git repository

**Files:**
- Create: `.gitignore`
- Create: `.git/` (via `git init`)

- [ ] **Step 1: Initialize repo**

```bash
git init
git config core.autocrlf false
```

Expected output: `Initialized empty Git repository in .../jarvis-desktop/.git/`.

- [ ] **Step 2: Create `.gitignore`**

Write file `.gitignore` with these contents (exactly):

```
# Node
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.npm/
.pnpm-store/

# Build
dist/
build/
*.tsbuildinfo

# Vite
.vite/

# Editor
.vscode/
.idea/
*.swp
.DS_Store

# Python sidecar (future phases)
voice-sidecar/.venv/
voice-sidecar/__pycache__/
voice-sidecar/**/__pycache__/
voice-sidecar/*.pyc

# Runtime data (gitignored — never commit user data)
backend/data/
backend/.cache/

# Test artifacts
coverage/
*.lcov
.nyc_output/

# OS
Thumbs.db
```

- [ ] **Step 3: Verify clean status**

Run: `git status`

Expected: list of untracked files including `README.md`, `backend/`, `frontend/`, `docs/`, `imagenes referencia/`, `CLAUDE.md`, `.gitignore`. Confirm `frontend/node_modules` is **not** listed.

- [ ] **Step 4: Commit baseline**

```bash
git add .gitignore CLAUDE.md README.md backend frontend docs "imagenes referencia"
git status
```

Verify the listed files are staged. Then:

```bash
git commit -m "chore: initialize repository with current jarvis-desktop state"
```

Expected: commit succeeds, single commit visible in `git log --oneline`.

---

## Task 2: Install Vitest and configure backend tests

**Files:**
- Modify: `backend/package.json`
- Create: `backend/vitest.config.js`
- Create: `backend/tests/sanity.test.js`

- [ ] **Step 1: Install vitest in backend**

```bash
cd backend
npm install --save-dev vitest@^2.0.0
cd ..
```

Expected: `node_modules/` and `package-lock.json` appear under `backend/`. `package.json` gets `devDependencies.vitest`.

- [ ] **Step 2: Update `backend/package.json` scripts**

Replace the file contents with:

```json
{
  "name": "jarvis-desktop-backend",
  "version": "0.2.0-phase0",
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "dev": "node src/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Create `backend/vitest.config.js`**

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 5000,
  },
})
```

- [ ] **Step 4: Write a sanity test**

Create `backend/tests/sanity.test.js`:

```js
import { test, expect } from 'vitest'

test('vitest is wired up', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 5: Run test to verify infrastructure**

```bash
cd backend && npm test && cd ..
```

Expected output contains: `Test Files  1 passed (1)` and `Tests  1 passed (1)`. Exit code 0.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/vitest.config.js backend/tests/sanity.test.js
git commit -m "test(backend): add vitest infrastructure with sanity check"
```

---

## Task 3: Capture backend HTTP contract with characterization tests

We need tests that exercise the **current** behavior of `server.js` before we refactor it, so we can verify the refactor doesn't break anything.

**Files:**
- Create: `backend/tests/server.contract.test.js`

- [ ] **Step 1: Write characterization tests**

Create `backend/tests/server.contract.test.js`:

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
```

- [ ] **Step 2: Run tests against current `server.js` — they MUST all pass**

```bash
cd backend && npm test && cd ..
```

Expected: all 8 contract tests pass plus the sanity test (9 total). If any fail, the test was written incorrectly — fix the test, not the source. We are capturing existing behavior verbatim.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/server.contract.test.js
git commit -m "test(backend): characterization tests for current server.js HTTP contract"
```

---

## Task 4: Extract HTTP helpers into `lib/http.js` and `lib/exec.js`

**Files:**
- Create: `backend/src/lib/http.js`
- Create: `backend/src/lib/exec.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Create `backend/src/lib/http.js`**

```js
export function json(res, code, payload) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.end(JSON.stringify(payload))
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
```

- [ ] **Step 2: Create `backend/src/lib/exec.js`**

```js
import { exec as execCb } from 'child_process'

export function execCmd(command, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execCb(
      command,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return resolve('')
        resolve(String(stdout || stderr || '').trim())
      },
    )
  })
}
```

- [ ] **Step 3: Modify `backend/src/server.js` — replace the inlined helpers with imports**

At the top of `server.js`, replace:

```js
import http from 'http'
import os from 'os'
import { exec as execCb } from 'child_process'
```

with:

```js
import http from 'http'
import os from 'os'
import { json, readBody } from './lib/http.js'
import { execCmd } from './lib/exec.js'
```

Then **delete** the local declarations of `function json(...)`, `function readBody(...)`, and `function execCmd(...)` from `server.js` (lines 7-39 in current file). The rest stays identical.

- [ ] **Step 4: Run characterization tests**

```bash
cd backend && npm test && cd ..
```

Expected: all 8 contract tests still pass. The refactor is invisible to the HTTP contract.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/http.js backend/src/lib/exec.js backend/src/server.js
git commit -m "refactor(backend): extract http and exec helpers to src/lib/"
```

---

## Task 5: Extract handlers into `handlers/` modules

Each handler file owns one concern. Telemetry stays a verbatim copy — Phase 4 rewrites it; we don't touch its logic now.

**Files:**
- Create: `backend/src/handlers/health.js`
- Create: `backend/src/handlers/modules.js`
- Create: `backend/src/handlers/jarvis.js`
- Create: `backend/src/handlers/telemetry.js`

- [ ] **Step 1: Create `backend/src/handlers/health.js`**

```js
import { json } from '../lib/http.js'

export function handleHealth(_req, res) {
  return json(res, 200, { status: 'ok', service: 'jarvis-backend' })
}
```

- [ ] **Step 2: Create `backend/src/handlers/modules.js`**

```js
import { json } from '../lib/http.js'

export function handleModules(_req, res) {
  return json(res, 200, { modules: ['tv', 'cloud', 'system', 'jarvis-turn', 'telemetry'] })
}
```

- [ ] **Step 3: Create `backend/src/handlers/jarvis.js`**

The implementing agent should open the current `backend/src/server.js`, copy the bodies of `async function handleDeviceAction` and `async function handleJarvisTurn` verbatim — including the original Spanish strings with their accented characters (`acción`, `recibido`, etc.) — into `backend/src/handlers/jarvis.js`.

Add these imports at the top of the new file:

```js
import { json, readBody } from '../lib/http.js'
```

Add `export` before each function so they become `export async function handleDeviceAction(...)` and `export async function handleJarvisTurn(...)`.

The function bodies stay byte-identical. Use `git diff` after the move to verify nothing else changed.

- [ ] **Step 4: Create `backend/src/handlers/telemetry.js`**

This is a verbatim copy of the existing telemetry block from `server.js`. The implementing agent should:

1. Open current `backend/src/server.js`
2. Copy the entire block from `let lastCpuSnapshot = null` through the closing brace of `async function handleTelemetry`
3. Paste into `backend/src/handlers/telemetry.js` with these added imports at top:

```js
import os from 'os'
import { json } from '../lib/http.js'
import { execCmd } from '../lib/exec.js'
```

4. Add `export` before `async function handleTelemetry` so it becomes `export async function handleTelemetry`.
5. The other helpers (`takeCpuSnapshot`, `getGpuTelemetry`, `getNetworkTelemetry`, `getCpuTelemetry`, `getOpenClawTelemetry`) stay non-exported.

- [ ] **Step 5: Run characterization tests**

```bash
cd backend && npm test && cd ..
```

Expected: all tests still pass (handler files exist but `server.js` does not yet import them — tests still hit the unchanged dispatcher inside `server.js`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/handlers/
git commit -m "refactor(backend): extract handlers into src/handlers/ (server.js still inlines)"
```

---

## Task 6: Build `routes.js` table and dispatcher; refactor `server.js`

**Files:**
- Create: `backend/src/routes.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Create `backend/src/routes.js`**

```js
import { json } from './lib/http.js'
import { handleHealth } from './handlers/health.js'
import { handleModules } from './handlers/modules.js'
import { handleDeviceAction, handleJarvisTurn } from './handlers/jarvis.js'
import { handleTelemetry } from './handlers/telemetry.js'

export const routes = [
  { method: 'GET', path: '/health', handler: handleHealth },
  { method: 'GET', path: '/modules', handler: handleModules },
  { method: 'GET', path: '/api/system/telemetry', handler: handleTelemetry },
  { method: 'POST', path: '/api/jarvis/device-action', handler: handleDeviceAction },
  { method: 'POST', path: '/api/jarvis/turn', handler: handleJarvisTurn },
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

- [ ] **Step 2: Replace `backend/src/server.js` with the slim version**

Overwrite the entire file contents with:

```js
import http from 'http'
import { env } from 'node:process'
import { dispatch } from './routes.js'

const port = Number(env.PORT ?? 8788)
const host = env.HOST ?? '127.0.0.1'

const server = http.createServer(async (req, res) => {
  try {
    await dispatch(req, res)
  } catch (err) {
    console.error('unhandled', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'internal' }))
    }
  }
})

server.listen(port, host, () => {
  console.log(`Jarvis backend on http://${host}:${port}`)
})
```

- [ ] **Step 3: Run characterization tests**

```bash
cd backend && npm test && cd ..
```

Expected: all 8 contract tests pass plus sanity. The refactor is complete and behavior-identical.

- [ ] **Step 4: Manual smoke test**

```bash
cd backend && npm run dev &
sleep 2
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8788/modules
kill %1
cd ..
```

Expected output:

```
{"status":"ok","service":"jarvis-backend"}
{"modules":["tv","cloud","system","jarvis-turn","telemetry"]}
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes.js backend/src/server.js
git commit -m "refactor(backend): replace inline if/else with routes.js dispatcher"
```

---

## Task 7: Install Vitest and configure frontend tests

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/vitest.config.ts`
- Modify: `frontend/tsconfig.json`
- Create: `frontend/src/sanity.test.ts`

- [ ] **Step 1: Install vitest in frontend**

```bash
cd frontend
npm install --save-dev vitest@^2.0.0 @vitest/ui@^2.0.0 jsdom@^25.0.0 @types/node@^22.0.0
cd ..
```

- [ ] **Step 2: Update `frontend/package.json` scripts**

Open `frontend/package.json` and replace the `scripts` block with:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:ui": "vitest --ui"
}
```

Leave `dependencies` and `devDependencies` as they are (npm install added the new ones).

- [ ] **Step 3: Create `frontend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: false,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 5000,
  },
})
```

- [ ] **Step 4: Update `frontend/tsconfig.json` to include node types**

Read current `frontend/tsconfig.json`. In `compilerOptions`, ensure `types` includes `"node"`. Add this key (or merge into existing):

```json
"types": ["node"]
```

- [ ] **Step 5: Write a sanity test**

Create `frontend/src/sanity.test.ts`:

```ts
import { test, expect } from 'vitest'

test('vitest is wired up in frontend', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 6: Run test**

```bash
cd frontend && npm test && cd ..
```

Expected: `Test Files  1 passed (1)` and `Tests  1 passed (1)`. Exit code 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/tsconfig.json frontend/src/sanity.test.ts
git commit -m "test(frontend): add vitest infrastructure with sanity check"
```

---

## Task 8: Extract types into `types.ts`

**Files:**
- Create: `frontend/src/types.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create `frontend/src/types.ts`**

Move all type definitions verbatim from `App.tsx` (currently lines 8-20):

```ts
export type Mode = 'home' | 'house' | 'plan2d' | 'plan3d' | 'space' | 'cloud' | 'system'
export type HoloMode = Exclude<Mode, 'plan2d' | 'plan3d' | 'space'>
export type WallType = 'solid' | 'low'
export type Segment = { x1: number; y1: number; x2: number; y2: number; wallType?: WallType }
export type SavedPlan = { room: string; name: string; segments: Segment[]; updatedAt: string }
export type EntityCategory = 'furniture' | 'device'
export type EntityKind = 'sofa' | 'bed' | 'table' | 'tv' | 'lamp' | 'router' | 'camera' | 'switch' | 'sensor'
export type SceneEntity = {
  id: string
  kind: EntityKind
  category: EntityCategory
  x: number
  y: number
  z: number
  rotY: number
  width: number
  height: number
  depth: number
  color: string
  label: string
  skillName?: string
  skillAction?: string
  skillActions?: string[]
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
```

- [ ] **Step 2: Modify `App.tsx` — remove inline types, import from `./types`**

In `frontend/src/App.tsx`, **delete** the type declarations on lines 8-20 (the `type Mode = ...` through `type SystemTelemetry = ...` block). Replace with:

```ts
import type {
  Mode,
  HoloMode,
  Segment,
  SavedPlan,
  SceneEntity,
  Viewpoint,
  SystemTelemetry,
} from './types'
```

Place this import right after the existing imports (after `import { HoloScene } from './HoloScene'`).

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit && cd ..
```

Expected: zero errors. If TypeScript reports unused imports, remove the unused ones from the import line (some types might only be used inside extracted components later — keep only the ones still referenced by `App.tsx` at this stage).

- [ ] **Step 4: Manual smoke test**

```bash
cd frontend && npm run dev
```

Open `http://localhost:5173` in browser. Click through Core, Casa, System modes, verify no broken UI. Stop server (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types.ts frontend/src/App.tsx
git commit -m "refactor(frontend): extract types from App.tsx into types.ts"
```

---

## Task 9: Extract constants into `constants.ts`

**Files:**
- Create: `frontend/src/constants.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create `frontend/src/constants.ts`**

The implementing agent should:

1. Open current `frontend/src/App.tsx`
2. Copy the constants block from line 22 (`const GRID_CELLS = 40`) through the closing brace of `modeMeta` (around line 40), preserving all original Spanish strings with their accents (`Visual de Nube Familiar`, `Telemetría orbital`, etc.) byte-for-byte
3. Paste into `frontend/src/constants.ts`, prefixing each `const` with `export`:

Skeleton:

```ts
import type { Mode } from './types'

export const GRID_CELLS = 40
export const CELL_METERS = 0.25
export const VIEWBOX_SIZE = 800
export const STEP = VIEWBOX_SIZE / GRID_CELLS

export const PLAN_STORAGE_KEY = 'jarvis.plan2d.saved.v1'
export const PLAN3D_ENTITY_STORAGE_KEY = 'jarvis.plan3d.entities.v1'
export const PLAN3D_VIEWPOINT_STORAGE_KEY = 'jarvis.plan3d.viewpoint.v1'

export const modeMeta: Record<Mode, { label: string; title: string; subtitle: string }> = {
  // ... copy from App.tsx verbatim, with all Spanish strings preserved
}
```

Do NOT paraphrase the Spanish copy — copy it character-for-character from the source.

- [ ] **Step 2: Modify `App.tsx` — delete the constants block (current lines 22-40) and import**

Add this import after the type imports:

```ts
import {
  GRID_CELLS,
  CELL_METERS,
  VIEWBOX_SIZE,
  STEP,
  PLAN_STORAGE_KEY,
  PLAN3D_ENTITY_STORAGE_KEY,
  PLAN3D_VIEWPOINT_STORAGE_KEY,
  modeMeta,
} from './constants'
```

**Delete** the constants block in `App.tsx` (the `const GRID_CELLS = 40` through end of `modeMeta` object).

Note: `App.tsx` still contains the constants `API_BASE` and `SYSTEM_TELEMETRY_ENABLED`. Leave those for now — Task 12 (`api/client.ts` integration) handles `API_BASE`, and `SYSTEM_TELEMETRY_ENABLED` will be removed in Phase 4.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit && cd ..
```

Expected: zero errors.

- [ ] **Step 4: Manual smoke test**

Run dev server, open in browser, click through modes. UI identical to before — same Spanish copy, same accents.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/constants.ts frontend/src/App.tsx
git commit -m "refactor(frontend): extract constants and modeMeta into constants.ts"
```

---

## Task 10: Extract `Plan2DEditor`, `Plan3DViewer`, `SpaceViewer` into modes/

This task moves three sibling components in three sub-steps. They are isomorphic refactors — copy a function and its local helpers verbatim into a new file, change `function X` to `export function X`, fix imports, delete from `App.tsx`.

**Files:**
- Create: `frontend/src/modes/Plan2DEditor.tsx`
- Create: `frontend/src/modes/Plan3DViewer.tsx`
- Create: `frontend/src/modes/SpaceViewer.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Move `Plan2DEditor` and helper `loadSavedPlans`**

Read `App.tsx` and locate `function snap` (currently around line 42), `function loadSavedPlans` (around line 46), and `function Plan2DEditor` (currently around line 55, ending around line 223).

Create `frontend/src/modes/Plan2DEditor.tsx`. Top imports:

```ts
import { useRef, useState } from 'react'
import type { Segment, SavedPlan, WallType } from '../types'
import { GRID_CELLS, STEP, VIEWBOX_SIZE, PLAN_STORAGE_KEY } from '../constants'
```

Then paste the bodies of `snap`, `loadSavedPlans`, and `Plan2DEditor` verbatim from `App.tsx`, but:

- `snap` stays local (only used inside this file)
- `loadSavedPlans` is also used by Plan3DViewer and App, so make it **exported**: `export function loadSavedPlans()`
- `Plan2DEditor` becomes `export function Plan2DEditor`

In `App.tsx`:

- **Delete** `function snap`, `function loadSavedPlans`, and `function Plan2DEditor`
- Add import: `import { Plan2DEditor, loadSavedPlans } from './modes/Plan2DEditor'`

- [ ] **Step 2: Verify TypeScript compiles after Plan2D extraction**

```bash
cd frontend && npx tsc --noEmit && cd ..
```

Expected: zero errors.

- [ ] **Step 3: Move `Plan3DViewer` and helpers (`loadEntityStore`, `loadViewpointStore`, `EntityPrimitive`)**

Locate in `App.tsx`:

- `function loadEntityStore` (~line 225)
- `function loadViewpointStore` (~line 234)
- `function EntityPrimitive` (~line 243)
- `function Plan3DViewer` (~line 325, ends ~line 552)

Create `frontend/src/modes/Plan3DViewer.tsx`. Top imports:

```ts
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type {
  SavedPlan,
  SceneEntity,
  EntityKind,
  EntityCategory,
  Viewpoint,
} from '../types'
import {
  CELL_METERS,
  GRID_CELLS,
  PLAN3D_ENTITY_STORAGE_KEY,
  PLAN3D_VIEWPOINT_STORAGE_KEY,
} from '../constants'
import { loadSavedPlans } from './Plan2DEditor'
```

Paste the four functions verbatim. Make all four `export function ...` (exporting `EntityPrimitive` is harmless; we may need it in Phase 3).

In `App.tsx`:

- Delete the four functions
- Add: `import { Plan3DViewer, loadEntityStore, loadViewpointStore } from './modes/Plan3DViewer'`

- [ ] **Step 4: Verify TypeScript compiles after Plan3D extraction**

```bash
cd frontend && npx tsc --noEmit && cd ..
```

Expected: zero errors. If errors mention duplicate function definitions, the delete in `App.tsx` was incomplete.

- [ ] **Step 5: Move `SpaceViewer` and helpers (`ImmersiveFirstPersonController`, `GazeDetector`)**

Locate in `App.tsx`:

- `function ImmersiveFirstPersonController` (~line 553)
- `function SpaceViewer` (~line 581, ends ~line 786)
- `function GazeDetector` (~line 787, ends ~line 852)

Create `frontend/src/modes/SpaceViewer.tsx`. Top imports:

```ts
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { SceneEntity, Viewpoint } from '../types'
import { CELL_METERS, GRID_CELLS } from '../constants'
import { loadSavedPlans } from './Plan2DEditor'
import { loadEntityStore, loadViewpointStore, EntityPrimitive } from './Plan3DViewer'
```

Paste the three functions verbatim. Export `SpaceViewer`. The two helpers (`ImmersiveFirstPersonController`, `GazeDetector`) stay non-exported since only `SpaceViewer` uses them.

In `App.tsx`:

- Delete the three functions
- Add: `import { SpaceViewer } from './modes/SpaceViewer'`

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit && cd ..
```

Expected: zero errors.

- [ ] **Step 7: Manual smoke test all three extracted modes**

```bash
cd frontend && npm run dev
```

Open in browser. Click through:

1. **Casa → Plano 2D** — editor opens, draw a wall, save, reload page, plan persists.
2. **Casa → Espacio 3D** — viewer opens with the saved plan as walls, can add a furniture entity.
3. **Casa → Inmersivo** (after creating viewpoint in 3D) — first-person view loads.

If any mode breaks, the most likely causes:

- Missing import in the extracted file
- A helper that was actually shared but only one mode imports it now
- Closure over a constant that was not in the imports

Stop the server (Ctrl+C).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/modes/ frontend/src/App.tsx
git commit -m "refactor(frontend): extract Plan2DEditor, Plan3DViewer, SpaceViewer into modes/"
```

---

## Task 11: Build `api/client.ts` with `getApiBase()` resolver (TDD)

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/api/client.test.ts`:

```ts
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getApiBase, setApiBase, clearApiBase, request, API_BASE_STORAGE_KEY } from './client'

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

test('getApiBase falls back to window.location.origin when storage empty', () => {
  expect(getApiBase()).toBe(window.location.origin)
})

test('setApiBase persists to localStorage and getApiBase reads it back', () => {
  setApiBase('http://my-tailscale-pc:8788')
  expect(localStorage.getItem(API_BASE_STORAGE_KEY)).toBe('http://my-tailscale-pc:8788')
  expect(getApiBase()).toBe('http://my-tailscale-pc:8788')
})

test('clearApiBase removes the stored override', () => {
  setApiBase('http://override')
  clearApiBase()
  expect(localStorage.getItem(API_BASE_STORAGE_KEY)).toBeNull()
  expect(getApiBase()).toBe(window.location.origin)
})

test('getApiBase strips trailing slash', () => {
  setApiBase('http://x:8788/')
  expect(getApiBase()).toBe('http://x:8788')
})

test('request prefixes path with apiBase and parses JSON', async () => {
  setApiBase('http://x:8788')
  const fakeFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ hello: 'world' }),
  })
  vi.stubGlobal('fetch', fakeFetch)

  const result = await request<{ hello: string }>('/health')

  expect(fakeFetch).toHaveBeenCalledWith('http://x:8788/health', undefined)
  expect(result).toEqual({ hello: 'world' })
})

test('request throws on non-ok response with status in error', async () => {
  setApiBase('http://x:8788')
  const fakeFetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: 'boom' }),
  })
  vi.stubGlobal('fetch', fakeFetch)

  await expect(request('/health')).rejects.toThrow(/500/)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npm test -- src/api/client.test.ts
```

Expected: tests fail because `./client` does not exist (Cannot find module).

- [ ] **Step 3: Implement `frontend/src/api/client.ts`**

```ts
export const API_BASE_STORAGE_KEY = 'jarvis.api.base'

export function getApiBase(): string {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(API_BASE_STORAGE_KEY)
  } catch {
    // localStorage may be unavailable in some contexts
  }
  const base = stored?.trim() || window.location.origin
  return base.replace(/\/+$/, '')
}

export function setApiBase(url: string): void {
  localStorage.setItem(API_BASE_STORAGE_KEY, url.trim())
}

export function clearApiBase(): void {
  localStorage.removeItem(API_BASE_STORAGE_KEY)
}

export async function request<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${getApiBase()}${path}`
  const res = await fetch(url, init)
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : ''
    } catch {}
    throw new Error(`request failed ${res.status} ${detail}`.trim())
  }
  return res.json() as Promise<T>
}
```

- [ ] **Step 4: Run tests — they should pass**

```bash
cd frontend && npm test -- src/api/client.test.ts && cd ..
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(frontend): add api/client.ts with API_BASE resolver and request helper"
```

---

## Task 12: Replace hardcoded `API_BASE` in `App.tsx` with `getApiBase()`

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Inspect current usage**

Run grep:

```bash
grep -n "API_BASE" frontend/src/App.tsx
```

Expected matches: the const declaration plus 3 fetch calls (telemetry, device-action, jarvis/turn).

- [ ] **Step 2: Replace `API_BASE` const with import**

In `App.tsx`:

Remove the line `const API_BASE = 'http://127.0.0.1:8788'`.

Add to imports:

```ts
import { getApiBase } from './api/client'
```

Replace each occurrence of `${API_BASE}` in template literals with `${getApiBase()}`. There are typically three:

```ts
fetch(`${getApiBase()}/api/system/telemetry`)
fetch(`${getApiBase()}/api/jarvis/device-action`, { ... })
fetch(`${getApiBase()}/api/jarvis/turn`, { ... })
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit && cd ..
```

Expected: zero errors.

- [ ] **Step 4: Manual smoke test**

Start backend (`cd backend && npm run dev`) and frontend (`cd frontend && npm run dev`). The frontend served on `http://localhost:5173` will use `window.location.origin = http://localhost:5173`. **The app will fail to reach the backend at port 8788 because origin is 5173.** This is expected — the resolver falls back to `window.location.origin`, which matches the frontend dev server, not the backend.

To make smoke test work in dev, set the override in browser console once:

```js
localStorage.setItem('jarvis.api.base', 'http://127.0.0.1:8788')
```

Then reload. The app should now reach the backend. Verify Core, Casa render correctly. (Phase 7 will introduce a UI for setting this; for Phase 0 the localStorage override is fine.)

Stop both servers.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "refactor(frontend): replace hardcoded API_BASE with getApiBase() resolver"
```

---

## Task 13: Install Zustand and create empty stores

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/state/jarvisStore.ts`
- Create: `frontend/src/state/systemStore.ts`
- Create: `frontend/src/state/networkStore.ts`
- Create: `frontend/src/state/jarvisStore.test.ts`

- [ ] **Step 1: Install zustand**

```bash
cd frontend && npm install zustand@^5.0.0 && cd ..
```

- [ ] **Step 2: Create `frontend/src/state/jarvisStore.ts`**

```ts
import { create } from 'zustand'
import type { Mode, SceneEntity, SavedPlan, Viewpoint } from '../types'

export type FocusedEntityRef = {
  id: string
  label: string
  skillName?: string
  skillAction?: string
}

export type JarvisState = {
  mode: Mode
  voiceEnabled: boolean
  wakeListening: boolean
  wakePhrase: string
  coreInput: string
  coreReply: string
  focusedEntity: FocusedEntityRef | null
  housePlans: SavedPlan[]
  entitiesByPlan: Record<string, SceneEntity[]>
  viewpointByPlan: Record<string, Viewpoint>
  setMode: (m: Mode) => void
  setVoiceEnabled: (v: boolean) => void
  setWakeListening: (v: boolean) => void
  setWakePhrase: (p: string) => void
  setCoreInput: (s: string) => void
  setCoreReply: (s: string) => void
  setFocusedEntity: (e: FocusedEntityRef | null) => void
}

export const useJarvisStore = create<JarvisState>((set) => ({
  mode: 'house',
  voiceEnabled: true,
  wakeListening: false,
  wakePhrase: 'jarvis',
  coreInput: '',
  coreReply: '',
  focusedEntity: null,
  housePlans: [],
  entitiesByPlan: {},
  viewpointByPlan: {},
  setMode: (mode) => set({ mode }),
  setVoiceEnabled: (voiceEnabled) => set({ voiceEnabled }),
  setWakeListening: (wakeListening) => set({ wakeListening }),
  setWakePhrase: (wakePhrase) => set({ wakePhrase }),
  setCoreInput: (coreInput) => set({ coreInput }),
  setCoreReply: (coreReply) => set({ coreReply }),
  setFocusedEntity: (focusedEntity) => set({ focusedEntity }),
}))
```

- [ ] **Step 3: Create `frontend/src/state/systemStore.ts`**

```ts
import { create } from 'zustand'

export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export type ModelKey = 'haiku' | 'sonnet' | 'opus'

export type ModelStats = {
  turns: number
  tokensIn: number
  tokensOut: number
  p50LatencyMs: number
  p95LatencyMs: number
}

export type SystemState = {
  tokensWindow5h: { in: number; out: number; limit: number; resetMs: number } | null
  tokensWeek: { in: number; out: number; limit: number } | null
  modelStats: Record<ModelKey, ModelStats>
  activeModel: ModelKey
  services: Record<string, ServiceStatus>
  containers: Array<{ id: string; name: string; image: string; ports: string; uptime: string }>
  routines: Array<{ name: string; trigger: string; actions: string[] }>
}

const emptyStats: ModelStats = {
  turns: 0,
  tokensIn: 0,
  tokensOut: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
}

export const useSystemStore = create<SystemState>(() => ({
  tokensWindow5h: null,
  tokensWeek: null,
  modelStats: { haiku: emptyStats, sonnet: emptyStats, opus: emptyStats },
  activeModel: 'haiku',
  services: {},
  containers: [],
  routines: [],
}))
```

- [ ] **Step 4: Create `frontend/src/state/networkStore.ts`**

```ts
import { create } from 'zustand'

export type DiscoveredDevice = {
  mac: string
  ip: string
  hostname?: string
  vendor?: string
  rssi?: number
  lastSeen: number
}

export type RoomAssignment = {
  mac: string
  planKey: string
  entityId?: string
}

export type PresenceEvent = {
  source: string
  zone: string
  kind: 'motion' | 'presence'
  value: number
  ts: number
}

export type NetworkState = {
  discoveredDevices: DiscoveredDevice[]
  roomAssignments: RoomAssignment[]
  presenceByZone: Record<string, PresenceEvent>
  setDiscoveredDevices: (d: DiscoveredDevice[]) => void
  upsertAssignment: (a: RoomAssignment) => void
  removeAssignment: (mac: string) => void
  recordPresenceEvent: (e: PresenceEvent) => void
}

export const useNetworkStore = create<NetworkState>((set) => ({
  discoveredDevices: [],
  roomAssignments: [],
  presenceByZone: {},
  setDiscoveredDevices: (discoveredDevices) => set({ discoveredDevices }),
  upsertAssignment: (assignment) =>
    set((state) => {
      const without = state.roomAssignments.filter((a) => a.mac !== assignment.mac)
      return { roomAssignments: [...without, assignment] }
    }),
  removeAssignment: (mac) =>
    set((state) => ({
      roomAssignments: state.roomAssignments.filter((a) => a.mac !== mac),
    })),
  recordPresenceEvent: (event) =>
    set((state) => ({
      presenceByZone: { ...state.presenceByZone, [event.zone]: event },
    })),
}))
```

- [ ] **Step 5: Write a test for jarvisStore actions**

Create `frontend/src/state/jarvisStore.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest'
import { useJarvisStore } from './jarvisStore'

beforeEach(() => {
  useJarvisStore.setState({
    mode: 'house',
    voiceEnabled: true,
    wakeListening: false,
    wakePhrase: 'jarvis',
    coreInput: '',
    coreReply: '',
    focusedEntity: null,
    housePlans: [],
    entitiesByPlan: {},
    viewpointByPlan: {},
  })
})

test('setMode updates mode', () => {
  useJarvisStore.getState().setMode('system')
  expect(useJarvisStore.getState().mode).toBe('system')
})

test('setVoiceEnabled toggles voice', () => {
  useJarvisStore.getState().setVoiceEnabled(false)
  expect(useJarvisStore.getState().voiceEnabled).toBe(false)
})

test('setFocusedEntity stores entity ref', () => {
  useJarvisStore.getState().setFocusedEntity({ id: 'e1', label: 'TV' })
  expect(useJarvisStore.getState().focusedEntity).toEqual({ id: 'e1', label: 'TV' })
})

test('setFocusedEntity(null) clears focus', () => {
  useJarvisStore.getState().setFocusedEntity({ id: 'e1', label: 'TV' })
  useJarvisStore.getState().setFocusedEntity(null)
  expect(useJarvisStore.getState().focusedEntity).toBeNull()
})
```

- [ ] **Step 6: Run tests**

```bash
cd frontend && npm test && cd ..
```

Expected: all tests pass (sanity, client, jarvisStore).

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/state/
git commit -m "feat(frontend): scaffold zustand stores (jarvis, system, network)"
```

---

## Task 14: Slim down `App.tsx` to shell composition

The remaining content in `App.tsx` is the `App` component itself plus a few state setters that should now use the Zustand store. We rewire the local `useState` calls to the store so future phases can read/write store state from anywhere.

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Refactor `App.tsx` to consume `useJarvisStore`**

In the body of `function App()`:

Replace the `useState` calls for `mode`, `voiceEnabled`, `wakeListening`, `wakePhrase`, `coreInput`, `coreReply` with `useJarvisStore` reads:

```ts
const mode = useJarvisStore((s) => s.mode)
const setMode = useJarvisStore((s) => s.setMode)
const voiceEnabled = useJarvisStore((s) => s.voiceEnabled)
const setVoiceEnabled = useJarvisStore((s) => s.setVoiceEnabled)
const wakeListening = useJarvisStore((s) => s.wakeListening)
const setWakeListening = useJarvisStore((s) => s.setWakeListening)
const wakePhrase = useJarvisStore((s) => s.wakePhrase)
const setWakePhrase = useJarvisStore((s) => s.setWakePhrase)
const coreInput = useJarvisStore((s) => s.coreInput)
const setCoreInput = useJarvisStore((s) => s.setCoreInput)
const coreReply = useJarvisStore((s) => s.coreReply)
const setCoreReply = useJarvisStore((s) => s.setCoreReply)
```

Add the import at the top:

```ts
import { useJarvisStore } from './state/jarvisStore'
```

Local state that should remain `useState` because it is truly local to `App.tsx`:

- `housePlanKey` (transient nav state)
- `houseEditorMode` (UI dropdown choice)
- `listening` (transient ASR state)
- `systemTelemetry` (will move in Phase 4)
- `wakeRecognitionRef`

Replace each `setVoiceEnabled((v) => !v)` updater-form call with `setVoiceEnabled(!voiceEnabled)` — Zustand setters take the new value directly, not an updater function. Carefully review every setter call site for any updater-form pattern and convert.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit && cd ..
```

Expected: zero errors. If errors mention "Argument of type ... not assignable", it is likely a remaining updater-form pattern that needs flattening.

- [ ] **Step 3: Run all tests**

```bash
cd frontend && npm test && cd ..
```

Expected: all tests pass (sanity, client, jarvisStore).

- [ ] **Step 4: Manual smoke test — full coverage**

Start backend and frontend dev servers. In browser, set `localStorage.setItem('jarvis.api.base', 'http://127.0.0.1:8788')` once and reload.

Verify each path:

1. **Core**: type a message, click "Enviar". Reply appears.
2. **Core voz**: click "Hablar (voz)". Browser asks for mic permission. Speak, reply appears.
3. **Core wake**: click "Activar frase wake". Say "jarvis hola". Reply appears.
4. **Casa**: list of plans renders. Click a plan -> opens Inmersivo.
5. **Casa Submenu Plano 2D Abrir editor**: Plan2D editor opens, draw a wall, save with room+name.
6. **Casa Submenu Espacio 3D Abrir editor**: Plan3D viewer opens with saved walls, can add an entity.
7. **Casa click on an entry**: Inmersivo opens.
8. **Cloud**: holographic scene shows.
9. **System**: holographic scene shows. (Telemetry tiles only show if `SYSTEM_TELEMETRY_ENABLED = true` — currently false.)
10. **Voz global toggle**: button shows ON/OFF correctly.

If any path breaks, the most likely cause is a missed setter conversion or a closure issue with the new store reads. Stop servers when done.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "refactor(frontend): wire App.tsx state through useJarvisStore"
```

---

## Task 15: Final verification, line count, and tag

- [ ] **Step 1: Run all tests one more time**

```bash
cd backend && npm test && cd ..
cd frontend && npm test && cd ..
```

Expected: backend 9 tests pass (8 contract + 1 sanity); frontend 11 tests pass (1 sanity + 6 client + 4 jarvisStore).

- [ ] **Step 2: Verify line count of `App.tsx`**

```bash
wc -l frontend/src/App.tsx
```

Expected: between **80 and 200 lines**. If over 200, more extraction is needed — the goal of Phase 0 is `App.tsx` becomes a shell. If under 80, helpers may have been over-eagerly removed; review the file ensures it still wires Core/Casa/Cloud/System.

- [ ] **Step 3: Check file inventory**

```bash
find frontend/src -name "*.tsx" -type f | sort
find frontend/src -name "*.ts" -type f | sort
```

Expected file inventory (approximately):

```
frontend/src/App.css
frontend/src/App.tsx
frontend/src/HoloScene.tsx
frontend/src/api/client.ts
frontend/src/api/client.test.ts
frontend/src/constants.ts
frontend/src/main.tsx
frontend/src/modes/Plan2DEditor.tsx
frontend/src/modes/Plan3DViewer.tsx
frontend/src/modes/SpaceViewer.tsx
frontend/src/sanity.test.ts
frontend/src/state/jarvisStore.ts
frontend/src/state/jarvisStore.test.ts
frontend/src/state/networkStore.ts
frontend/src/state/systemStore.ts
frontend/src/style.css
frontend/src/types.ts
```

- [ ] **Step 4: Build check**

```bash
cd frontend && npm run build && cd ..
```

Expected: build succeeds with no TypeScript errors. `dist/` is generated. Treat any TS errors as blocking.

- [ ] **Step 5: Tag the phase completion**

```bash
git tag -a v0.2.0-phase0 -m "Phase 0 complete: foundation refactor (no UI changes)"
git log --oneline -20
```

Expected: a clean linear history with one commit per task, plus the v0.2.0-phase0 tag visible.

- [ ] **Step 6: Update `CLAUDE.md` to reflect new structure**

Edit `CLAUDE.md` (the per-project one, not the workspace one). Replace the "Frontend (`frontend/src/App.tsx` is monolithic)" section with:

```markdown
### Frontend layout (post Phase 0)

`App.tsx` is now a thin shell (~150 lines) that composes:
- `state/jarvisStore.ts`, `systemStore.ts`, `networkStore.ts` — Zustand stores
- `modes/Plan2DEditor.tsx`, `Plan3DViewer.tsx`, `SpaceViewer.tsx` — editor/viewer screens
- `api/client.ts` — `getApiBase()` resolver, `request()` helper
- `types.ts`, `constants.ts` — shared definitions
- `HoloScene.tsx` — current holographic background (will be replaced in Phase 3)

`API_BASE` is no longer hardcoded; resolved per-call via `getApiBase()`. Override stored in `localStorage.jarvis.api.base`.
```

Replace the corresponding section. Keep the rest (Backend, Conventions) intact for now — those sections will be revised by later phases.

- [ ] **Step 7: Commit and re-tag**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for post-Phase-0 frontend layout"
git tag -d v0.2.0-phase0
git tag -a v0.2.0-phase0 -m "Phase 0 complete: foundation refactor (no UI changes)"
```

---

## Definition of Done — Phase 0

- [ ] git repository initialized with `.gitignore` covering `backend/data/`, `node_modules/`, `dist/`
- [ ] Backend has vitest infrastructure + 8 characterization tests + 1 sanity test, all green
- [ ] Backend `server.js` is ~30 lines, dispatches via `routes.js`
- [ ] Backend handlers split into `handlers/health.js`, `modules.js`, `jarvis.js`, `telemetry.js`
- [ ] Backend `lib/http.js` and `lib/exec.js` extracted
- [ ] Frontend has vitest + 11 tests, all green
- [ ] Frontend `App.tsx` ≤ 200 lines
- [ ] `Plan2DEditor`, `Plan3DViewer`, `SpaceViewer` extracted to `modes/`
- [ ] `types.ts` and `constants.ts` exist with shared definitions
- [ ] Three empty Zustand stores scaffolded
- [ ] `api/client.ts` with `getApiBase()` resolver, `setApiBase()`, `clearApiBase()`, `request()`
- [ ] `App.tsx` reads from `useJarvisStore` instead of inline `useState` for the six store-managed fields
- [ ] All 10 manual smoke-test paths in Task 14 Step 4 work end-to-end
- [ ] `npm run build` succeeds without TypeScript errors
- [ ] Tag `v0.2.0-phase0` exists on the head commit

---

## What this phase intentionally does NOT do

- Does not change any user-facing UI, copy, or behavior
- Does not introduce Agent SDK, Claude integration, or new endpoints
- Does not introduce voice (sidecar Python, XTTS, Whisper, audio listener)
- Does not introduce HoloScene unification (single Canvas)
- Does not introduce Lab, Network discovery, Mobile/PWA, Electron packaging, Google integrations, daily notes
- Does not modify `HoloScene.tsx` (stays as-is until Phase 3 replaces it)
- Does not remove `SYSTEM_TELEMETRY_ENABLED` flag (Phase 4 owns that)
- Does not initialize claude-mem MCP, auto-memoria, tokenMeter, or any data dirs
- Does not add patterns for secret/environment files to `.gitignore` — that lives in Phase 1 when the first secret arrives

These are owned by Phases 1-10 per the spec roadmap.
