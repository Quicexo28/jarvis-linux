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

`jarvis-ui.service` runs the **Tauri binary** (`frontend/src-tauri/target/release/jarvis`), which embeds the frontend at build time — **always `npm run tauri:build --no-bundle` BEFORE restarting `jarvis-ui`**, or the restarted process serves stale assets (symptom: skill-bus primitives fail with errors from old code, e.g. `invalid_model3d_kind`). For Chromium app-mode instead, point `ExecStart` at `chromium --app=http://localhost:8788`.

### Relaunching after updates

**Always restart affected services after applying changes.** Rules by change type:

| Changed | Services to restart |
|---------|-------------------|
| `backend/src/**` (any JS) | `jarvis-backend` |
| `backend/voice/python/*.py` | `jarvis-stt` and/or `jarvis-tts` / `jarvis-wake` (whichever was changed) |
| `backend/voice/python/requirements.txt` | Re-run `pip install -r requirements.txt` inside `.venv`, then restart affected Python service |
| `backend/package.json` / `package-lock.json` | `npm install` in `backend/`, then restart `jarvis-backend` |
| `frontend/src/**` (Tauri — current `jarvis-ui.service`) | `npm run tauri:build --no-bundle`, **then** restart `jarvis-ui` (build first: assets are embedded in the binary) |
| `frontend/src/**` (Chromium app-mode alternative) | `npm run build` in `frontend/`, then restart `jarvis-ui` |
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

### Distributed agents (`agents/` Cargo workspace)

Jarvis actúa sobre otras máquinas (Windows "main" primero) vía agentes ligeros headless. Cerebro = backend Node (no Rust); el Rust vive en un workspace **separado** `agents/` (crates `protocol`, `hub`, `agent`).

- **`protocol`** — tipos serde compartidos hub↔agente + `PROTOCOL_VERSION` (chequeado en handshake). `RemotePath` tipa Win/Linux (nunca parte por separador). `cargo run -p jarvis-agent-protocol --bin gen-schema -- backend/data/agents` emite `protocol.schema.json` + versión para el lado Node (fuente de verdad única).
- **`hub`** — sidecar Rust en el portátil. WS server `0.0.0.0:8794` (agentes conectan INBOUND por Tailscale, no exponen puerto; token por-agente en handshake). Control API `127.0.0.1:8795` para el backend Node (`/machines`, `/rpc`). Eventos proactivos → POST a Node `/api/agents/event` → `notifyJarvis` (Telegram). systemd: `jarvis-agenthub.service`. **Puertos 8794/8795** (8789-8791 son python; 8792 pc_control).
- **`agent`** — binario headless. WS-client, handshake (versión+token+MACs para WoL), heartbeat, reconexión backoff (portátil suspende), multiplexado (ops en `spawn_blocking`). Allowlist local (exec/write OFF por defecto — el agente veta aunque el hub pida) + audit log. Windows Service tras `--features winservice` (módulo `winservice.rs`, **sin validar en Linux** — Fase 6, lo prueba el Claude de Windows). Linux/systemd = mismo binario.
- **Node seam**: `handlers/agents.js` (`/api/agents/list|rpc|event`), tokens en `backend/data/agent-tokens.json` (revocables). `/api/agents/rpc` es **local-only** (webAuth DANGEROUS — puede disparar exec remoto). MCP tools `remote_machines/remote_sysinfo/remote_search/remote_exec` en `jarvis-mcp.js` (usan `transform` para envolver en el envelope RPC del hub).
- **Estado v1**: Fases 1-5 completas y verificadas en Linux; agente Windows `main` en producción. Fase 1-2 = protocol + hub + agent (handshake/reconnect/heartbeat/allowlist/audit). **Fase 3** (`ops.rs`) = search (Everything `es.exe` Windows-only + fallback walkdir), exec (buffered, timeout con kill, pipes drenados en hilos, `from_utf8_lossy` consola OEM), read/write file (base64, chunked offset/length, cap 4 MiB), list_processes (sysinfo top-50 mem). **Fase 4** = MCP tools `remote_machines/sysinfo/search/exec/read_file/write_file/wake` (`jarvis-mcp.js`; `remote_read_file` decodifica base64→text por `postTransform`). **Fase 5** (`watch.rs`) = watchers proactivos: `Booted` (una vez), `DiskHigh` (edge-triggered por montaje sobre `disk_percent`), `ProcessExited` (procesos vigilados en `[watchers]` de agent.toml) → Event → hub → `/api/agents/event` → Telegram. **Wake-on-LAN**: hub cachea MACs por handshake en `agent-macs.json` (gitignored), `/wake` + `/api/agents/wake` + `remote_wake` mandan magic packet UDP broadcast (SOLO misma LAN — no viaja por Tailscale). **Bug corregido**: `Event.kind` colisionaba con el tag `"kind"` del enum `Message` → renombrado a `"event"` en el wire (`#[serde(rename)]`); test de regresión en protocol. **Pendiente**: Fase 6 = Windows service nativo (winservice.rs — `main` ya corre como servicio SYSTEM, validado en la práctica); streaming real de exec (hoy buffered); auto-update v1.5 (`Welcome.expected_agent_version` listo, swap sin implementar). Hub = `jarvis-agenthub.service` (0.0.0.0:8794, ufw tailscale0).

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

