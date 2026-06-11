# CLAUDE.md

Parent workspace `C:\proyecto\CLAUDE.md`: cross-project context + high-level summary. This file: architecture + gotchas for **inside** `jarvis-desktop/`.

## Linux / Omarchy (primary target)

One-script bootstrap on fresh CachyOS: `./setup.sh` (idempotent, phased: Omarchy desktop → Claude CLI → Jarvis → NVIDIA Chromium flags). Re-run after the Omarchy reboot. Pieces:

- `scripts/omarchy/` — Omarchy-on-CachyOS installer (patched Basecamp Omarchy; clones into `/omarchy/`, gitignored).
- `scripts/linux/install.sh` — Jarvis only: pacman deps, npm deps, frontend build, Python venv (CUDA torch when `nvidia-smi` works, CPU wheel otherwise), 5 systemd user services, Hyprland wiring.
- Services (`scripts/linux/*.service`, expect repo at `~/jarvis-linux`): `jarvis-backend` (node, port 8788), `jarvis-stt`, `jarvis-tts`, `jarvis-wake` (openWakeWord), `jarvis-ui` (Chromium app-mode, Wayland via ozone, `WantedBy=graphical-session.target`).
- No Electron on Linux — wake hotkey `Ctrl+Alt+J` is a Hyprland bind (in `hyprland-jarvis.conf`) POSTing to `/api/jarvis/wake`; fullscreen via `requestFullscreen()`.
- Venv python: `.venv/bin/python` on Linux, `.venv/Scripts/python.exe` on Windows — `nativePrimitives.js` and the services are platform-aware.

## Run commands

Independent services — separate terminals.

- **Backend** (Node ESM): `cd backend && npm run dev` — boots on `http://0.0.0.0:8788`. Tests: `npm test`.
- **Frontend**: `cd frontend && npm run dev` (Vite, port 5173) / `npm run build` (`tsc && vite build`) / `npm run test`.
- **Electron** (wraps both): `npm run electron` from repo root — starts Electron, in-process imports Node backend, auto-launches Python services.
- **STT service** (Python, CPU): `cd backend/voice/python && .venv/Scripts/python.exe stt_service.py` — faster-whisper + Silero VAD on port `8790`. Set `STT_URL` env var to override.
- **XTTS service** (Python, GPU): `cd backend/voice/python && .venv/Scripts/python.exe xtts_service.py` — voice cloning TTS. Electron starts both if `.venv` exists.
- **Python deps**: `cd backend/voice/python && pip install -r requirements.txt` (in a venv).

## Architecture

### Boot state machine (Electron ↔ frontend)

`electron/main.js` owns a two-state machine: `DORMANT` (window hidden) → `AWAKE` (full-screen via `setSimpleFullScreen`). Double clap (or hotkey/tray) goes straight DORMANT → AWAKE; there is no intermediate listening state. IPC transitions:

- Main → renderer: `mainWindow.webContents.send('boot:state', state)`
- Renderer → main: `ipcMain.handle('boot:setState', ...)` → `applyBootState()`

