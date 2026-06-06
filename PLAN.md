# Phase 0 — Progress Tracker

> Compact reference for executing Phase 0 task-by-task.
> Full spec: `docs/superpowers/specs/2026-04-30-jarvis-claude-integration-design.md`
> Full plan: `docs/superpowers/plans/2026-04-30-jarvis-phase-0-foundation.md`

## Status

| Task | Description | Status | Commit |
|------|-------------|--------|--------|
| T1 | git init + .gitignore + baseline commit | ✅ done | `aff581a` |
| T2 | backend vitest infra + sanity test | ✅ done | `e7366eb` |
| T3 | characterization tests (8 contract) | ✅ done | `b9daa20` |
| T4 | extract lib/http.js + lib/exec.js | ✅ done | `da80df8` |
| T5 | extract handlers/ modules | ✅ done | `e1d8668` |
| T6 | build routes.js + slim server.js | ✅ done | `826db06` |
| T7 | frontend vitest infra + sanity test | ✅ done | `af08afe` |
| T8 | extract types.ts | ✅ done | `766e67e` |
| T9 | extract constants.ts | ✅ done | `459d324` |
| T10 | extract modes/ (Plan2D, Plan3D, Space) | ✅ done | `23b6f3f` |
| T11 | api/client.ts + getApiBase() TDD | ✅ done | `3bf12f5` |
| T12 | replace hardcoded API_BASE in App.tsx | ✅ done | `7565351` |
| T13 | install zustand + empty stores | ✅ done | `190be33` |
| T14 | wire App.tsx state → useJarvisStore | ✅ done | `2bda043` |
| T15 | final verify + tag v0.2.0-phase0 | ✅ done | `64c44a6` |
| REV | final code review entire Phase 0 | ⬜ | — |

---

## T4 — Extract lib/http.js and lib/exec.js

**Files:** create `backend/src/lib/http.js`, `backend/src/lib/exec.js`; modify `backend/src/server.js`

**lib/http.js:**
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
      try { const raw = Buffer.concat(chunks).toString('utf8'); resolve(raw ? JSON.parse(raw) : {}) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}
```

**lib/exec.js:**
```js
import { exec as execCb } from 'child_process'
export function execCmd(command, timeoutMs = 3000) {
  return new Promise((resolve) => {
    execCb(command, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve('')
      resolve(String(stdout || stderr || '').trim())
    })
  })
}
```

**server.js changes:** replace first 3 import lines with:
```js
import http from 'http'
import os from 'os'
import { json, readBody } from './lib/http.js'
import { execCmd } from './lib/exec.js'
```
Then delete lines 7-39 (the three function declarations).

**Commit:** `refactor(backend): extract http and exec helpers to src/lib/`

---

## T5 — Extract handlers/

**Files to create:** `backend/src/handlers/health.js`, `modules.js`, `jarvis.js`, `telemetry.js`

- **health.js:** exports `handleHealth` → `json(res,200,{status:'ok',service:'jarvis-backend'})`
- **modules.js:** exports `handleModules` → `json(res,200,{modules:[...]})`
- **jarvis.js:** exports `handleDeviceAction`, `handleJarvisTurn` (verbatim from server.js, import `json,readBody` from `../lib/http.js`)
- **telemetry.js:** exports `handleTelemetry` + private helpers (`lastCpuSnapshot`, `lastNetSnapshot`, `takeCpuSnapshot`, `getGpuTelemetry`, `getNetworkTelemetry`, `getCpuTelemetry`, `getOpenClawTelemetry`) — imports `os` + `json` from `../lib/http.js` + `execCmd` from `../lib/exec.js`

**server.js NOT changed in T5** (handlers exist but server still has inline if/else — tests still pass).

**Commit:** `refactor(backend): extract handlers into src/handlers/ (server.js still inlines)`

---

## T6 — routes.js + slim server.js

**Create `backend/src/routes.js`:**
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
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true })
  const match = routes.find((r) => r.method === req.method && r.path === req.url)
  if (!match) return json(res, 404, { ok: false, error: 'not_found' })
  return match.handler(req, res)
}
```

**Overwrite `backend/src/server.js`:**
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

server.listen(port, host, () => console.log(`Jarvis backend on http://${host}:${port}`))
```

**Run tests, all 9 must pass. Commit:** `refactor(backend): replace inline if/else with routes.js dispatcher`

---

## T7 — Frontend vitest

Install: `cd frontend && npm install --save-dev vitest@^2.0.0 @vitest/ui@^2.0.0 jsdom@^25.0.0 @types/node@^22.0.0`

Add to `frontend/package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:ui": "vitest --ui"`

Create `frontend/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  test: { globals: false, environment: 'jsdom', include: ['src/**/*.test.ts','src/**/*.test.tsx'], testTimeout: 5000 },
})
```

In `frontend/tsconfig.json` compilerOptions add `"types": ["node"]`.