`GET /api/mobile/token` → LAN + Tailscale URLs. Frontend renders QR. Mobile hits `POST /api/mobile/auth`. State in `backend/src/state/mobileSession.js`. URL priority: `tailscale serve` HTTPS > Tailscale IP > Cloudflare tunnel (opt-in `JARVIS_TUNNEL=cloudflare`) > LAN.

### Remote web access (GUI completa vía Tailscale)

The Node backend serves the same built frontend to remote browsers. `http://<ts-ip>:8788?token=<JARVIS_WEB_TOKEN>&ui=full` loads the full desktop GUI (`AwakeApp`, arranca AWAKE); without `ui=full` a token yields the reduced `MobileClient`. `?ui=mobile` reverts the persisted choice.

- **`frontend/src/platform/tauri.ts` is the ONLY entry point to Tauri APIs** (`tauriInvoke`/`tauriListen`/`getWindowLabel`/`isTauri`). In browsers they no-op (all 7 Rust commands are local window management). Never import `@tauri-apps/api` directly elsewhere.
- **Auth (`backend/src/lib/webAuth.js`)**: every `/api/*` route and WS upgrade requires a token unless the request is LOCAL. **Local = loopback socket AND no `X-Forwarded-For`** — `tailscale serve` proxies from 127.0.0.1, so never weaken this to socket address alone. Tokens: persistent `JARVIS_WEB_TOKEN` (secrets.local.json) or the rotating mobile QR session token, via Bearer / `?token=` / `jarvis_auth` cookie (set by `/api/mobile/auth`, so every existing fetch/WS call site inherits auth same-origin). Static files + `/health` stay public; `/api/mobile/ctx/*` self-validate (ingest token stays scoped).
- **Dangerous endpoints are local-only even WITH token** (403 `remote_forbidden`): system terminal/launch/power/process, `code/*`, `file/pick`, `/api/pc/*`, `security/unlock`, `/api/speaker-id/*`. Unlock selectively with `JARVIS_WEB_ALLOW_PATHS` (comma list, `/` suffix = prefix).
- **Skill bus roles**: local renderer = primary (last-wins, as before); remote renderers go to a fallback set and NEVER displace the desktop. Role decided server-side by connection origin.
- **HTTPS**: mic/camera (getUserMedia) and PWA install need a secure context — enable `tailscale serve --bg 8788` (one-time tailnet feature approval required). Remote state is an independent renderer instance (own zustand timers/views), not a mirror of the desktop.

### Gesture pipeline v2 (`frontend/src/gestures/`)

Cámara compartida (`cameraFeed.ts`, singleton, `<video>` oculto) → MediaPipe HandLandmarker **en el main thread** (`landmarker.ts`, GPU→CPU fallback) → swap handedness (`useGesturePipeline.ts`) → **engine puro** (`engine.ts`, testeable en Node) → `gestureStore`.

Engine: `features.ts` (curls world + apertura + gap) → `pose.ts` (histéresis por dedo + debounce 2 frames + histéresis sep/close del peace) → `dynamics.ts` (GrabTracker/PinchTracker/PointerTracker/DiscreteTracker con One-Euro (`filters.ts`), gracia de 250 ms ante dropouts, cooldown de eventos). Umbrales TODOS en `config.ts`.

