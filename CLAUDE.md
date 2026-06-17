# CLAUDE.md

Guidance for Claude Code working **inside `jarvis-linux/`** — architecture + gotchas. This is the Linux port of `jarvis-desktop` (Windows). It runs as a **LAN server** on Arch Linux: systemd supervises the backend + Python sidecars, and the UI is **Chromium in kiosk mode** (there is **no Electron** here). When porting changes from `jarvis-desktop`, adapt: Windows DPAPI → `platformCrypto`/`dpapi_util` (machine-key AES-GCM), `C:\` paths → Linux paths, Electron supervision → systemd, PowerShell/pywin32 → Linux tools.

## Run commands

Independent services — separate terminals (or the systemd units in `scripts/linux/`).

- **Backend** (Node ESM): `cd backend && npm run dev` — boots on `http://0.0.0.0:8788`. Tests: `npm test` (set `JARVIS_FAKE_CLAUDE=1` so tests never spawn the real Claude CLI).
- **Frontend**: `cd frontend && npm run dev` (Vite :5173) / `npm run build` (`tsc && vite build` → `frontend/dist/`, served by the backend) / `npm test`.
- **STT** (Python): `cd backend/voice/python && .venv/bin/python stt_service.py` — faster-whisper + Silero VAD on :8790. `STT_URL` overrides the backend→Python URL. `STT_HOTWORDS` biases the beam toward domain vocab.
- **TTS** (Python): `.venv/bin/python edge_tts_service.py` — Edge TTS (Microsoft neural voices, cloud, no GPU) is the default engine. XTTS (`xtts_service.py`) is optional GPU voice cloning.
- **Wake word** (Python, optional): `.venv/bin/python wake_service.py` (:8791).
- **PC control** (Python): `.venv/bin/python pc_control_service.py` (:8792).
- **Python deps**: `pip install -r backend/voice/python/requirements.txt` in a venv (install torch/torchaudio from the **cu118** index first — RTX 3050/Ampere). See README.
- **Helper scripts**: `cd backend && npm run set-code-password | make-portable | unlock`.

## Deploy / autostart (systemd, not Electron)

`scripts/linux/install.sh` installs system packages, Node + Python deps, builds the frontend, and installs/enables **systemd user services** in `scripts/linux/`:

