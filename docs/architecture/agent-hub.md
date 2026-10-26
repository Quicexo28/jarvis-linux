# Agent Hub (agentes Claude Code)

> Extraído de CLAUDE.md. Detalle de referencia: leer antes de tocar esta zona.

### Agent Hub — agentes Claude Code (`handlers/claudeAgents.js`)

Centro de control de TODOS los agentes Claude Code del señor (los de su terminal y los que lanza Jarvis), en repo aparte: `~/Projects/Agent Hub`, servicio **`claude-agenthub`** en `127.0.0.1:8796` (no confundir con `jarvis-agenthub`, el hub de máquinas en 8794/8795). UI web propia + API; lee `~/.claude/{sessions,jobs,projects}` y el uso de la cuenta.

- **Jarvis → hub**: rutas `/api/skills/claude/{list,launch,send,stop,watch,unwatch,open}` → tools MCP `claude_agents`, `claude_agent_launch|send|stop|watch|unwatch`, `claude_agents_open`. El handler traduce vocabulario de voz: proyecto por nombre hablado (`resolveProjectDir`: "app gym" → `~/Projects/app-gym`) y agente por descripción (el hub resuelve texto libre; si hay varios devuelve `409` + `candidates` y la voz pregunta cuál).
- **Riesgo**: `launch`/`send` son DESTRUCTIVE en `toolRisk.js` (lanzan un agente con permisos, igual que `code_task`); `list` es READ; todo `/api/skills/claude/` es local-only en `webAuth`. Mutaciones al hub llevan `x-agent-hub: 1` (su barrera anti-CSRF).
- **Hub → Jarvis (avisos)**: SOLO si el señor lo pide (`claude_agent_watch` o `notify=true` al lanzar). El hub hace POST a `/api/claude-agents/event` (local-only) al terminar; el handler habla por el skill bus (`speak_text`) y/o Telegram, y cae a Telegram si la UI duerme. Watch de un solo uso; si el backend está caído el hub reintenta 30 min.
- **Autodesarrollo ≠ Agent Hub**: cambios al código de Jarvis siguen por `code_task`; `claude_agent_launch` es para OTROS proyectos. El prompt de voz (`CLAUDE_AGENTS_PROMPT_SECTION` en `speech.js`) lo dice explícitamente.
- Env: `CLAUDE_HUB_URL` (default `http://127.0.0.1:8796`), `CLAUDE_HUB_PROJECTS_DIR` (default `~/Projects`), `CLAUDE_HUB_BROWSER` (default `chromium`, para `open`). Tests: `tests/claudeAgents.unit.test.js` (hub falso).