Funciones (contrato de producto): mano IZQ física — puño=arrastrar/rotar (deltaX>0=derecha, deltaY>0=abajo, deltaAngle=roll), índice=cursor, V abierta soltada=click, V cerrada soltada=back (soltar = relajar dedos CON la mano visible; perder la mano cancela). Mano DER — pinch=zoom RELATIVO integrado (engancha al contacto en 1.0, abrir acerca / cerrar aleja, deadband anti-temblor, pegajoso: solo suelta mano abierta / apertura >1.55 / mano perdida).

Gotchas Linux/WebKitGTK (Tauri):
- **Model + WASM locales y gitignored** (`public/models/hand_landmarker.task`, `public/wasm/` — regenerar según `public/models/README.txt`).
- **La inferencia vive en el MAIN thread — un Worker es IMPOSIBLE con tasks-vision 0.10**: la librería no tiene ruta de ingesta CPU, toda imagen entra por textura WebGL (`_addBoundTextureAsImageToStream`), y los workers de WebKitGTK no tienen WebGL (probado: `GLctx.activeTexture` undefined con OffscreenCanvas; `Can't find variable: document` sin él). No re-intentar el worker.
- **`canvas` DOM EXPLÍCITO obligatorio al crear el landmarker** (`landmarker.ts`): sin él, tasks-vision usa `new OffscreenCanvas(1,1)` donde WebKitGTK tampoco da WebGL (`emscripten_webgl_create_context() returned error 0` para WebGL 2 Y 1) → el modelo carga pero `detectForVideo` muere con `GLctx.activeTexture`. Con `document.createElement('canvas')` hay WebGL2 real y hasta el delegate **GPU** funciona (renderer "WebKit WebGL"); fallback a CPU/XNNPACK si falla. Los reinicios en runtime fuerzan CPU.
- **Anti-cuelgue del main thread**: pacing adaptativo (`inferMs·PACE_FACTOR`, piso 66 ms ≈ 15 fps, techo 200 ms), frames de cámara repetidos se saltan (`nextFrame()`), `detectForVideo` lanzando → recrear el landmarker (≤3 veces) SIN tocar la cámara. v1 a 30 fps fijos saturaba el WebKitWebProcess: traps `NeedDebuggerBreak` + SIGSEGV del cliente PipeWire de WebKit (libpipewire-module-protocol-native) al morir de hambre su loop. Minimizar open/close de streams getUserMedia — ese churn dispara el mismo SIGSEGV.
- **Handedness es DIRECTA — verificada empíricamente (2026-07-05, mano por mano en el panel)**: con getUserMedia sin espejar + tasks-vision 0.10.35, label `Left` = mano IZQUIERDA física. El mapeo vive en `splitHands()` (useGesturePipeline). La nota v1 afirmaba lo contrario ("labels asumen selfie") y con ella los gestos respondían a la mano equivocada — ante cualquier duda, verificar con los badges IZQ/DER del panel debug ANTES de tocar el mapeo. Dos manos con la misma label se desempatan por x (menor x = mano derecha física).
- **Deltas y puntero salen en coords de PANTALLA** (espejo ya aplicado); consumers los usan directo. Deltas de grab normalizados por tamaño de palma en imagen (misma sensibilidad a cualquier distancia).
- **El `<video>` oculto del pipeline queda en el DOM a propósito**: `primitives.capture_photo` lo reutiliza para fotos sin re-pedir permiso. `GestureDebugView` consume el MISMO pipeline (video + `gestureStore.debugFrame`) — no abre segunda cámara ni segundo landmarker.
- **WebKitWebProcess muerto → el binario Tauri hace exit(101)** (`connect_web_process_terminated` en lib.rs) y systemd lo revive — antes quedaba ventana congelada con JS muerto. El boot espera el socket Wayland real (`ExecStartPre` en jarvis-ui.service); con `sleep 2` Tauri paniqueaba (exit 101) en cada boot.
- **Estado en `gestureStore`** (`status`/`statusDetail`/`fps`/`debugFrame`): GestureMonitor muestra backend + fps o el error real. Al apagar el pipeline el output se resetea a DEFAULT (un `active` rancio seguía rotando escenas 3D).
- **Observabilidad remota**: `GET /api/skills/gestures/status` → `{enabled, status, detail, fps}` (skill-bus verb `gesture_status`) — el health-check del pipeline sin mirar la pantalla. Además `console.*` del webview sale a journald (`enable-write-console-messages-to-stdout` en lib.rs): `journalctl --user -u jarvis-ui | grep CONSOLE`.

