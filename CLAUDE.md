# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Run commands

Independent services — separate terminals (or via systemd in production).

- **Backend** (Node ESM): `cd backend && npm run dev` — boots on `http://0.0.0.0:8788`. Tests: `npm test`.
- **Frontend** (Vite dev): `cd frontend && npm run dev` — port 5173. Build: `npm run build`. Tests: `npm test`.
- **Tauri dev** (desktop shell + frontend): `cd frontend && npm run tauri` — launches Tauri window, registers Super+J global shortcut.
- **Tauri production build**: `cd frontend && npm run tauri:build --no-bundle` — output in `frontend/src-tauri/target/release/jarvis`.
- **STT service** (Python, CPU): `cd backend/voice/python && .venv/bin/python stt_service.py` — faster-whisper + Silero VAD on port `8790`.
- **TTS service** (Python, GPU): `cd backend/voice/python && .venv/bin/python xtts_service.py`.
- **Wake word service**: `cd backend/voice/python && .venv/bin/python wake_service.py` — openWakeWord, signals backend.
- **Python deps**: `cd backend/voice/python && .venv/bin/pip install -r requirements.txt`.
- **MCP server deps** (first-time): `cd backend/mcp-server && npm install`.

Root-level shortcuts: `npm run dev:backend`, `npm run dev:frontend`, `npm run build:frontend`, `npm run test:backend`, `npm run test:frontend`.

### Production (systemd)

Services live in `scripts/linux/*.service`, installed to `~/.config/systemd/user/` by `scripts/linux/install.sh`. Assumes repo at `~/jarvis-linux/` — systemd `%h` expands to `$HOME`.

```
systemctl --user start jarvis-backend jarvis-stt jarvis-tts jarvis-wake jarvis-ui
systemctl --user start jarvis-jarvisbot jarvis-cloudbot jarvis-notifier   # after secrets set
journalctl --user -u jarvis-backend -f
```

`jarvis-ui.service` runs Chromium in app-mode (`--app=http://localhost:8788`). For Tauri instead, update `ExecStart` to the built binary path.

### Relaunching after updates

**Always restart affected services after applying changes.** Rules by change type:

| Changed | Services to restart |
|---------|-------------------|
| `backend/src/**` (any JS) | `jarvis-backend` |
| `backend/voice/python/*.py` | `jarvis-stt` and/or `jarvis-tts` / `jarvis-wake` (whichever was changed) |
| `backend/voice/python/requirements.txt` | Re-run `pip install -r requirements.txt` inside `.venv`, then restart affected Python service |
| `backend/package.json` / `package-lock.json` | `npm install` in `backend/`, then restart `jarvis-backend` |
| `frontend/src/**` (Chromium app-mode) | `npm run build` in `frontend/`, then restart `jarvis-ui` |
| `frontend/src/**` (Tauri) | `npm run tauri:build --no-bundle`, then restart the Tauri binary |
| `scripts/linux/*.service` | `systemctl --user daemon-reload`, then restart changed service |
| `.mcp.json` or `backend/mcp-server/**` | Reload Claude Code MCP connection (no systemd unit) |
| `backend/secrets.local.json` | Restart `jarvis-backend` (secrets loaded at boot) |

Quick restart commands:

```bash
# Backend only
systemctl --user restart jarvis-backend

# All core services
systemctl --user restart jarvis-backend jarvis-stt jarvis-tts jarvis-wake jarvis-ui

# After .service file change
systemctl --user daemon-reload && systemctl --user restart <service-name>

# Check status / logs after restart
systemctl --user status jarvis-backend
journalctl --user -u jarvis-backend -f
```

**Dev mode exception:** Frontend changes hot-reload automatically when `npm run dev` is active — no restart needed. Backend changes with `npm run dev` (nodemon) also auto-reload.

### Hyprland integration

Source `scripts/linux/hyprland-jarvis.conf` from `~/.config/hypr/hyprland.conf` to apply window rules (no border, no animation, always-on-top pin) for the Chromium app window (class `chromium`, title `Jarvis`).

## Architecture

### Desktop shell: Tauri vs Chromium app-mode

Two deployment modes exist:

1. **Tauri** (`frontend/src-tauri/`) — Rust shell wrapping the Vite frontend. Registers **Super+J** as a global shortcut via `tauri_plugin_global_shortcut`, emitting a `jarvis:wake` Tauri event that `App.tsx` listens to with `listen('jarvis:wake', ...)`. Window is fullscreen, decorations off, transparent. The Tauri binary is self-contained; no backend process management.

2. **Chromium app-mode** — backend serves the built frontend as static files (`handlers/static.js`). `jarvis-ui.service` runs Chromium against `http://localhost:8788`. Super+J requires a separate trigger (Hyprland keybinding → backend API, or `jarvis-wake.service`).

### Boot state machine (frontend)

`bootStore.ts` owns a zustand store: `DORMANT | AWAKE | PIP`. No Electron IPC — state lives entirely in the browser. Transitions:

