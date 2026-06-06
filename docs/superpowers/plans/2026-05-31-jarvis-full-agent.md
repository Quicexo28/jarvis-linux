# Jarvis Full Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the regex-based intent routing in the Jarvis voice pipeline with a fully contextual Claude MCP agent — no hardcoded phrases, Claude decides all actions via tool calls.

**Architecture:** All voice turns pass through the attention gate and then directly to `ClaudeSession` (which already uses `~/.jarvis-claude-cfg-mcp` with the jarvis MCP server). Claude discovers available tools automatically via MCP `ListTools`. New Obsidian and cloud MCP tools are added so operations previously handled by regex handlers in `speech.js` are now handled by Claude natively.

**Tech Stack:** Node.js ESM backend, Vitest, `@modelcontextprotocol/sdk` (already in `backend/mcp-server/node_modules`), existing `obsidian.js` / `cloudStorage.js` libs.

**Spec:** `docs/superpowers/specs/2026-05-31-jarvis-full-agent-design.md`

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `backend/src/handlers/skillTools.js` | Modify | Add 5 Obsidian + 2 cloud HTTP handlers |
| `backend/src/routes.js` | Modify | Register 7 new `/api/skills/obsidian/*` and `/api/skills/cloud/*` routes |
| `backend/mcp-server/jarvis-mcp.js` | Modify | Add 7 tool entries to `TOOLS` array |
| `backend/src/lib/intentClassifier.js` | Modify | Remove all intent tags except `self_build` + `activate_skill`; remove nav/timer constants added in earlier session |
| `backend/src/handlers/speech.js` | Modify | Remove all intent-specific handlers; new agent system prompt; simplified extraContext |
| `backend/tests/agent.contract.test.js` | Create | Contract tests for the 7 new skill endpoints |

---

## Task 1 — Add Obsidian HTTP handlers to `skillTools.js`

**Files:**
- Modify: `backend/src/handlers/skillTools.js`

- [ ] **Step 1: Add imports**

At the top of `backend/src/handlers/skillTools.js`, after the existing imports, add:

```javascript
import {
  writeTask,
  writeNote,
  listOpenTasks,
  searchNotes,
  updatePersonalization,
} from '../lib/obsidian.js'
import { saveToCloud, listCloudFiles } from '../lib/cloudStorage.js'
```

> `notifyJarvis` is already imported from `cloudStorage.js` — do NOT add a duplicate import. Just add `saveToCloud` and `listCloudFiles` to the destructure of the existing `import { notifyJarvis } from '../lib/cloudStorage.js'` line:

```javascript
// BEFORE:
import { notifyJarvis } from '../lib/cloudStorage.js'

// AFTER:
import { notifyJarvis, saveToCloud, listCloudFiles } from '../lib/cloudStorage.js'
```

- [ ] **Step 2: Add Obsidian handlers at end of file**

Append to `backend/src/handlers/skillTools.js`:

