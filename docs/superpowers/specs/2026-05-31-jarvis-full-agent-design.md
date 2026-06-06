# Jarvis Full Agent Redesign — Design Spec
**Date:** 2026-05-31  
**Status:** Approved  
**Scope:** Phase 1 — MCP agent voice pipeline

---

## Goal

Replace the regex-based intent routing in the Jarvis voice pipeline with a fully contextual Claude agent that decides what to do using MCP tools, with no hardcoded phrases or heuristics.

---

## Architecture

### Current flow
```
STT → speech.js → intentClassifier (regex routes) → specific handler OR Claude
```

### New flow
```
STT → speech.js → attention gate → ClaudeSession (MCP) → tool calls → response
```

The attention gate (speaker confidence ≥ 0.65, ENGAGED/ATTENTIVE/PASSIVE states, alwaysOn) is the **only** logic that runs before Claude. It answers "should Jarvis respond?" — not "what should it do?".

Everything else is Claude's decision via MCP tools.

---

## What Changes

### `backend/src/handlers/speech.js`

**Remove** all intent-specific handlers:
- `timer_control`, `chrono_control`
- `nav_goto`, `nav_back`, `nav_right`, `nav_left`
- `reminder_create`, `reminder_list`, `notify_now`
- `cloud_save`, `cloud_read`
- `task_create`, `note_create`, `query_tasks`, `query_notes`, `personalize`
- `query_science`, `query_research`

**Keep (Phase 2 will move these to MCP):**
- Attention gate logic (unchanged)
- `self_build` handler — requires FS write + route hot-reload, no MCP equivalent yet
- `activate_skill` handler — no MCP equivalent yet
- Final `sessionAskStream` call (now handles ALL turns)

**ExtraContext per turn:**
- Date/time in Bogotá (so Claude can calculate "mañana a las 8" without calling `current_time`)
- Nothing else — Claude queries everything else via tools

### `backend/src/lib/intentClassifier.js`

**Remove** from `detectIntentTag()`:
- `timer_control`, `chrono_control`, `nav_*`, `reminder_*`, `notify_now`
- `cloud_*`, `task_create`, `note_create`, `query_*`, `personalize`

**Keep:**
- All `shouldRespond` logic (attention gate)
- `self_build` and `activate_skill` detection (no MCP tools yet)

Everything else returns `'chat'` and goes to Claude.

---

## New MCP Tools (7 additions to `jarvis-mcp.js`)

These cover operations currently handled by intent-specific code in `speech.js` that have no MCP equivalent yet.

| Tool | Input | Backend endpoint |
|------|-------|-----------------|
| `obsidian_task_create` | `{ text: string }` | `POST /api/skills/obsidian/task` |
| `obsidian_note_create` | `{ body: string }` | `POST /api/skills/obsidian/note` |
| `obsidian_task_list` | `{}` | `GET /api/skills/obsidian/tasks` |
| `obsidian_note_search` | `{ query: string }` | `POST /api/skills/obsidian/search` |
| `obsidian_personalize` | `{ fact: string }` | `POST /api/skills/obsidian/personalize` |
| `cloud_save` | `{ content: string, filename?: string, category?: string }` | `POST /api/skills/cloud/save` |
| `cloud_list` | `{ limit?: number }` | `GET /api/skills/cloud/list` |

Each backend endpoint is a thin HTTP handler that calls the existing `obsidian.js` / `cloudStorage.js` functions. Routes registered in `routes.js`.

---

## System Prompt (new `SPEECH_SYSTEM_PROMPT`)

```
Eres Jarvis, el asistente personal de inteligencia artificial de Santiago. 
Hablas por voz, en español de Colombia.

IDENTIDAD: Leal, sereno y eficiente, al estilo del Jarvis de Iron Man. 
Tratas al usuario de "señor". Tienes ingenio sutil y seco. Eres preciso 
y vas un paso adelante.

MODO DE OPERACIÓN: Tienes herramientas disponibles para ejecutar acciones 
reales en la aplicación y en los sistemas del señor. Úsalas — no las 
describas, hazlas. Si necesitas saber qué está visible en la interfaz, 
llama view_current. Si el señor pide algo que encaja en una herramienta, 
llámala antes de responder. Si te falta información para completar la 
acción (duración, etiqueta, hora), pregunta antes de llamar.

CONFIRMACIÓN: Confirma acciones brevemente ("Listo, señor", "Hecho"). 
Si una acción falla, dilo con franqueza sin inventar. Si algo ya está 
en el estado que el señor pide, díselo con tacto.

ESTILO VOZ: Una a tres oraciones. Sin emojis, markdown, rutas de archivo, 
ni URLs. Sin frases de relleno ("dame un segundo", "déjame ver", "claro 
que sí"). Ve directo al contenido. NUNCA menciones "tool", "MCP", "API", 
"handler" — habla siempre en lenguaje natural.

NÚMEROS: Notación natural española. Decimales con "coma" ("uno coma 
cuatro"). Sin coma de miles. Nunca repitas la pregunta del señor.
```

The prompt does **not** list tool names or signatures — Claude discovers them automatically from the MCP server's `ListTools` response.

---

## MCP Infrastructure (unchanged)

- Lean config dir: `~/.jarvis-claude-cfg-mcp/settings.json` — exists, correct
- MCP server: `backend/mcp-server/jarvis-mcp.js` — starts correctly
- `ClaudeSession` already uses `ensureLeanConfigDirWithMcp()` — no changes needed

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| MCP server fails to start | Claude responds conversationally, can't execute tools, says so naturally (no "No such tool available" error since system prompt doesn't mention tool names) |
| skillBus not connected | MCP tool gets 503 `renderer_not_connected` → Claude: "La interfaz no está disponible, señor" |
| Claude CLI timeout (>30s) | Existing fallback: "No tengo respuesta en este momento." |
| Missing tool input | Claude asks before calling ("¿De cuántos minutos, señor?") |
| MCP fails globally | System degrades to Claude conversational only — no crashes, no cryptic errors |

---

## Out of Scope (Phase 2)

- `self_build` → MCP tool `self_build(capability)`: expose `handleSelfBuild` as `POST /api/skills/selfbuild` + register in `jarvis-mcp.js`
- `activate_skill` → MCP tool: expose `activateSkill` as `POST /api/skills/skill/activate` + register in `jarvis-mcp.js`
- Model routing (haiku/sonnet/opus by intent) — defer; Claude handles complexity within one model

---

## Files Touched

| File | Change |
|------|--------|
| `backend/src/handlers/speech.js` | Remove all intent handlers except `self_build`; simplify to attention gate + Claude |
| `backend/src/lib/intentClassifier.js` | Remove all intent tags except `self_build`; keep `shouldRespond` logic |
| `backend/mcp-server/jarvis-mcp.js` | Add 7 Obsidian + cloud tools |
| `backend/src/handlers/skillTools.js` | Add Obsidian + cloud HTTP handlers |
| `backend/src/routes.js` | Register 7 new `/api/skills/obsidian/*` and `/api/skills/cloud/*` routes |