### Frontend stores (`frontend/src/state/`)

- `jarvisStore` — mode, voice/clap flags, wake phrase, focused entity, ring nav, pinch zoom.
- `gestureStore` — pipeline enabled + last `GestureOutput` + status/fps/debugFrame.
- `bootStore` — `DORMANT | AWAKE | PIP`, pure zustand (no IPC).
- `systemStore` — telemetry. `networkStore` — discovered devices.
- `timerStore`, `chronoStore`, `displayStore`, `model3dStore`, `uiStore`.

Mode ring: `main` (`home | house | system | cloud`) + `sub` (`plan3d | space | plan2d`). `zoomedMode` = expanded canvas.

### Persistence

`localStorage` (bump `.vN` on schema change — no migration):
- `jarvis.plan2d.saved.v1` — `SavedPlan[]` by composite key `room::name`.
- `jarvis.plan3d.entities.v1` — `Record<planKey, SceneEntity[]>`.
- `jarvis.plan3d.viewpoint.v1` — `Record<planKey, Viewpoint>`.

(El clasificador ML de gestos + trainer se eliminaron en el rewrite v2 — quedan huérfanos `jarvis.gesture.dataset.v1` en localStorage e `indexeddb://jarvis-gesture-model` en perfiles viejos; ignorables.)

## Conventions and gotchas