```javascript
/* ----- OBSIDIAN ----- */

export async function handleObsidianTaskCreate(req, res) {
  return withBody(req, async (body) => {
    const text = String(body.text || '').trim()
    if (!text) return json(res, 400, { ok: false, error: 'missing_text' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const result = await writeTask(speakerName, { text, source: 'voice' })
      return json(res, 200, { ok: true, result })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

export async function handleObsidianNoteCreate(req, res) {
  return withBody(req, async (body) => {
    const text = String(body.body || '').trim()
    if (!text) return json(res, 400, { ok: false, error: 'missing_body' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const result = await writeNote(speakerName, { body: text })
      return json(res, 200, { ok: true, result })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

export async function handleObsidianTaskList(req, res) {
  const speakerName = (req.url.split('?')[1] || '')
    .split('&')
    .find(p => p.startsWith('speaker='))
    ?.split('=')[1] ?? null
  try {
    const tasks = await listOpenTasks(speakerName ? decodeURIComponent(speakerName) : null)
    return json(res, 200, { ok: true, result: { tasks } })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
  }
}

export async function handleObsidianNoteSearch(req, res) {
  return withBody(req, async (body) => {
    const query = String(body.query || '').trim()
    if (!query) return json(res, 400, { ok: false, error: 'missing_query' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const matches = await searchNotes(speakerName, query)
      return json(res, 200, { ok: true, result: { matches } })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

export async function handleObsidianPersonalize(req, res) {
  return withBody(req, async (body) => {
    const fact = String(body.fact || '').trim()
    if (!fact) return json(res, 400, { ok: false, error: 'missing_fact' })
    const speakerName = body.speaker_name ? String(body.speaker_name) : null
    try {
      const result = await updatePersonalization(speakerName, { fact })
      return json(res, 200, { ok: true, result })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'obsidian_failed', detail: e.message })
    }
  }, res)
}

/* ----- CLOUD ----- */

export async function handleCloudSave(req, res) {
  return withBody(req, async (body) => {
    const content = String(body.content || '').trim()
    if (!content) return json(res, 400, { ok: false, error: 'missing_content' })
    const filename = body.filename ? String(body.filename) : undefined
    const category = body.category ? String(body.category) : undefined
    try {
      const saved = saveToCloud(content, filename, category)
      return json(res, 200, { ok: true, result: { filename: saved.filename, path: saved.path } })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'cloud_failed', detail: e.message })
    }
  }, res)
}

export async function handleCloudList(req, res) {
  const params = new URLSearchParams(req.url.split('?')[1] || '')
  const limit = Math.max(1, Math.min(50, Number(params.get('limit') || 12)))
  try {
    const files = listCloudFiles(null, limit)
    return json(res, 200, { ok: true, result: { files } })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'cloud_failed', detail: e.message })
  }
}
```

- [ ] **Step 3: Verify syntax**

```bash
cd backend && node --input-type=module --eval "import './src/handlers/skillTools.js'; console.log('OK')"
```

Expected: `OK`

---

## Task 2 — Register routes in `routes.js`

**Files:**
- Modify: `backend/src/routes.js`

- [ ] **Step 1: Add imports**

In `backend/src/routes.js`, find the `handleTimerStart, handleTimerPause, ...` import block from `./handlers/skillTools.js` and extend it:

```javascript
// Find this block and add the new handlers at the end:
import {
  handleTimerStart, handleTimerPause, handleTimerResume, handleTimerAdd,
  handleTimerCancel, handleTimerReset, handleTimerList,
  handleChronoStart, handleChronoPause, handleChronoResume, handleChronoReset,
  handleChronoLap, handleChronoCancel, handleChronoList,
  handleReminderCreate, handleReminderList, handleNotifyNow, handleTimeNow,
  handleViewOpen, handleViewClose, handleViewCurrent, handleRingRotate,
  handleOverlayOpen, handleOverlayClose, handleSystemSleep,
  handleVoiceToggle, handleClapToggle,
  // NEW:
  handleObsidianTaskCreate, handleObsidianNoteCreate, handleObsidianTaskList,
  handleObsidianNoteSearch, handleObsidianPersonalize,
  handleCloudSave, handleCloudList,
} from './handlers/skillTools.js'
```

- [ ] **Step 2: Register the 7 routes**

After the last `clap/toggle` route in the `routes` array, append:

```javascript
  // Obsidian skill tools
  { method: 'POST', path: '/api/skills/obsidian/task',        handler: handleObsidianTaskCreate },
  { method: 'POST', path: '/api/skills/obsidian/note',        handler: handleObsidianNoteCreate },
  { method: 'GET',  path: '/api/skills/obsidian/tasks',       handler: handleObsidianTaskList },
  { method: 'POST', path: '/api/skills/obsidian/search',      handler: handleObsidianNoteSearch },
  { method: 'POST', path: '/api/skills/obsidian/personalize', handler: handleObsidianPersonalize },

  // Cloud skill tools
  { method: 'POST', path: '/api/skills/cloud/save',           handler: handleCloudSave },
  { method: 'GET',  path: '/api/skills/cloud/list',           handler: handleCloudList },
```

- [ ] **Step 3: Verify syntax**

```bash
cd backend && node --input-type=module --eval "import './src/routes.js'; console.log('OK')"
```