`pushBootState()` signals renderer only; `forceBootState()` also calls `applyBootState()` directly (needed when renderer is non-DORMANT and `DormantLayer` hasn't mounted). Global hotkey `Ctrl+Alt+J` (override via `JARVIS_WAKE_HOTKEY`) calls `forceBootState('AWAKE')`.

`DormantLayer` (always mounted) runs `useClapDetection` while `DORMANT`; a double clap fires `setBootState('AWAKE')`. Detector is **pure DSP** (`hooks/useClapDetection.ts`) — no ML, no training. Each frame an onset must pass four gates (loud vs adaptive noise floor, sharp attack, high crest factor, high spectral flatness); two onsets 220–900 ms apart = double clap. Mic opens with `noiseSuppression:false` + `autoGainControl:false` (both would kill clap transients) and `analyser.smoothingTimeConstant = 0`. Pass `debug: true` to log per-frame metrics for threshold calibration.

Electron auto-starts `xttsProc` + `sttProc` looking for `.venv/Scripts/python.exe` in `backend/voice/python/`. Not found → renderer falls back to `speechSynthesis`.

### Backend (`backend/src/`)

Handler + lib pattern:

- **`server.js`** — thin `http.createServer` + WebSocket upgrade dispatcher. Routes to `dispatch()` in `routes.js`.
- **`routes.js`** — flat route table `{ method, path }` → handler. CORS permissive (`*`).
- **`handlers/`** — one file per domain: `health`, `modules`, `telemetry`, `jarvis` (turn/wake/tts/device-action), `stt` (HTTP upload + WS upgrade proxy to Python), `speech` (process-speech pipeline), `speakerId` (CRUD voice samples + STT proxy), `mobile` (QR token auth).
- **`lib/`** — pure utilities: `http.js` (json/readBody), `attentionState.js`, `intentClassifier.js`, `conversationMemory.js`, `tailscale.js`.

### Speech pipeline (offline)

1. **Capture** — `frontend/src/audio/localStt.ts` opens `getUserMedia` at 16kHz mono, captures PCM via `AudioWorklet`, streams binary frames over WebSocket to `ws://backend/api/jarvis/stt/stream`.
2. **STT proxy** — `handlers/stt.js` WebSocket upgrade proxies frames to Python `stt_service.py` at `STT_URL` (default `http://localhost:8790`). Transcripts (`{ text, isFinal, speakerConfidence }`) flow back.
3. **Intent gate** — `POST /api/jarvis/process-speech` in `handlers/speech.js` runs transcript through `attentionState` + `intentClassifier`. States: `ENGAGED` (0–15 s), `ATTENTIVE` (15–60 s), `PASSIVE` (>60 s). Speaker confidence ≥ 0.65 required or turn ignored.
4. **Claude CLI** — if `classifyIntent` returns `shouldRespond`, spawns `claude --print --model haiku` with context from `conversationMemory.js` (sliding 8-turn window).
5. **TTS** — `POST /api/jarvis/tts` in `handlers/jarvis.js` proxies to XTTS Python service.

`useLocalStt` wraps `startLocalStt()`, auto-starts/stops when `enabled` changes.

### Python STT service (`backend/voice/python/stt_service.py`)

FastAPI on port 8790. Loads faster-whisper (`medium`, CPU, int8) + Silero VAD at startup.

- `GET /health`
- `POST /transcribe` — multipart WAV upload, returns `{ text, language, segments[], speaker_confidence }`.
- `WS /stream` — real-time Float32 PCM. Silero VAD detects speech boundaries (~960 ms silence to finalize). Transcription in `asyncio.to_thread`.
- Speaker ID: `GET/POST/PUT /speaker-id/*` — proxied through Node backend. Samples at `backend/voice/samples/speaker/`. Uses `resemblyzer` (`speaker_id.py`).

### Mobile QR pairing (`handlers/mobile.js`)

`GET /api/mobile/token` generates short-lived token, returns LAN URL + Tailscale URL. Frontend renders QR encoding `http://<ip>:8788?token=<token>`. Mobile hits `POST /api/mobile/auth` to activate. State in `backend/src/state/mobileSession.js`.

### Gesture pipeline (`frontend/src/gestures/`)

MediaPipe hand landmarker → `GesturePipeline` (`pipeline.ts`):

1. **Feature extraction** (`features.ts`) — finger curl values + tip distances from 21 landmarks.
2. **State tracking** (`state.ts`) — per-hand `HandState` (extension states, contacts).
3. **Recognition** — hybrid: `MLGestureRecognizer` (TF.js, IndexedDB-persisted) takes priority; `GestureRecognizer` (rule-based) fallback. Rule-based pinch always overlaid on right hand for zoom.
4. **Modifier layer** (`modifiers.ts`) — pauses pinch zoom when hand pose ambiguous.
5. **Output processor** (`output.ts`) — gesture + modifier → `GestureOutput` (`grab`, `point`, `pinch`, `click`, `back`).

3-layer TF.js MLP (9 inputs → 32 → 32 → N classes). Training data in `localStorage`/IndexedDB. `GestureTrainer` handles data collection. ML opt-in: `pipeline.initML()` must succeed first. (Clap detection is **not** ML — see boot state machine above.)

Gesture classes: `grab | pinch | point | peace_sep | peace_close | idle`.

`useGesturePipeline` drives pipeline from `useHandSkeleton` (MediaPipe), writes to `gestureStore` (zustand). `AwakeApp.tsx` reads that store.

### Frontend layout

`AwakeApp.tsx` renders when boot state is `AWAKE`. Owns gesture, voice, clap, STT hooks.

Stores in `frontend/src/state/`:
- `jarvisStore` — mode, voice/clap flags, wake phrase, focused entity, ring nav, pinch zoom progress.
- `gestureStore` — pipeline enabled flag + last `GestureOutput`.
- `bootStore` — boot state (`DORMANT | AWAKE`), synced with Electron via IPC.
- `systemStore` — telemetry. `networkStore` — discovered devices.

Mode ring: `main` (`home | house | system | cloud`) + `sub` (`plan3d | space | plan2d`). `zoomedMode` = expanded canvas mode.

### Persistence

`localStorage` keys (bump `.vN` if schema changes — no migration):
- `jarvis.plan2d.saved.v1` — `SavedPlan[]` by composite key `room::name`.
- `jarvis.plan3d.entities.v1` — `Record<planKey, SceneEntity[]>`.
- `jarvis.plan3d.viewpoint.v1` — `Record<planKey, Viewpoint>`.
- `jarvis.gesture.dataset.v1` — gesture training samples.

IndexedDB: `indexeddb://jarvis-gesture-model` — trained TF.js gesture classifier.

## Conventions and gotchas

- **Spanish UI copy.** All labels + toasts in Spanish — keep consistent.
- **2D→3D bridge by composite key** (`room::name`), not id. Renaming plan in 2D orphans 3D entities.
- **`SYSTEM_TELEMETRY_ENABLED = false`** in `AwakeApp.tsx` gates telemetry poll. Shell-outs (`nvidia-smi`, PowerShell) Windows-only.
- **No DB in backend.** `attentionState` + `conversationMemory` are in-process globals — reset on restart. 8-turn window.
- **STT needs Python service.** If `stt_service.py` not running, `useLocalStt` silently fails (WebSocket error). No auto-fallback to `webkitSpeechRecognition`.
- **Speaker ID needs ≥1 sample.** `_init_speaker_id()` raises if `backend/voice/samples/speaker/` has no non-underscore files. Until enrolled, `speaker_confidence` = 0, all turns ignored.
- **Electron media permissions** auto-granted in `main.js` for `media/audioCapture/videoCapture/microphone/camera`. OS still gates install-level prompt.
- **ML gesture model per-browser-profile.** IndexedDB scoped to Electron session. Clearing `localStorage` from tray doesn't wipe IndexedDB.