Create `frontend/src/sanity.test.ts`: `import {test,expect} from 'vitest'; test('vitest is wired up in frontend',()=>expect(1+1).toBe(2))`

Run, 1 test passes. **Commit:** `test(frontend): add vitest infrastructure with sanity check`

---

## T8 — types.ts

Move type declarations from `frontend/src/App.tsx` (lines ~8-20) into `frontend/src/types.ts` with `export` prefix. Replace in App.tsx with `import type { Mode, HoloMode, Segment, SavedPlan, SceneEntity, Viewpoint, SystemTelemetry } from './types'`. Run `tsc --noEmit`. **Commit:** `refactor(frontend): extract types from App.tsx into types.ts`

---

## T9 — constants.ts

Move constants block from App.tsx (`GRID_CELLS`, `CELL_METERS`, `VIEWBOX_SIZE`, `STEP`, `PLAN_STORAGE_KEY`, `PLAN3D_ENTITY_STORAGE_KEY`, `PLAN3D_VIEWPOINT_STORAGE_KEY`, `modeMeta`) into `frontend/src/constants.ts` (export each, import `Mode` from `./types`). Leave `API_BASE` and `SYSTEM_TELEMETRY_ENABLED` in App.tsx for now. Run `tsc --noEmit`. **Commit:** `refactor(frontend): extract constants and modeMeta into constants.ts`

---

## T10 — modes/

Extract three components from App.tsx into their own files:

- `frontend/src/modes/Plan2DEditor.tsx` — `snap` (local), `loadSavedPlans` (exported), `Plan2DEditor` (exported)
- `frontend/src/modes/Plan3DViewer.tsx` — `loadEntityStore`, `loadViewpointStore`, `EntityPrimitive`, `Plan3DViewer` (all exported)
- `frontend/src/modes/SpaceViewer.tsx` — `SpaceViewer` (exported); helpers `ImmersiveFirstPersonController`, `GazeDetector` (private)

After each extraction: `tsc --noEmit` must pass. Manual smoke test all 3 modes (2D editor, 3D viewer, immersive). **Commit:** `refactor(frontend): extract Plan2DEditor, Plan3DViewer, SpaceViewer into modes/`

---

## T11 — api/client.ts (TDD)

Create test first: `frontend/src/api/client.test.ts` with 6 tests for `getApiBase`, `setApiBase`, `clearApiBase`, `request`. Run → fails (no impl). Create `frontend/src/api/client.ts`. Run → all 6 pass. **Commit:** `feat(frontend): add api/client.ts with API_BASE resolver and request helper`

---

## T12 — Replace API_BASE in App.tsx

Remove `const API_BASE = 'http://127.0.0.1:8788'`. Add `import { getApiBase } from './api/client'`. Replace `${API_BASE}` with `${getApiBase()}` in all 3 fetch calls. `tsc --noEmit`. **Commit:** `refactor(frontend): replace hardcoded API_BASE with getApiBase() resolver`

---

## T13 — Zustand stores

`npm install zustand@^5.0.0`. Create:
- `frontend/src/state/jarvisStore.ts` — `useJarvisStore` (mode, voiceEnabled, wakeListening, wakePhrase, coreInput, coreReply, focusedEntity, housePlans, entitiesByPlan, viewpointByPlan + setters)
- `frontend/src/state/systemStore.ts` — `useSystemStore` (tokensWindow5h, tokensWeek, modelStats, activeModel, services, containers, routines)
- `frontend/src/state/networkStore.ts` — `useNetworkStore` (discoveredDevices, roomAssignments, presenceByZone + setters)
- `frontend/src/state/jarvisStore.test.ts` — 4 tests for store actions

Run all frontend tests (sanity + client + store = 11 total). **Commit:** `feat(frontend): scaffold zustand stores (jarvis, system, network)`

---

## T14 — Slim App.tsx

Replace `useState` calls for `mode`, `voiceEnabled`, `wakeListening`, `wakePhrase`, `coreInput`, `coreReply` with `useJarvisStore` reads. Keep as `useState`: `housePlanKey`, `houseEditorMode`, `listening`, `systemTelemetry`, `wakeRecognitionRef`. Convert updater-form setters to direct value setters. `tsc --noEmit`. Run all tests. Manual smoke test 10 paths. **Commit:** `refactor(frontend): wire App.tsx state through useJarvisStore`

---

## T15 — Final verification + tag

1. Run all tests: backend (9) + frontend (11) all pass
2. `wc -l frontend/src/App.tsx` → 80-200 lines
3. Check file inventory (`find frontend/src -name "*.ts" -o -name "*.tsx"`)
4. `npm run build` succeeds
5. Add `.claude/` and `*.log` to `.gitignore`
6. Update `CLAUDE.md` frontend section to reflect post-Phase-0 layout
7. `git tag -a v0.2.0-phase0 -m "Phase 0 complete: foundation refactor (no UI changes)"`

**Commits:** `docs: update CLAUDE.md for post-Phase-0 frontend layout` + tag