Expected: `OK`

---

## Task 3 — Write and run contract tests for new endpoints

**Files:**
- Create: `backend/tests/agent.contract.test.js`

- [ ] **Step 1: Write the test file**

```javascript
// backend/tests/agent.contract.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { dispatch } from '../src/routes.js'

let server
let base

beforeAll(async () => {
  process.env.JARVIS_FAKE_CLAUDE = '1'
  server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    await dispatch(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((r) => server.close(r)))

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

async function get(path) {
  const r = await fetch(`${base}${path}`)
  return { status: r.status, body: await r.json() }
}

describe('Obsidian skill endpoints', () => {
  it('POST /api/skills/obsidian/task — 400 on missing text', async () => {
    const { status, body } = await post('/api/skills/obsidian/task', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_text')
  })

  it('POST /api/skills/obsidian/task — responds (ok or error, not 404)', async () => {
    const { status } = await post('/api/skills/obsidian/task', { text: 'Test task' })
    expect(status).not.toBe(404)
  })

  it('POST /api/skills/obsidian/note — 400 on missing body', async () => {
    const { status, body } = await post('/api/skills/obsidian/note', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_body')
  })

  it('POST /api/skills/obsidian/note — responds (ok or error, not 404)', async () => {
    const { status } = await post('/api/skills/obsidian/note', { body: 'Test note' })
    expect(status).not.toBe(404)
  })

  it('GET /api/skills/obsidian/tasks — responds with tasks array or error', async () => {
    const { status, body } = await get('/api/skills/obsidian/tasks')
    expect(status).not.toBe(404)
    if (status === 200) expect(Array.isArray(body.result?.tasks)).toBe(true)
  })

  it('POST /api/skills/obsidian/search — 400 on missing query', async () => {
    const { status, body } = await post('/api/skills/obsidian/search', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_query')
  })

  it('POST /api/skills/obsidian/personalize — 400 on missing fact', async () => {
    const { status, body } = await post('/api/skills/obsidian/personalize', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_fact')
  })
})

describe('Cloud skill endpoints', () => {
  it('POST /api/skills/cloud/save — 400 on missing content', async () => {
    const { status, body } = await post('/api/skills/cloud/save', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_content')
  })

  it('POST /api/skills/cloud/save — 200 with filename + path', async () => {
    const { status, body } = await post('/api/skills/cloud/save', { content: 'hello test' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.result.filename).toBe('string')
  })

  it('GET /api/skills/cloud/list — 200 with files array', async () => {
    const { status, body } = await get('/api/skills/cloud/list')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.result.files)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests**

```bash
cd backend && npm test
```

Expected: all 31 existing tests pass + 10 new tests pass (41 total).

> If Obsidian tests fail with 500 (vault not configured on CI), that's acceptable — the test checks `not 404`, which validates the route is registered. Only 400 validation tests must pass in all environments.

- [ ] **Step 3: Commit**

```bash
git add backend/src/handlers/skillTools.js backend/src/routes.js backend/tests/agent.contract.test.js
git commit -m "feat(mcp): add Obsidian + cloud HTTP handlers and routes"
```

---

## Task 4 — Add 7 tools to `jarvis-mcp.js`

**Files:**
- Modify: `backend/mcp-server/jarvis-mcp.js`

- [ ] **Step 1: Insert 7 tool definitions into TOOLS array**

Find the last tool entry in the TOOLS array (currently `toggle_clap_wake`) and add after it, before the closing `]`:

```javascript
  /* ----- Obsidian ----- */
  {
    name: 'obsidian_task_create',
    description: 'Crea una tarea en la bóveda Obsidian del señor. Úsalo cuando el señor diga "recuérdame", "anótame", "agéndame", "pon en mi lista", "nueva tarea".',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Descripción de la tarea a crear' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['text'],
    },
    method: 'POST', path: '/api/skills/obsidian/task',
  },
  {
    name: 'obsidian_note_create',
    description: 'Guarda una nota en Obsidian. Úsalo cuando el señor diga "toma nota", "guarda esto", "apúntame".',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Contenido de la nota' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['body'],
    },
    method: 'POST', path: '/api/skills/obsidian/note',
  },
  {
    name: 'obsidian_task_list',
    description: 'Lista las tareas abiertas del señor en Obsidian.',
    inputSchema: { type: 'object', properties: {} },
    method: 'GET', path: '/api/skills/obsidian/tasks',
  },
  {
    name: 'obsidian_note_search',
    description: 'Busca notas en Obsidian por texto o tema.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar en las notas' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['query'],
    },
    method: 'POST', path: '/api/skills/obsidian/search',
  },
  {
    name: 'obsidian_personalize',
    description: 'Guarda un dato personal del señor en Obsidian (preferencias, datos biográficos, etc.). Úsalo cuando el señor diga "recuerda que", "soy", "mi cumpleaños es", "prefiero".',
    inputSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'El dato o preferencia a recordar' },
        speaker_name: { type: 'string', description: 'Nombre del speaker (opcional)' },
      },
      required: ['fact'],
    },
    method: 'POST', path: '/api/skills/obsidian/personalize',
  },

  /* ----- Cloud ----- */
  {
    name: 'cloud_save',
    description: 'Guarda contenido en la nube personal del señor y notifica por Telegram. Úsalo cuando el señor pida "sube esto a la nube", "guárdalo en mi nube", "ponlo en la nube".',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Contenido del archivo a guardar' },
        filename: { type: 'string', description: 'Nombre del archivo (opcional, se genera si no se indica)' },
        category: { type: 'string', description: 'Categoría del archivo (opcional, ej: "Documentos")' },
      },
      required: ['content'],
    },
    method: 'POST', path: '/api/skills/cloud/save',
  },
  {
    name: 'cloud_list',
    description: 'Lista los archivos recientes en la nube del señor.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Número máximo de archivos a retornar (default 12)' },
      },
    },
    method: 'GET', path: '/api/skills/cloud/list',
  },