- **Super+J** → Tauri emits `jarvis:wake` → `App.tsx` calls `setBootState('AWAKE')`.
- **Double clap** → `useClapDetection` (pure DSP, `hooks/useClapDetection.ts`) fires `setBootState('AWAKE')`. Four DSP gates: loud vs adaptive noise floor, sharp attack, high crest factor, high spectral flatness. Two onsets 220–900 ms apart = double clap. Mic opened with `noiseSuppression:false` + `autoGainControl:false`. Pass `debug: true` for per-frame calibration logs.
- **Sleep tool** → backend `POST /api/skills/system/sleep` → skill bus → frontend calls `setBootState('DORMANT')`.

`DormantLayer` always mounts and runs clap detection while `DORMANT`. `AwakeApp.tsx` mounts when `AWAKE`.

### Backend (`backend/src/`)

`server.js` — thin `http.createServer`. Static frontend served before API dispatch (`handlers/static.js`). WebSocket upgrades dispatched by path in a single `upgrade` listener.

**Handlers** (`handlers/`): `health`, `modules`, `telemetry`, `jarvis` (TTS/turn/tts-WS), `stt` (HTTP upload + WS proxy to Python), `speech` (intent gate → Claude CLI), `speakerId` (voice sample CRUD), `mobile` (QR token auth), `mobileGesture` (WS for phone gestures), `skillTools` (all `/api/skills/*` endpoints), `uiState`, `pcControl`, `obsidian`, `security`, `config`, `wakeWord`, `selfBuild`.

**Libs** (`lib/`):
- `skillBus.js` — duplex WS channel (`/api/skills/bus`) from Node backend → AWAKE renderer. `requestClient(verb, payload)` sends a primitive request and awaits correlated response. Falls back to `nativePrimitives.js` if no renderer connected.
- `attentionState.js` + `intentClassifier.js` — speech intent gate. States: `ENGAGED` (0–15 s), `ATTENTIVE` (15–60 s), `PASSIVE` (>60 s). Speaker confidence ≥ 0.65 required.
- `conversationMemory.js` — sliding 8-turn window, in-process global (resets on restart).
- `claudeCli.js` — spawns `claude --print --model ...` with conversation context.
- `secrets.js` — loads `backend/secrets.local.json` (gitignored) into `process.env` at boot.
- `linuxKeyring.js` — Linux equivalent of Windows DPAPI. Uses `secret-tool` (libsecret) for machine-scoped AES-256-GCM key; falls back to `~/.config/jarvis/machine.key` (chmod 600) on headless.
- `obsidian.js` — reads/writes vault via filesystem. `portableVault.js` for encrypted portable storage.
- `telegramBot.js`, `reminders.js`, `cloudflareTunnel.js`, `pdfWatcher.js` — background services started at boot.
- `tailscale.js` — Tailscale URL for mobile QR pairing outside LAN.

**Agent system** (`agent/`):
- `bridge.js` — WS at `/api/jarvis/agent/ws`. Duplex link between frontend capability registry and the backend brain. Protocol: frontend sends `hello` (tools + snapshot), then `turn` (user utterance) or `tool_result`; backend replies with `tool_call` or `final` (spoken reply).
- `brain.js` — the AI decision layer, called by the bridge.

**Services** (`services/`): `jarvisBot.js` (Telegram voice bot), `cloudBot.js`, `notifier.js`.

**MCP server** (`backend/mcp-server/`): Separate Node ESM package. Exposes all Jarvis skills (timer, chrono, reminder, navigation, Obsidian, display, 3D, cloud) as MCP tools over stdio. Claude Code connects to it via `.mcp.json`. Run `npm install` inside this directory if `node_modules/` is missing.

### Speech pipeline

1. `frontend/src/audio/localStt.ts` — `getUserMedia` at 16kHz mono, PCM via `AudioWorklet`, streams binary to `ws://backend/api/jarvis/stt/stream`.
2. `handlers/stt.js` — WS upgrade proxies to Python `stt_service.py` (`STT_URL`, default `http://localhost:8790`). Transcripts `{ text, isFinal, speakerConfidence }` flow back.
3. `handlers/speech.js` — `POST /api/jarvis/process-speech` runs intent gate. If `shouldRespond`, spawns Claude CLI.
4. TTS reply → `POST /api/jarvis/tts` → XTTS Python service.

`useLocalStt` wraps `startLocalStt()`, auto-starts/stops on `enabled` change.

### Python STT service (`backend/voice/python/stt_service.py`)

FastAPI port 8790. faster-whisper (`medium`, CPU, int8) + Silero VAD.
- `POST /transcribe` — multipart WAV, returns `{ text, language, segments[], speaker_confidence }`.
- `WS /stream` — real-time Float32 PCM. ~960 ms silence finalizes a segment.
- Speaker ID proxied through Node backend. Samples in `backend/voice/samples/speaker/`. Uses `resemblyzer`.

### Mobile QR pairing

