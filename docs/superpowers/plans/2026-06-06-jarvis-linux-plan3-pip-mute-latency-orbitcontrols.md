# Plan 3 — PIP State, VOICE_MUTED, ACK Latency, OrbitControls

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement VOICE_MUTED sub-state, two-track ACK response latency, PIP boot state, and OrbitControls mouse fallback for the 3D viewer.

**Architecture:** Add VOICE_MUTED flag to `attentionState.js`; add `toggle_gestures` and `voice_muted` intent tags to `intentClassifier.js`; add ACK_MAP + VOICE_MUTED gate + gesture-toggle handler to `speech.js`; add PIP to `bootStore.ts` and two new renderer primitives to `primitives.ts`; add `OrbitControls` to `Model3DViewer.tsx` enabled only when gestures are off; add backend `uiState.js` handler for ui-state and gesture-toggle endpoints.

**Tech Stack:** Node ESM (Vitest tests), TypeScript + React 19 + Zustand, @react-three/drei (already installed), existing skillBus WS channel.

**Repo:** `c:\proyecto\jarvis-linux` — all paths relative to repo root.

---

## File map

| Action | File |
|---|---|
| Modify | `backend/src/lib/attentionState.js` |
| Create | `backend/tests/attentionState.unit.test.js` |
| Modify | `backend/src/lib/intentClassifier.js` |
| Modify | `backend/src/handlers/speech.js` |
| Modify | `backend/src/handlers/wakeWord.js` |
| Create | `backend/src/handlers/uiState.js` |
| Modify | `backend/src/routes.js` |
| Create | `backend/tests/uiState.unit.test.js` |
| Modify | `frontend/src/state/bootStore.ts` |
| Modify | `frontend/src/skills/primitives.ts` |
| Modify | `frontend/src/components/Model3DViewer.tsx` |

---

## Task P3-T1: attentionState.js — VOICE_MUTED state

**Files:**
- Modify: `backend/src/lib/attentionState.js`
- Create: `backend/tests/attentionState.unit.test.js`

VOICE_MUTED is a boolean flag independent of the ENGAGED/ATTENTIVE/PASSIVE time-based states. It's set by the `voice_muted` intent in `speech.js` and cleared by `wakeWord.js` on wake detection and by the clap handler (Task P3-T4).

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/attentionState.unit.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getAttentionState,
  markInteraction,
  forcePassive,
  getLastInteractionAgo,
  setVoiceMuted,
  isVoiceMuted,
} from '../src/lib/attentionState.js'

beforeEach(() => {
  // Reset module state between tests by clearing mute and interaction
  setVoiceMuted(false)
  forcePassive()  // reset attention to known state
})