- `jarvis-backend` (Node, `:8788`, `HOST=0.0.0.0` for LAN), `jarvis-stt`, `jarvis-tts`, `jarvis-wake`, `jarvis-ui` (Chromium kiosk).
- `jarvis-jarvisbot` / `jarvis-cloudbot` — Telegram bots; **exit 0 cleanly** when their token env var is unset (so `Restart=on-failure` won't loop).
- `jarvis-pccontrol` — Linux PC-control sidecar.

`Restart=on-failure` means **exit code 99 → systemd restarts the backend** (this is how `selfCode.scheduleRestart` applies self-edits — same contract Electron provided on desktop). UI window rules for Hyprland: `scripts/linux/hyprland-jarvis.conf`.

## Architecture

### Boot state machine (frontend, no Electron)

`bootStore` holds `DORMANT | AWAKE | PIP`. `DormantLayer` (always mounted) runs `useClapDetection` while `DORMANT`; a double clap → `AWAKE`. The detector is **pure DSP** (`hooks/useClapDetection.ts`) — four per-frame gates (loud vs adaptive noise floor, sharp attack, high crest factor, high spectral flatness); two onsets 220–900 ms apart = double clap. Mic opens with `noiseSuppression:false` + `autoGainControl:false` and `analyser.smoothingTimeConstant = 0`. There is no intermediate listening state.

### Backend (`backend/src/`)

Handler + lib pattern. `server.js` (HTTP + a single shared WS `upgrade` dispatcher → STT / TTS / skill-bus / mobile-gesture / agent-bridge) → `routes.js` (flat `{method,path}` table) → `handlers/`. `loadLocalSecrets()` runs first. At boot it also warms the Claude session, starts the in-process reminder scheduler (`startScheduler()`), and starts the Cloudflare tunnel (no-op if `cloudflared` absent).

- **`handlers/`**: `health`, `modules`, `telemetry` (reads `/proc/net/dev`), `config`, `jarvis` (turn/wake/tts; mobile turn routes through `runSpeechTurn(..., {mobile:true})`), `stt`, `speech` (the voice brain), `speakerId`, `mobile` (QR + `qr-notify` via Telegram), `mobileGesture` (WS `/api/mobile/gesture/ws` → skill bus), `wakeWord`, `uiState`, `obsidian`, `skillTools` (`/api/skills/*` bridge, incl. `model3d/add` + self-code), `pcControl` (proxy to `:8792`), `security` (portable-vault unlock), `static`.
- **`lib/`**: `http`, `attentionState`, `intentClassifier`, `modelRouter`, `intentRouter`, `conversationMemory`, `claudeCli` (persistent Claude session + `sessionAskChat`/`warmChatSession` no-MCP chat pool), `skillBus`, `skillManifest`, `skillRegistry`, `nativePrimitives`, `obsidian`, `cloudStorage` (multi-user Telegram cloud), `reminders` (4-type schema, in-process scheduler, Bogotá tz), `telegramBot`, `cloudflareTunnel`, `speakerContext`, `secrets`, `platformCrypto`, `portableVault`, `codeAuth`, `selfCode`, `tailscale`, `timerParser`.
- **`services/`**: `cloudBot.js`, `jarvisBot.js` — standalone bot processes (systemd units).

### Voice pipeline (`handlers/speech.js` + `claudeCli.js`)

STT transcript → voice-mute gate → `attentionState` + `intentClassifier` → speaker-mode gate → intent dispatch → persistent Claude CLI session driving MCP tools → streamed TTS. A dual-agent **chat ACK** (`sessionAskChat`, no MCP) speaks an instant acknowledgement while the MCP executor session works. `runSpeechTurn(body, {onSentence, mobile})` is shared by buffered + streaming endpoints; `mobile:true` bypasses the voice-mute gate and treats the turn as OWNER.

### Owner identity (speaker gate)

OWNER is granted **primarily by the baked voiceprint**: the Python speaker-ID service returns the sentinel name `__owner__` when the live voice matches `owner_voiceprint.enc` above its baked threshold; `_resolveSpeakerMode` grants OWNER for `__owner__`. **Fallback** (Linux, before the voiceprint is baked): a confident match (≥0.85) against the profile named `JARVIS_OWNER_SPEAKER` also grants OWNER. Re-bake with `make_owner_voiceprint.py`. KNOWN = conf ≥ 0.65; below that = LOW_CONF (asks to repeat).

### Security / secrets at rest (`platformCrypto`, not DPAPI)

There is no Windows DPAPI on Linux. `lib/platformCrypto.js` provides the same API (`dpapiEncrypt/Decrypt/EncryptRaw/DecryptRaw`) backed by **AES-256-GCM** with a per-machine key at `~/.config/jarvis/machine.key` (0600, auto-generated). Python `voice/python/dpapi_util.py` uses the **same key file and byte-identical container format** (`0x01 || iv(12) || ct || tag(16)`) so the owner voiceprint `.enc` round-trips between Node (writes on unlock) and Python (reads in STT). `secrets.js` encrypts `secrets.local.json` → `secrets.local.enc` on first boot (env wins over file). `portableVault.js` is the cross-machine password-derived vault (pure Node crypto); `handlers/security.js` unlocks it (`/api/security/unlock`) and writes the per-machine caches. `codeAuth.js` gates self-coding behind the `JARVIS_CODE_PASSWORD_HASH` (scrypt) via a skill-bus `request_passphrase` modal; `selfCode.js` runs the executor (run_command/checkpoint/rollback/restart) — OWNER-only.

### PC control on Linux (`pc_control_service.py`, :8792)

Rewritten for Linux (the Windows version used pywinauto/pyautogui/winreg). Same 11 endpoints; every handler is try/except-wrapped (never crashes). Detects session/compositor at call time: **input** via `ydotool` (Wayland, needs `ydotoold` + `/dev/uinput`) → `xdotool` (X11) fallback; **windows/active/focus** via `hyprctl` (Hyprland) / `swaymsg` (Sway) / `wmctrl`+`xdotool` (X11); **launch** resolves alias → `which` → `gtk-launch` → `xdg-open`; **processes/kill** via `psutil`. `read_ui` has no universal Linux equivalent → returns the window list as graceful degradation. `handlers/pcControl.js` is a pure HTTP proxy (`PC_CONTROL_URL`).

### Frontend (`frontend/src/`)

React + Vite + React Three Fiber. `AwakeApp.tsx` renders when `AWAKE`; owns gesture/voice/clap/STT hooks. Overlays: `DisplayCard` (incl. math `steps` kind), `Model3DViewer` (multi-figure via `model3dStore.specs[]`), `PassphraseOverlay` (self-code password), `UnlockGate` (vault unlock). Mobile: `MobileClient` (nav grid + push-to-talk + quick actions) embeds `MobileGestureCamera` (MediaPipe → skill bus). **No electron bridge** — talk to the backend via HTTP + the skill-bus WS. Stores: `jarvisStore`, `gestureStore`, `bootStore`, `systemStore`, `networkStore`, `displayStore`, `model3dStore`, `passphraseStore`.

### Gesture pipeline (`frontend/src/gestures/`)

MediaPipe hand landmarker → `GesturePipeline`: features → per-hand state → recognition (ML `MLGestureRecognizer` priority, rule-based fallback; rule-based pinch always overlaid right hand) → modifier layer → `GestureOutput` (`grab|point|pinch|click|back`). ML opt-in (`pipeline.initML()`). Clap detection is **not** ML.

## Conventions and gotchas

- **Spanish UI copy** (Colombia) — labels, toasts, and spoken replies. Keep consistent.
- **No Electron.** UI is Chromium kiosk via `jarvis-ui.service`. Don't add `window.electron`/`electronBridge` calls in the frontend — they don't exist. Use HTTP/skill-bus or the PC-control API.
- **Secrets are encrypted at rest.** Editing later: delete `backend/data/secrets.local.enc`, recreate `secrets.local.json`, restart (re-migrates). `backend/data/` is gitignored wholesale.
- **Node↔Python crypto must stay byte-compatible** — `platformCrypto.js` and `dpapi_util.py` share `~/.config/jarvis/machine.key` and the same GCM container. Don't change one format without the other.
- **Reminders fire in-process** via `startScheduler()` (not a separate notifier process). `attentionState` + `conversationMemory` are in-process globals (8-turn window) — reset on restart. No DB.
- **STT/TTS need the Python venv.** If `stt_service.py` isn't running, `useLocalStt` silently fails (no `webkitSpeechRecognition` fallback). TTS unreachable → renderer shows an "error de conexión" banner (no browser-`speechSynthesis` fallback).
- **Speaker ID needs ≥1 sample or the owner voiceprint** or every turn is ignored (confidence 0). First boot runs `WakeWordWizard` to enroll.
- **GPU = cu118** (RTX 3050/Ampere), never cu128. STT uses ctranslate2's own CUDA; torch is for VAD + resemblyzer.
- **2D→3D bridge by composite key** (`room::name`), not id. **`SYSTEM_TELEMETRY_ENABLED`** in `AwakeApp.tsx` gates the telemetry poll (telemetry reads `/proc/net/dev`).
- **ML gesture model** lives in IndexedDB (per browser profile); clearing `localStorage` doesn't wipe it.
- **Self-built skills** persist in `backend/src/handlers/dynamic/` and reload every boot — delete the file (and its `skillManifest` entry) to remove a bad one.