```

- [ ] **Step 2: Verify MCP server starts without errors**

```bash
cd backend/mcp-server && timeout 3 node jarvis-mcp.js; echo "exit $?"
```

Expected: process exits cleanly after 3 seconds (it listens on stdio, so timeout is expected). No import errors.

- [ ] **Step 3: Commit**

```bash
git add backend/mcp-server/jarvis-mcp.js
git commit -m "feat(mcp): add 7 Obsidian + cloud tools to jarvis MCP server"
```

---

## Task 5 — Simplify `intentClassifier.js`

**Files:**
- Modify: `backend/src/lib/intentClassifier.js`

This task reverts the nav/timer changes from the previous bugfix session and strips out all intents except `self_build` + `activate_skill`.

- [ ] **Step 1: Replace the constants block (lines 50–110 approximately)**

Find and replace everything from the TIMER_RE comment block through the closing `}` of `detectViewMode`, replacing with the minimal version:

```javascript
// Timer and chrono regex — kept for reference by speech.js legacy handlers
// but no longer used for routing (Claude handles via MCP).
const TIMER_RE = /\b(temporizador(es)?|cuenta\s+(regresiva|atr[aá]s)|alarma\s+(de|en|por|para)|timer)s?\b/i
const CHRONO_RE = /\b(cron[oó]metro|cron[oó]metra|stopwatch|cuenta\s+(progresiva|hacia\s+arriba))\b/i
```

- [ ] **Step 2: Replace `detectIntentTag` function**

Find the entire `function detectIntentTag(text) { ... }` block and replace with:

```javascript
function detectIntentTag(text) {
  // Only two intents bypass Claude — both lack MCP tools in Phase 1.
  // Everything else goes to Claude (MCP decides the action).
  if (SELF_BUILD_RE.test(text))    { console.log('[intent] -> self_build:', text);    return 'self_build' }
  if (ACTIVATE_SKILL_RE.test(text)) { console.log('[intent] -> activate_skill:', text); return 'activate_skill' }
  return 'chat'
}
```

- [ ] **Step 3: Remove unused exports**

Remove the `export function detectViewMode(text) { ... }` block entirely (it was added in the previous session for nav intent detection that is now gone).

- [ ] **Step 4: Remove the import of detectViewMode from speech.js**

In `backend/src/handlers/speech.js`, change:

```javascript
// BEFORE:
import { classifyIntent, detectViewMode } from '../lib/intentClassifier.js'