- **Spanish UI copy.** All labels + toasts in Spanish.
- **2D→3D bridge by composite key** (`room::name`), not id. Renaming a plan in 2D orphans its 3D entities.
- **No DB in backend.** `attentionState` + `conversationMemory` are in-process globals — reset on restart.
- **STT needs Python service.** If `stt_service.py` is not running, `useLocalStt` silently fails. No auto-fallback.
- **Speaker ID needs ≥1 sample.** Until enrolled, `speaker_confidence` = 0 and all voice turns are ignored. `JARVIS_OWNER_SPEAKER` env var in `jarvis-backend.service` must match the enrolled speaker name.
- **Speaker encoder is ECAPA-TDNN by default** (`SPEAKER_ENCODER=ecapa|resemblyzer`). Thresholds are encoder-scaled (ecapa ~0.55, resemblyzer ~0.70) — never copy a threshold across encoders. Changing encoder requires regenerating `owner_voiceprint.enc` via `scripts/create-voiceprint.sh` (WAV samples re-embed automatically; mismatched-dim voiceprints are skipped with a log warning). Calibrate thresholds with `scripts/calibrate-speaker-threshold.py`.
- **Speaker-id always gets RAW audio; only Whisper gets denoised audio** (`STT_DENOISE_MODE=deepfilter`). Denoise-before-embed degrades identification — don't "fix" that.
- **`_cohort/` under `samples/speaker/` is the noise-rejection anchor.** ECAPA maps pure noise to a degenerate direction that partially matches mic-channel noise in enrolled refs; the cohort gate rejects anything scoring near it. Don't delete the dir. Junk refs auto-excluded at load by a consistency filter (`ref_floor`); rejected recordings live in `<speaker>/_rejected/`.
- **Short-utterance rescue layers** (speaker_id.py + stt_service.py): duration-adaptive threshold (clips <1.5s get `SPEAKER_SHORT_THR_OFFSET` discount + stricter cohort margin), text-dependent wake voiceprint (`_wake/` dir, short clips of the owner saying only "Jarvis", `SPEAKER_WAKE_THRESHOLD`), denoised-domain retry (when the RAW match fails, the DeepFilter output whisper already consumed is re-embedded and run through the full gate stack — rescues far-field/quiet speech whose raw embedding drifts toward the noise direction; tagged `domain=denoised` so online learning stays raw-only), and trust continuity (`JARVIS_TRUST_TTL`, decaying threshold discount after a confident owner match). All layers keep the cohort gate — never bypass it. The `_wake/` clips are ALSO merged into the owner's main profile as `anchor-*.wav` copies, so short phrases score high through the standard path too.
- **Windowed voting scores windows as 1.5s clips** (duration discount + stricter cohort), and its majority-None veto only fires when some window voted a DIFFERENT speaker — uniformly weak windows are far-field speech, not mixed audio; the full-clip match (which passed all gates) wins. `SPEAKER_DEBUG=1` (default) logs which gate rejected each failed candidate (`reject thr/margin/cohort`).
- **Emitted `speakerConfidence` is CALIBRATED, not the raw cosine** (`SPEAKER_VERIFIED_CONF_FLOOR`, default 0.80): any match that survived the full gate stack (threshold + margin + cohort + rescue layers) is emitted at ≥ the floor, because short clips physically score lower cosines than the 0.60/0.65 thresholds hardcoded in speech.js/intentClassifier expect. The RAW score stays internal (logged as `raw=`) and is what feeds trust continuity and online learning — never gate learning on the calibrated value, and never "fix" a low raw score by lowering the backend thresholds.
- **STT latency architecture** (stt_service.py): speaker-id (CPU) runs CONCURRENTLY with whisper (GPU) via `_SPK_EXECUTOR` — text-dependent rescues run after decode only if the base match failed. Whisper gets the float32 array directly (no tempfile). Online learning is fire-and-forget (`_learn_async`); `learn_sample` swaps the embedding list atomically because identification reads it from another thread. A boot warmup thread pre-pays the first-decode CUDA cost (was 44s on a cold turn). Speculative decode fires at `STT_SPEC_AT=12` chunks (~0.38s of silence); per-turn log: `seg_ms (den= wh= spk=)`.
- **Endpointing is inverted-adaptive with a ~1s hard cap** (`STT_SILENCE_CHUNKS=31`): once the speculative transcript is ready, finalize at ~0.51s if it ends in `.!?` (`STT_EF_COMPLETE_CHUNKS=16`), ~0.70s if it ends in no continuation cue (`STT_EF_NEUTRAL_CHUNKS=22`), and only a trailing comma/conjunction/preposition (`_CONTINUATION_RE`, Spanish-tuned) waits the full cap. Do NOT re-invert to "require terminal punctuation to finalize early" — whisper omits Spanish punctuation so often that finished turns waited the max window. A silence tail only resets after `STT_RESUME_CHUNKS=2` consecutive speech chunks, so a lone 32ms noise blip (fan) can't restart the wait.
- **Enrollment augmentation** (`SPEAKER_AUGMENT=1` default): each on-disk reference WAV is also embedded in synthetic reverb/distance/noise variants at load and in `create-voiceprint.sh`. The encrypted voiceprint stores whatever was embedded at generation time; augmentation of `.enc`-only speakers is impossible (needs audio).
- **Linux keyring fallback.** If `secret-tool`/libsecret is unavailable (no keyring daemon), `linuxKeyring.js` falls back to `~/.config/jarvis/machine.key`. Encrypted owner voiceprint at `backend/voice/python/owner_voiceprint.enc`.
- **`nativePrimitives.js` is still Windows-first.** Camera enumeration (PnP/PowerShell) and photo capture (ffmpeg dshow) target Windows. On Linux these paths will fail silently; skill bus renderer path (`capture_photo` via MediaPipe) is the working fallback.
- **Tauri global shortcut (Super+J) only works when the Tauri binary is running**, not when using the Chromium app-mode service. For Chromium+Hyprland, wire Super+J via a Hyprland `bind` that hits the backend API.
- **3D viewer is multi-object.** `model3dStore` holds `objects: Model3DSpec[]` + `scene` opts (axes/grid); kinds: `parametric | polytope | implicit | primitive | curve | graph | vectors | plane | line`, each with per-object `position/rotation/scale/color/opacity` in MATH coordinates (z up — the viewer applies a `-π/2` X frame rotation). `show_3d` accepts `objects:[...]` or a legacy single spec; `add_3d` appends. Pure sampling math lives in `frontend/src/lib/geometry/` (`analyticMath.ts` for curves/graphs/planes/spans) — keep it Three-free so it stays Node-testable. 4D+ polytopes color edges/faces by the rotated 4th coordinate; the `_cohort`-style rule here: don't move mathjs `compile/evaluate` into render components, wrap new spec kinds in try/catch so bad LLM formulas degrade to an empty object instead of crashing the overlay.
- **`SYSTEM_TELEMETRY_ENABLED`** in `AwakeApp.tsx` gates telemetry poll (set to `false` by default).
