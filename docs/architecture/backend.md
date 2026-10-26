# Backend (backend/src)

> Extraído de CLAUDE.md. Detalle de referencia: leer antes de tocar esta zona.

### Backend (`backend/src/`)

`server.js` — thin `http.createServer`. Static frontend served before API dispatch (`handlers/static.js`). WebSocket upgrades dispatched by path in a single `upgrade` listener.

**Handlers** (`handlers/`): `health`, `modules`, `telemetry`, `jarvis` (TTS/turn/tts-WS), `stt` (HTTP upload + WS proxy to Python), `speech` (intent gate → Claude CLI), `speakerId` (voice sample CRUD), `mobile` (QR token auth), `mobileGesture` (WS for phone gestures), `skillTools` (all `/api/skills/*` endpoints), `uiState`, `pcControl`, `obsidian`, `security`, `config`, `wakeWord`, `selfBuild`.

**Libs** (`lib/`):
- `skillBus.js` — duplex WS channel (`/api/skills/bus`) from Node backend → AWAKE renderer. `requestClient(verb, payload)` sends a primitive request and awaits correlated response. Falls back to `nativePrimitives.js` if no renderer connected.
- `attentionState.js` + `intentClassifier.js` — speech intent gate. States: `ENGAGED` (0–15 s), `ATTENTIVE` (15–60 s), `PASSIVE` (>60 s). Speaker confidence ≥ 0.65 required.
- `conversationMemory.js` — sliding 8-turn window, in-process global (resets on restart).
- `claudeCli.js` — spawns `claude --print --model ...` with conversation context.
- `secrets.js` — loads **`backend/data/secrets.local.json`** (gitignored) into `process.env` at boot. **La ruta es `data/`, no la raíz de `backend/`** — un `backend/secrets.local.json` se ignora en silencio y parece que la clave «no se cargó». Env existente GANA sobre el fichero, así que una variable ya puesta en el `.service` no se puede sobrescribir desde aquí.
- `linuxKeyring.js` — Linux equivalent of Windows DPAPI. Uses `secret-tool` (libsecret) for machine-scoped AES-256-GCM key; falls back to `~/.config/jarvis/machine.key` (chmod 600) on headless.
- `obsidian.js` — reads/writes vault via filesystem. `portableVault.js` for encrypted portable storage.
- `telegramBot.js`, `reminders.js`, `cloudflareTunnel.js`, `pdfWatcher.js` — background services started at boot.
- `tailscale.js` — Tailscale URL for mobile QR pairing outside LAN.

**Agent system** (`agent/`):
- `bridge.js` — WS at `/api/jarvis/agent/ws`. Duplex link between frontend capability registry and the backend brain. Protocol: frontend sends `hello` (tools + snapshot), then `turn` (user utterance) or `tool_result`; backend replies with `tool_call` or `final` (spoken reply).
- `brain.js` — the AI decision layer, called by the bridge.

**Services** (`services/`): `jarvisBot.js` (Telegram voice bot), `cloudBot.js`, `notifier.js`.

**MCP server** (`backend/mcp-server/`): Separate Node ESM package. Exposes all Jarvis skills (timer, chrono, reminder, navigation, Obsidian, display, 3D, cloud) as MCP tools over stdio. Claude Code connects to it via `.mcp.json`. Run `npm install` inside this directory if `node_modules/` is missing.

- **`nativePrimitives.js` is still Windows-first.** Camera enumeration (PnP/PowerShell) and photo capture (ffmpeg dshow) target Windows. On Linux these paths will fail silently; skill bus renderer path (`capture_photo` via MediaPipe) is the working fallback.