// AFTER:
import { classifyIntent } from '../lib/intentClassifier.js'
```

- [ ] **Step 5: Verify syntax**

```bash
cd backend && node -e "import('./src/lib/intentClassifier.js').then(m => { console.log('exports:', Object.keys(m)); const r = m.classifyIntent('pon un temporizador', {state:'ENGAGED', speakerConfidence:0.9, alwaysOn:true}); console.log('timer → tag:', r.intentTag); const r2 = m.classifyIntent('muestrame la casa', {state:'ENGAGED', speakerConfidence:0.9, alwaysOn:true}); console.log('nav → tag:', r2.intentTag); }).catch(e => console.error(e))"
```

Expected:
```
exports: [ 'classifyIntent' ]
timer → tag: chat
nav → tag: chat
```

---

## Task 6 — Strip `speech.js` intent handlers + new system prompt

**Files:**
- Modify: `backend/src/handlers/speech.js`

This is the largest change. The file needs its imports cleaned up, the system prompt replaced, and all intent-specific handlers removed.

- [ ] **Step 1: Replace the import block**

Replace everything from `import { json, readBody }` through the last import line with:

```javascript
import { json, readBody } from '../lib/http.js'
import { getAttentionState, markInteraction, forcePassive } from '../lib/attentionState.js'
import { classifyIntent } from '../lib/intentClassifier.js'
import { addUserMessage, addAssistantMessage } from '../lib/conversationMemory.js'
import { sessionAsk, sessionAskStream, warmSession } from '../lib/claudeCli.js'
import { appendHistoryEntry } from '../lib/obsidian.js'
import { handleSelfBuild } from './selfBuild.js'
import { activateSkill } from '../lib/skillRegistry.js'
import { findSkillByText, invokeRoute } from '../lib/skillManifest.js'
import { routes } from '../routes.js'
```

> Removed: `runClaude`, `pickModel`, `writeTask`, `writeNote`, `updatePersonalization`, `listOpenTasks`, `searchNotes`, `getPersonalization`, `saveToCloud`, `listCloudFiles`, `notifySanti`, `notifyJarvis`, `parseReminder`, `addReminder`, `listReminders`, `parseTimerCommand`, `parseChronoCommand`, `requestClient as skillBusRequest`, `hasClient as skillBusHasClient`, `detectViewMode`, `intentRouter`, `modelRouter`, `cloudStorage (direct)`.

- [ ] **Step 2: Replace SPEECH_SYSTEM_PROMPT**

Find the `const SPEECH_SYSTEM_PROMPT = \`...\`` constant and replace its entire content:

```javascript
const SPEECH_SYSTEM_PROMPT = `Eres Jarvis, el asistente personal de inteligencia artificial de Santiago. Hablas por voz, en español de Colombia.

IDENTIDAD: Leal, sereno y eficiente, al estilo del Jarvis de Iron Man. Tratas al usuario de "señor". Tienes ingenio sutil y seco, pero nunca eres payaso ni exagerado. Eres preciso y vas un paso adelante.

MODO DE OPERACION: Tienes herramientas disponibles para ejecutar acciones reales en la aplicacion y en los sistemas del señor. Usalas — no las describas, hazlas. Si necesitas saber que esta visible en la interfaz, llama view_current. Si el señor pide algo que encaja en una herramienta, llamala antes de responder. Si te falta informacion para completar la accion (duracion, etiqueta, hora), pregunta antes de llamar.

CONFIRMACION: Confirma acciones brevemente ("Listo, señor", "Hecho", "Enseguida"). Si una accion falla, dilo con franqueza sin inventar. Si algo ya esta en el estado que el señor pide, díselo con tacto.