describe('VOICE_MUTED state', () => {
  it('isVoiceMuted() returns false by default', () => {
    expect(isVoiceMuted()).toBe(false)
  })

  it('setVoiceMuted(true) enables mute', () => {
    setVoiceMuted(true)
    expect(isVoiceMuted()).toBe(true)
  })

  it('setVoiceMuted(false) clears mute', () => {
    setVoiceMuted(true)
    setVoiceMuted(false)
    expect(isVoiceMuted()).toBe(false)
  })

  it('markInteraction() does NOT clear mute', () => {
    setVoiceMuted(true)
    markInteraction()
    expect(isVoiceMuted()).toBe(true)
  })

  it('VOICE_MUTED is independent of attention state', () => {
    setVoiceMuted(true)
    markInteraction()
    expect(getAttentionState()).toBe('ENGAGED')
    expect(isVoiceMuted()).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd backend && npx vitest run tests/attentionState.unit.test.js
```

Expected: FAIL — `setVoiceMuted is not a function`

- [ ] **Step 3: Add VOICE_MUTED to attentionState.js**

In `backend/src/lib/attentionState.js`, after the existing `let forcedPassive = false` line, add:

```js
let voiceMuted = false

export function setVoiceMuted(v) {
  voiceMuted = Boolean(v)
}

export function isVoiceMuted() {
  return voiceMuted
}
```

**Do NOT change `markInteraction()`** — it must not clear voiceMuted (cleared only by clap/wake word).

- [ ] **Step 4: Run tests to verify they pass**

```
cd backend && npx vitest run tests/attentionState.unit.test.js
```

Expected: 5/5 PASS

- [ ] **Step 5: Run full backend suite to check no regressions**

```
cd backend && npm test
```

Expected: all existing + 5 new = 78 PASS

- [ ] **Step 6: Commit**

```
cd backend
git add src/lib/attentionState.js tests/attentionState.unit.test.js
git commit -m "feat(linux): add VOICE_MUTED flag to attentionState (isVoiceMuted/setVoiceMuted)"
```

---

## Task P3-T2: intentClassifier.js — toggle_gestures + voice_muted intents

**Files:**
- Modify: `backend/src/lib/intentClassifier.js`

Add two new intent tags detected before the catch-all `'chat'`. No separate test file — the existing test suite (if any) covers classifyIntent; add inline tests at bottom of this task.

- [ ] **Step 1: Write the failing test**

There is no `intentClassifier.unit.test.js` yet. Create one:

```js
// backend/tests/intentClassifier.unit.test.js
import { describe, it, expect } from 'vitest'
import { classifyIntent } from '../src/lib/intentClassifier.js'

const ENGAGED_CTX = { state: 'ENGAGED', speakerConfidence: 1.0, alwaysOn: true }

describe('toggle_gestures intent', () => {
  it('detects "activa gestos"', () => {
    const r = classifyIntent('activa gestos', ENGAGED_CTX)
    expect(r.intentTag).toBe('toggle_gestures')
  })

  it('detects "desactiva los gestos"', () => {
    const r = classifyIntent('desactiva los gestos', ENGAGED_CTX)
    expect(r.intentTag).toBe('toggle_gestures')
  })
})

describe('voice_muted intent', () => {
  it('detects "jarvis no escuches"', () => {
    const r = classifyIntent('jarvis no escuches', ENGAGED_CTX)
    expect(r.intentTag).toBe('voice_muted')
  })

  it('detects "ignórame"', () => {
    const r = classifyIntent('ignórame', ENGAGED_CTX)
    expect(r.intentTag).toBe('voice_muted')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd backend && npx vitest run tests/intentClassifier.unit.test.js
```

Expected: FAIL — intentTag is 'chat', not 'toggle_gestures' / 'voice_muted'

- [ ] **Step 3: Add regex + detectIntentTag entries**

In `backend/src/lib/intentClassifier.js`, after the existing `ACTIVATE_SKILL_RE` line (around line 28), add:

```js
const TOGGLE_GESTURES_RE = /\b(activa|desactiva|enciende|apaga)\s+(los?\s+)?gestos\b/i
const VOICE_MUTED_RE = /\b(no\s+escuches|ign[oó]ra(me)?|modo\s+silencio|silencio\s+de\s+voz)\b/i
```

In `detectIntentTag(text)`, add before the `return 'chat'` line:

```js
if (TOGGLE_GESTURES_RE.test(text)) { console.log('[intent] -> toggle_gestures:', text); return 'toggle_gestures' }
if (VOICE_MUTED_RE.test(text))    { console.log('[intent] -> voice_muted:', text);    return 'voice_muted' }
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd backend && npx vitest run tests/intentClassifier.unit.test.js
```

Expected: 4/4 PASS

- [ ] **Step 5: Run full backend suite**

```
cd backend && npm test
```

Expected: 82 PASS (78 + 4 new)

- [ ] **Step 6: Commit**

```
git add backend/src/lib/intentClassifier.js backend/tests/intentClassifier.unit.test.js
git commit -m "feat(linux): add toggle_gestures + voice_muted intent detection"
```

---

## Task P3-T3: speech.js — VOICE_MUTED gate + ACK_MAP + two-track + gesture toggle

**Files:**
- Modify: `backend/src/handlers/speech.js`

Three additions to `speech.js`:
1. Import `setVoiceMuted, isVoiceMuted` from attentionState and `requestClient, hasClient` from skillBus
2. Add `ACK_MAP` constant
3. In `runSpeechTurn`: add VOICE_MUTED gate at top, add `voice_muted` + `toggle_gestures` handlers after speaker gate, add ACK-before-Claude for remaining intents

No new tests — the 82 existing pass; just verify the suite.

- [ ] **Step 1: Add imports to speech.js**

Find the existing import line (line 12):
```js
import { getAttentionState, markInteraction, forcePassive } from '../lib/attentionState.js'
```

Replace it with:
```js
import { getAttentionState, markInteraction, forcePassive, setVoiceMuted, isVoiceMuted } from '../lib/attentionState.js'
```

After the block of imports (after line 26, after the speakerContext import), add:
```js
import { requestClient as skillBusRequest, hasClient as skillBusHasClient } from '../lib/skillBus.js'
```

- [ ] **Step 2: Add ACK_MAP constant**

After the `UNKNOWN_OPENERS` array (after line 137), add:

```js
// Instant acknowledgement strings for high-latency intent paths.
// Spoken immediately (<300ms) on Track A; Track B (Claude/function) fires concurrently.
const ACK_MAP = {
  show_3d:         'Preparando visor 3D, señor.',
  navigate:        'Navegando.',
  render_formula:  'Calculando.',
  reminder_create: 'Anotado, señor.',
  timer_start:     'Temporizador iniciado.',
  gesture_toggle:  'Gestos actualizados.',
  voice_muted:     'Entendido, señor. No escucho más comandos hasta nuevo aviso.',
}
```

- [ ] **Step 3: Add VOICE_MUTED gate at top of runSpeechTurn**

`runSpeechTurn` starts at line 165. After the line:
```js
  if (!text) return { action: 'ignore', reason: 'empty' }
```

Add:
```js
  // VOICE_MUTED gate — block all speech while muted.
  // Cleared only by wake word (wakeWord.js) or double clap (DormantLayer).
  if (isVoiceMuted()) {
    return { action: 'voice_muted_block', state: getAttentionState() }
  }
```

- [ ] **Step 4: Add voice_muted + toggle_gestures handlers**

Find the block after the `filterIntentsByMode` check (after line 219, the `intent_blocked` return). Insert BEFORE the `self_build` block (line 222):

```js
  // voice_muted intent: activate mute, speak ACK, return early (no Claude needed).
  if (intentTag === 'voice_muted') {
    setVoiceMuted(true)
    const ack = ACK_MAP.voice_muted
    addAssistantMessage(ack)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: ack }).catch(() => {})
    onSentence(ack)
    return { action: 'voice_muted', reply: ack, state }
  }

  // toggle_gestures intent: push gesture_set primitive to renderer via skill bus.
  if (intentTag === 'toggle_gestures') {
    const enable = /activa|enciende/i.test(text.toLowerCase())
    if (skillBusHasClient()) {
      try { await skillBusRequest('gesture_set', { enabled: enable }) } catch {}
    }
    const ack = ACK_MAP.gesture_toggle
    addAssistantMessage(ack)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: ack }).catch(() => {})
    onSentence(ack)
    return { action: 'gestures_toggled', enabled: enable, reply: ack, state }
  }
```

- [ ] **Step 5: Add ACK-before-Claude (two-track Track A)**

Find the line `const model = pickModel(intentTag)` (around line 274). Just BEFORE it, add:

```js
  // Two-track response: speak ACK instantly on Track A so the user hears
  // acknowledgement in <300ms. Claude processes on Track B (streaming) in parallel.
  if (ACK_MAP[intentTag]) {
    onSentence(ACK_MAP[intentTag])
  }
```

- [ ] **Step 6: Verify full backend suite still passes**

```
cd backend && npm test
```

Expected: 82 PASS (no regressions)

- [ ] **Step 7: Commit**

```
git add backend/src/handlers/speech.js
git commit -m "feat(linux): add VOICE_MUTED gate + ACK_MAP two-track + gesture toggle to speech.js"
```

---

## Task P3-T4: wakeWord.js — clear VOICE_MUTED on wake detection

**Files:**
- Modify: `backend/src/handlers/wakeWord.js`
- Modify: `backend/tests/wakeWord.unit.test.js` (add 1 test)

When a wake word fires, Jarvis exits VOICE_MUTED automatically (the spec says "wake word bypasses the mute").

- [ ] **Step 1: Read current wakeWord.unit.test.js**

Open `backend/tests/wakeWord.unit.test.js` — note existing 4 tests and the vi.mock setup.

- [ ] **Step 2: Add failing test**

In `backend/tests/wakeWord.unit.test.js`, add inside the existing describe block:

```js
  it('handleWakeDetected clears VOICE_MUTED', async () => {
    vi.mock('../src/lib/attentionState.js', () => ({
      getAttentionState: vi.fn(() => 'ENGAGED'),
      markInteraction: vi.fn(),
      setVoiceMuted: vi.fn(),
      isVoiceMuted: vi.fn(() => false),
    }))
    const { setVoiceMuted } = await import('../src/lib/attentionState.js')
    const { handleWakeDetected } = await import('../src/handlers/wakeWord.js')
    const body = JSON.stringify({ confidence: 0.9, ts: Date.now() })
    const req = { method: 'POST', headers: { 'content-length': String(body.length), 'content-type': 'application/json' }, on: (e, cb) => { if (e === 'data') cb(Buffer.from(body)); if (e === 'end') cb(); return req; } }
    const res = { statusCode: 0, headers: {}, setHeader(k,v){this.headers[k]=v}, end(b){this.body=b} }
    await handleWakeDetected(req, res)
    expect(setVoiceMuted).toHaveBeenCalledWith(false)
  })
```

Note: wakeWord.unit.test.js already uses vi.mock for attentionState and speakerContext. Check the existing file and follow the same mock pattern. If mocks conflict, adjust to match the existing test structure.

- [ ] **Step 3: Run test to verify it fails**

```
cd backend && npx vitest run tests/wakeWord.unit.test.js
```

Expected: 4 PASS, 1 FAIL — setVoiceMuted not called

- [ ] **Step 4: Add setVoiceMuted to handleWakeDetected**

In `backend/src/handlers/wakeWord.js`, add import at top:
```js
import { markInteraction, setVoiceMuted } from '../lib/attentionState.js'
```

(The existing import likely only imports `markInteraction` — extend it.)

In `handleWakeDetected`, after `resetSession()` and `markInteraction()` calls, add:
```js
  setVoiceMuted(false)
```

- [ ] **Step 5: Run tests**

```
cd backend && npx vitest run tests/wakeWord.unit.test.js
```

Expected: 5/5 PASS

- [ ] **Step 6: Full suite**

```
cd backend && npm test
```

Expected: 83 PASS

- [ ] **Step 7: Commit**

```
git add backend/src/handlers/wakeWord.js backend/tests/wakeWord.unit.test.js
git commit -m "feat(linux): wake-detected clears VOICE_MUTED sub-state"
```

---

## Task P3-T5: uiState.js + routes.js — ui-state and gesture-toggle endpoints

**Files:**
- Create: `backend/src/handlers/uiState.js`
- Modify: `backend/src/routes.js`
- Create: `backend/tests/uiState.unit.test.js`

`POST /api/jarvis/ui-state { state: 'pip'|'awake' }` → pushes `boot_pip` or `boot_awake` primitive to renderer via skillBus.

`POST /api/skills/gestures/toggle { enabled: boolean }` → pushes `gesture_set` primitive via skillBus.

- [ ] **Step 1: Write failing tests**

Create `backend/tests/uiState.unit.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/skillBus.js', () => ({
  requestClient: vi.fn().mockResolvedValue({ ok: true }),
  hasClient: vi.fn(() => true),
}))

const mockRes = () => {
  const r = { statusCode: 0, headers: {}, body: '' }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.end = (b) => { r.body = b }
  return r
}

function makeReq(bodyObj) {
  const body = JSON.stringify(bodyObj)
  const req = {
    method: 'POST',
    headers: { 'content-length': String(body.length), 'content-type': 'application/json' },
  }
  req.on = (e, cb) => {
    if (e === 'data') cb(Buffer.from(body))
    if (e === 'end') cb()
    return req
  }
  return req
}

describe('handleUiState', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pip state pushes boot_pip primitive', async () => {
    const { requestClient } = await import('../src/lib/skillBus.js')
    const { handleUiState } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleUiState(makeReq({ state: 'pip' }), res)
    expect(requestClient).toHaveBeenCalledWith('boot_pip', {})
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('awake state pushes boot_awake primitive', async () => {
    const { requestClient } = await import('../src/lib/skillBus.js')
    const { handleUiState } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleUiState(makeReq({ state: 'awake' }), res)
    expect(requestClient).toHaveBeenCalledWith('boot_awake', {})
  })

  it('invalid state returns 400', async () => {
    const { handleUiState } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleUiState(makeReq({ state: 'invalid' }), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('handleGestureToggle', () => {
  it('pushes gesture_set with enabled flag', async () => {
    const { requestClient } = await import('../src/lib/skillBus.js')
    const { handleGestureToggle } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleGestureToggle(makeReq({ enabled: true }), res)
    expect(requestClient).toHaveBeenCalledWith('gesture_set', { enabled: true })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd backend && npx vitest run tests/uiState.unit.test.js
```

Expected: FAIL — cannot find module `../src/handlers/uiState.js`

- [ ] **Step 3: Create uiState.js**

Create `backend/src/handlers/uiState.js`:

```js
/**
 * UI state handler — lets the frontend request window state transitions
 * (PIP ↔ AWAKE) and gesture toggle via HTTP, which the backend relays
 * to the connected renderer through the skill bus.
 *
 * POST /api/jarvis/ui-state   { state: 'pip'|'awake' }
 * POST /api/skills/gestures/toggle  { enabled: boolean }
 */

import { json, readBody } from '../lib/http.js'
import { requestClient, hasClient } from '../lib/skillBus.js'

const VALID_UI_STATES = new Set(['pip', 'awake'])

export async function handleUiState(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'bad_request' })
  }

  const state = String(body?.state ?? '').toLowerCase()
  if (!VALID_UI_STATES.has(state)) {
    return json(res, 400, { ok: false, error: 'invalid_state', valid: [...VALID_UI_STATES] })
  }

  if (!hasClient()) {
    return json(res, 503, { ok: false, error: 'renderer_not_connected' })
  }

  const verb = state === 'pip' ? 'boot_pip' : 'boot_awake'
  try {
    const result = await requestClient(verb, {})
    return json(res, 200, { ok: true, state, result })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'skill_bus_failed', detail: e.message })
  }
}

export async function handleGestureToggle(req, res) {
  let body
  try {
    body = await readBody(req)
  } catch {
    return json(res, 400, { ok: false, error: 'bad_request' })
  }

  const enabled = Boolean(body?.enabled)

  if (!hasClient()) {
    return json(res, 503, { ok: false, error: 'renderer_not_connected' })
  }

  try {
    const result = await requestClient('gesture_set', { enabled })
    return json(res, 200, { ok: true, enabled, result })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'skill_bus_failed', detail: e.message })
  }
}
```

- [ ] **Step 4: Register routes in routes.js**

In `backend/src/routes.js`, add import near the top:
```js
import { handleUiState, handleGestureToggle } from './handlers/uiState.js'
```

In the `routes` array, add after the wake-calibrate route:
```js
  { method: 'POST', path: '/api/jarvis/ui-state',           handler: handleUiState },
  { method: 'POST', path: '/api/skills/gestures/toggle',    handler: handleGestureToggle },
```

- [ ] **Step 5: Run uiState tests**

```
cd backend && npx vitest run tests/uiState.unit.test.js
```

Expected: 4/4 PASS

- [ ] **Step 6: Full suite**

```
cd backend && npm test
```

Expected: 87 PASS

- [ ] **Step 7: Commit**

```
git add backend/src/handlers/uiState.js backend/src/routes.js backend/tests/uiState.unit.test.js
git commit -m "feat(linux): add ui-state + gestures/toggle endpoints (PIP + gesture_set skill bus bridge)"
```

---

## Task P3-T6: bootStore.ts + primitives.ts — PIP state + new primitives

**Files:**
- Modify: `frontend/src/state/bootStore.ts`
- Modify: `frontend/src/skills/primitives.ts`

Add `'PIP'` to `BootState`. Add `boot_pip`, `boot_awake`, `gesture_set` primitives.

- [ ] **Step 1: Modify bootStore.ts**

Open `frontend/src/state/bootStore.ts`. It currently has:
```ts
export type BootState = 'DORMANT' | 'AWAKE'
```

Replace with:
```ts
export type BootState = 'DORMANT' | 'AWAKE' | 'PIP'
```

The store interface currently has `setBootState`, `silentWake`. Add `enterPip` and `leavePip`:

```ts
interface BootStore {
  bootState: BootState
  setBootState: (state: BootState) => void
  silentWake: () => void
  enterPip: () => void
  leavePip: () => void
}

export const useBootStore = create<BootStore>((set) => ({
  bootState: 'DORMANT',
  setBootState: (bootState) => set({ bootState }),
  silentWake: () => set({ bootState: 'AWAKE' }),
  enterPip: () => set({ bootState: 'PIP' }),
  leavePip: () => set({ bootState: 'AWAKE' }),
}))
```

- [ ] **Step 2: Add primitives to primitives.ts**

In `frontend/src/skills/primitives.ts`, the imports near line 252 already include `useBootStore` and `useGestureStore`. If `useGestureStore` is not already imported, add it:
```ts
import { useGestureStore } from '../state/gestureStore'
```

Add three new primitive functions before the `PRIMITIVES` map (around line 344):

```ts
/** Enter PIP (mini window) mode. */
async function bootPip(): Promise<unknown> {
  useBootStore.getState().enterPip()
  // Attempt to resize the Chromium app window. This is best-effort;
  // Chromium kiosk mode may ignore it on some Linux compositors.
  try { window.resizeTo(400, 300) } catch {}
  return { bootState: 'PIP' }
}

/** Return to full-screen AWAKE mode from PIP. */
async function bootAwake(): Promise<unknown> {
  useBootStore.getState().leavePip()
  try { window.resizeTo(window.screen.width, window.screen.height) } catch {}
  return { bootState: 'AWAKE' }
}

/** Enable or disable the gesture pipeline. */
async function gestureSet(payload: { enabled?: boolean } = {}): Promise<unknown> {
  const enabled = Boolean(payload.enabled)
  useGestureStore.getState().setEnabled(enabled)
  return { gestureEnabled: enabled }
}
```

In the `PRIMITIVES` map, add:
```ts
  boot_pip:     bootPip,
  boot_awake:   bootAwake,
  gesture_set:  gestureSet,
```

- [ ] **Step 3: Run frontend tests**

```
cd frontend && npm test -- --run
```

Expected: existing count PASS, no regressions. (No new frontend test files for this task — the primitives are integration-level and covered by the backend contract tests.)

- [ ] **Step 4: Commit**

```
git add frontend/src/state/bootStore.ts frontend/src/skills/primitives.ts
git commit -m "feat(linux): add PIP boot state + boot_pip/boot_awake/gesture_set primitives"
```

---

## Task P3-T7: Model3DViewer.tsx — OrbitControls + gesture check toast

**Files:**
- Modify: `frontend/src/components/Model3DViewer.tsx`

When `gestureStore.enabled === false`, enable `<OrbitControls>` (mouse drag/scroll). When gestures are off and the viewer opens, show a toast "¿Activar gestos para el visor 3D?" with [Sí] / [No] buttons.

- [ ] **Step 1: Add OrbitControls import**

At the top of `frontend/src/components/Model3DViewer.tsx`, add after the `@react-three/fiber` import:
```ts
import { OrbitControls } from '@react-three/drei'
```

Also ensure `useEffect, useState` are imported from `react` (they already are — check the existing import list at line 10).

- [ ] **Step 2: Pass gestureEnabled to Scene**

The `Scene` function (line 282) currently takes `{ spec }`. Change its signature and add OrbitControls:

```tsx
function Scene({ spec, gestureEnabled }: { spec: Model3DSpec; gestureEnabled: boolean }) {
  return (
    <>
      <color attach="background" args={['#060d12']} />
      <ambientLight intensity={0.4} color="#38d5ff" />
      <pointLight position={[5, 5, 5]} intensity={1.2} color="#ffffff" />
      <pointLight position={[-5, -3, -5]} intensity={0.6} color="#0059ff" />
      {!gestureEnabled && <OrbitControls makeDefault enablePan={true} />}
      {spec.kind === 'parametric' && <ParametricObject spec={spec} />}
      {spec.kind === 'polytope' && <PolytopeObject spec={spec} />}
      {spec.kind === 'implicit' && <ImplicitObject spec={spec} />}
    </>
  )
}
```

- [ ] **Step 3: Update Model3DViewer to pass gestureEnabled + show toast**

The `Model3DViewer` function (line 298) needs:
1. Read `gestureEnabled` from gestureStore
2. State for gesture check toast visibility
3. Toast component when open + gestures off

Replace the existing `Model3DViewer` function with:

```tsx
export function Model3DViewer() {
  const open = useModel3dStore(s => s.open)
  const spec = useModel3dStore(s => s.spec)
  const hide = useModel3dStore(s => s.hide)
  const gestureEnabled = useGestureStore(s => s.enabled)
  const setGestureEnabled = useGestureStore(s => s.setEnabled)
  const [showGesturePrompt, setShowGesturePrompt] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hide])

  // On open: if gestures are off, prompt to activate them
  useEffect(() => {
    if (open && !gestureEnabled) {
      setShowGesturePrompt(true)
    }
  }, [open])

  if (!open || !spec) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 5000,
      background: 'rgba(4, 10, 16, 0.96)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px', color: '#38d5ff', fontSize: 13, letterSpacing: 1,
        textTransform: 'uppercase', borderBottom: '1px solid rgba(56,213,255,0.2)',
      }}>
        <span>{spec.title ?? (spec.kind === 'polytope' ? `${spec.dimension}D ${spec.type}` : spec.kind === 'implicit' ? 'Isosuperficie' : 'Superficie')}</span>
        <button
          onClick={hide}
          style={{ background: 'transparent', border: 'none', color: '#7fa6b8', cursor: 'pointer', fontSize: 20 }}
          aria-label="Cerrar"
        >×</button>
      </div>

      {/* 3D canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        <Canvas camera={{ position: [0, 0, 12], fov: 40 }} gl={{ localClippingEnabled: true }}>
          <Scene spec={spec} gestureEnabled={gestureEnabled} />
        </Canvas>

        {/* Gesture activation prompt */}
        {showGesturePrompt && (
          <div style={{
            position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(4, 13, 26, 0.92)', border: '1px solid rgba(56,213,255,0.4)',
            borderRadius: 8, padding: '10px 18px',
            color: '#ccd6f6', fontSize: 12, letterSpacing: 0.5,
            display: 'flex', alignItems: 'center', gap: 12,
            backdropFilter: 'blur(8px)',
          }}>
            <span>¿Activar gestos para el visor 3D?</span>
            <button
              onClick={() => { setGestureEnabled(true); setShowGesturePrompt(false) }}
              style={{ background: 'rgba(56,213,255,0.15)', border: '1px solid rgba(56,213,255,0.5)', borderRadius: 4, color: '#38d5ff', cursor: 'pointer', padding: '3px 10px', fontSize: 11 }}
            >Sí</button>
            <button
              onClick={() => setShowGesturePrompt(false)}
              style={{ background: 'transparent', border: '1px solid rgba(100,130,150,0.4)', borderRadius: 4, color: '#7fa6b8', cursor: 'pointer', padding: '3px 10px', fontSize: 11 }}
            >No</button>
          </div>
        )}
      </div>

      {/* Footer hint — changes by control mode */}
      <div style={{
        padding: '6px 20px', color: 'rgba(56,213,255,0.4)', fontSize: 11,
        borderTop: '1px solid rgba(56,213,255,0.1)',
        textAlign: 'center',
      }}>
        {gestureEnabled
          ? 'Puño cerrado: rotar · Pinch: zoom · Esc: cerrar'
          : 'Arrastra: rotar · Scroll: zoom · Esc: cerrar'}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Build frontend to check TypeScript**

```
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds, no type errors.

- [ ] **Step 5: Run frontend tests**

```
cd frontend && npm test -- --run
```

Expected: all pass (no regressions).

- [ ] **Step 6: Commit**

```
git add frontend/src/components/Model3DViewer.tsx
git commit -m "feat(linux): add OrbitControls mouse fallback + gesture-check toast to Model3DViewer"
```

---

## Final verification

After all 7 tasks complete:

```
cd /c/proyecto/jarvis-linux
cd backend && npm test  # expect 87 PASS
cd ../frontend && npm test -- --run  # expect existing count PASS
git log --oneline -10
```

Verify the new commits are present and the test count is 87+ backend, frontend unchanged.