`GET /api/mobile/token` → LAN + Tailscale URLs. Frontend renders QR. Mobile hits `POST /api/mobile/auth`. State in `backend/src/state/mobileSession.js`.

### Gesture pipeline (`frontend/src/gestures/`)

MediaPipe hand landmarker → `GesturePipeline` (`pipeline.ts`):
1. **Feature extraction** (`features.ts`) — finger curl + tip distances from 21 landmarks.
2. **State tracking** (`state.ts`) — per-hand `HandState`.
3. **Recognition** — `MLGestureRecognizer` (TF.js, IndexedDB) takes priority; rule-based fallback. Pinch always overlaid on right hand for zoom.
4. **Modifier layer** (`modifiers.ts`) — pauses pinch zoom when hand pose ambiguous.
5. **Output** (`output.ts`) → `GestureOutput` (`grab | point | pinch | click | back`).

3-layer TF.js MLP (9 → 32 → 32 → N). Training data in `localStorage`/IndexedDB. `pipeline.initML()` must succeed before ML is active.

### Frontend stores (`frontend/src/state/`)

- `jarvisStore` — mode, voice/clap flags, wake phrase, focused entity, ring nav, pinch zoom.
- `gestureStore` — pipeline enabled + last `GestureOutput`.
- `bootStore` — `DORMANT | AWAKE | PIP`, pure zustand (no IPC).
- `systemStore` — telemetry. `networkStore` — discovered devices.
- `timerStore`, `chronoStore`, `displayStore`, `model3dStore`, `uiStore`.

Mode ring: `main` (`home | house | system | cloud`) + `sub` (`plan3d | space | plan2d`). `zoomedMode` = expanded canvas.

### Persistence

`localStorage` (bump `.vN` on schema change — no migration):
- `jarvis.plan2d.saved.v1` — `SavedPlan[]` by composite key `room::name`.
- `jarvis.plan3d.entities.v1` — `Record<planKey, SceneEntity[]>`.
- `jarvis.plan3d.viewpoint.v1` — `Record<planKey, Viewpoint>`.
- `jarvis.gesture.dataset.v1` — gesture training samples.

IndexedDB: `indexeddb://jarvis-gesture-model` — trained TF.js gesture classifier (per browser profile).

## Conventions and gotchas

- **Spanish UI copy.** All labels + toasts in Spanish.
- **2D→3D bridge by composite key** (`room::name`), not id. Renaming a plan in 2D orphans its 3D entities.
- **No DB in backend.** `attentionState` + `conversationMemory` are in-process globals — reset on restart.
- **STT needs Python service.** If `stt_service.py` is not running, `useLocalStt` silently fails. No auto-fallback.
- **Speaker ID needs ≥1 sample.** Until enrolled, `speaker_confidence` = 0 and all voice turns are ignored. `JARVIS_OWNER_SPEAKER` env var in `jarvis-backend.service` must match the enrolled speaker name.
- **Speaker encoder is ECAPA-TDNN by default** (`SPEAKER_ENCODER=ecapa|resemblyzer`). Thresholds are encoder-scaled (ecapa ~0.55, resemblyzer ~0.70) — never copy a threshold across encoders. Changing encoder requires regenerating `owner_voiceprint.enc` via `scripts/create-voiceprint.sh` (WAV samples re-embed automatically; mismatched-dim voiceprints are skipped with a log warning). Calibrate thresholds with `scripts/calibrate-speaker-threshold.py`.
- **Speaker-id always gets RAW audio; only Whisper gets denoised audio** (`STT_DENOISE_MODE=deepfilter`). Denoise-before-embed degrades identification — don't "fix" that.
- **`_cohort/` under `samples/speaker/` is the noise-rejection anchor.** ECAPA maps pure noise to a degenerate direction that partially matches mic-channel noise in enrolled refs; the cohort gate rejects anything scoring near it. Don't delete the dir. Junk refs auto-excluded at load by a consistency filter (`ref_floor`); rejected recordings live in `<speaker>/_rejected/`.
- **Linux keyring fallback.** If `secret-tool`/libsecret is unavailable (no keyring daemon), `linuxKeyring.js` falls back to `~/.config/jarvis/machine.key`. Encrypted owner voiceprint at `backend/voice/python/owner_voiceprint.enc`.
- **`nativePrimitives.js` is still Windows-first.** Camera enumeration (PnP/PowerShell) and photo capture (ffmpeg dshow) target Windows. On Linux these paths will fail silently; skill bus renderer path (`capture_photo` via MediaPipe) is the working fallback.
- **Tauri global shortcut (Super+J) only works when the Tauri binary is running**, not when using the Chromium app-mode service. For Chromium+Hyprland, wire Super+J via a Hyprland `bind` that hits the backend API.
- **ML gesture model is per-browser-profile.** IndexedDB is not cleared by `localStorage` wipes.
- **`SYSTEM_TELEMETRY_ENABLED`** in `AwakeApp.tsx` gates telemetry poll (set to `false` by default).