ESTILO VOZ: Una a tres oraciones. Sin emojis, markdown, rutas de archivo, ni URLs. Sin frases de relleno ("dame un segundo", "dejame ver", "buena pregunta", "claro que si"). Ve directo al contenido. NUNCA menciones "tool", "MCP", "API", "handler" — habla siempre en lenguaje natural.

NUMEROS: Notacion natural española. Decimales con "coma" ("uno coma cuatro"). Sin coma de miles. Nunca repitas la pregunta del señor.`
```

- [ ] **Step 3: Replace `runSpeechTurn` body**

Find the `async function runSpeechTurn(body, ...)` function and replace its entire body with:

```javascript
async function runSpeechTurn(body, { onSentence = () => {} } = {}) {
  const text = String(body.text ?? '').trim()
  const speakerConfidence = Number(body.speakerConfidence ?? 0)
  const alwaysOn = Boolean(body.alwaysOn)

  if (!text) return { action: 'ignore', reason: 'empty' }

  const state = getAttentionState()
  const classification = classifyIntent(text, { state, speakerConfidence, alwaysOn })

  if (classification.isSleepCommand) {
    forcePassive()
    return { action: 'sleep', reason: 'sleep_command' }
  }

  if (!classification.shouldRespond) {
    return { action: 'ignore', reason: classification.reason, score: classification.score, state }
  }

  addUserMessage(text)
  markInteraction()

  const speakerName = body.speakerName ?? null
  const intentTag = classification.intentTag || 'chat'

  // self_build: generate a new dynamic capability — cannot go through MCP (FS + restart).
  if (intentTag === 'self_build') {
    const reply = await handleSelfBuild({ capability: text })
    addAssistantMessage(reply)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: reply }).catch(() => {})
    onSentence(reply)
    return { action: 'respond', reply, intentTag, score: classification.score, state }
  }

  // activate_skill: activate a pre-built skill by name — no MCP tool yet.
  if (intentTag === 'activate_skill') {
    const match = text.match(/\b(c[aá]mara|temporizador|timer|alertas?|notificaciones?)\b/i)
    const skillName = match
      ? match[1].toLowerCase().replace(/á/g, 'a').replace(/é/g, 'e')
      : 'desconocida'
    activateSkill(skillName)
    const reply = skillName !== 'desconocida'
      ? `Habilidad de ${skillName} activada. Reinicia Jarvis para que surta efecto.`
      : 'No identifiqué qué habilidad activar. Intenta de nuevo con el nombre exacto.'
    addAssistantMessage(reply)
    onSentence(reply)
    return { action: 'respond', reply, intentTag, score: classification.score, state }
  }

  // chat: try a matching pre-built skill trigger first (instant, no Claude).
  if (intentTag === 'chat') {
    const skill = findSkillByText(text)
    if (skill) {
      const route = routes.find((r) => r.method === skill.method && r.path === skill.path)
      if (route) {
        let reply = 'Hecho, señor.'
        try {
          const result = await invokeRoute(route, {})
          if (result && typeof result.spoken === 'string' && result.spoken) reply = result.spoken
        } catch (e) {
          reply = 'Intenté usar esa habilidad pero falló, señor.'
          console.warn('[speech] skill invoke failed:', e.message)
        }
        addAssistantMessage(reply)
        appendHistoryEntry(speakerName, { userText: text, assistantReply: reply }).catch(() => {})
        onSentence(reply)
        return { action: 'respond', reply, intentTag: 'invoke_skill', skill: skill.slug, state }
      }
    }
  }

  // All other turns — Claude as agent with MCP tools.
  // Inject current date/time so Claude can calculate reminder times without calling current_time.
  const now = new Date()
  const timeContext = `\nFecha y hora actual (Colombia): ${now.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' })}.`

  const sentencer = makeSentencer(onSentence)
  const reply = await sessionAskStream(text, {
    systemPromptText: SPEECH_SYSTEM_PROMPT,
    timeoutMs: 45000,
    extraContext: timeContext,
    model: 'haiku',
    fallbackReply: 'No tengo respuesta en este momento.',
  }, (delta) => sentencer.push(delta))
  sentencer.end()

  addAssistantMessage(reply)
  appendHistoryEntry(speakerName, { userText: text, assistantReply: reply }).catch(() => {})

  return { action: 'respond', reply, intentTag, score: classification.score, state }
}
```

- [ ] **Step 4: Verify syntax**

```bash
cd backend && node --input-type=module --eval "import './src/handlers/speech.js'; console.log('OK')"
```

Expected: `OK`

- [ ] **Step 5: Run full test suite**

```bash
cd backend && npm test
```

Expected: all tests pass (the contract tests use `JARVIS_FAKE_CLAUDE=1` so no real Claude calls happen).

- [ ] **Step 6: Commit**

```bash
git add backend/src/handlers/speech.js backend/src/lib/intentClassifier.js
git commit -m "feat(agent): full MCP agent pipeline — remove regex intent routing

All voice turns now go to Claude via MCP. Removed handlers: timer_control,
chrono_control, nav_*, reminder_*, notify_now, cloud_*, task/note/query_*,
personalize, query_science/research. Kept: self_build, activate_skill (Phase 2).
New agent system prompt — no tool names in text, Claude discovers via MCP.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7 — Verify end-to-end

- [ ] **Step 1: Start backend in dev mode**

```bash
cd backend && npm run dev
```

Watch for:
- `[speech] warming Claude session at boot...` — ClaudeSession starts with MCP lean dir
- No MCP error logs
- `[mcp] jarvis server connected` or similar from Claude CLI (optional, depends on verbosity)

- [ ] **Step 2: Test timer via voice (manual)**

Say: *"necesito un temporizador de cinco minutos para la pasta"*

Expected:
- Claude calls `timer_start(seconds=300, label="pasta")` via MCP
- Frontend opens timer panel and creates the timer
- Jarvis replies: *"Listo, señor. Temporizador de cinco minutos para la pasta."*
- No "No such tool available" error

- [ ] **Step 3: Test navigation via voice (manual)**

Say: *"muéstrame la casa"*

Expected:
- Claude calls `view_open(view="house")` via MCP
- Frontend navigates to house view
- Jarvis replies: *"Aquí está la casa, señor."*

- [ ] **Step 4: Test context-awareness (manual)**

Say: *"¿qué hay abierto?"*

Expected:
- Claude calls `view_current` via MCP
- Receives JSON state (current mode, overlays, boot state)
- Jarvis responds describing the current state naturally

- [ ] **Step 5: Test fallback (manual — MCP unavailable)**

Stop the backend, modify `~/.jarvis-claude-cfg-mcp/settings.json` temporarily to point the MCP server to a nonexistent path, restart backend.

Say: *"pon un temporizador de dos minutos"*

Expected:
- Claude responds conversationally (can't call tools)
- NO "No such tool available" error spoken aloud
- Natural degradation: *"Lo siento, señor, no pude iniciarlo en este momento."*

Restore the settings.json after testing.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| Remove regex intent routing from speech.js | Task 6 |
| Keep attention gate | Task 6 (preserved in runSpeechTurn) |
| Keep self_build, activate_skill | Task 6 |
| New agent system prompt | Task 6 |
| Add obsidian_task_create | Tasks 1 + 2 + 4 |
| Add obsidian_note_create | Tasks 1 + 2 + 4 |
| Add obsidian_task_list | Tasks 1 + 2 + 4 |
| Add obsidian_note_search | Tasks 1 + 2 + 4 |
| Add obsidian_personalize | Tasks 1 + 2 + 4 |
| Add cloud_save | Tasks 1 + 2 + 4 |
| Add cloud_list | Tasks 1 + 2 + 4 |
| Error handling: no cryptic errors when MCP fails | Task 6 (system prompt + no tool names) |
| ExtraContext: date/time only | Task 6 |
| intentClassifier: strip to self_build + activate_skill | Task 5 |

**Placeholder scan:** None found.

**Type consistency:**
- `handleObsidianTaskCreate` defined in Task 1, imported in Task 2, tested in Task 3 — consistent.
- `SPEECH_SYSTEM_PROMPT` fully written in Task 6 step 2.
- `sessionAskStream` signature unchanged — compatible with Task 6 step 3.
