# Jarvis Linux — System Shell Design

**Date:** 2026-06-06  
**Status:** Approved for implementation  
**Base project:** `jarvis-desktop` → ported to `jarvis-linux`

---

## Overview

Port Jarvis from an Electron app on Windows to a system-level daemon stack on Linux. The result is not an app you launch — Jarvis is always running as a set of systemd services, and the UI is a Chromium surface you summon or dismiss. Targets EndeavourOS (Arch-based) as the primary distribution; designed to work on any Wayland compositor or X11.

---

## Section 1 — System Architecture

### Daemon stack (always alive)

```
Boot
└── systemd (user session)
    ├── jarvis-backend.service   → Node.js :8788 (API + serves built frontend)
    ├── jarvis-stt.service       → Python faster-whisper :8790
    ├── jarvis-tts.service       → Python edge-tts/XTTS  :8791
    ├── jarvis-wake.service      → Python openWakeWord (mic always open)
    └── hyprland.service         → Wayland compositor (optional, preferred)
        └── jarvis-ui            → Chromium --app=http://localhost:8788
                                   (always running, hidden in DORMANT state)
```

All four backend services start at login via `systemd --user`. They never stop while the user is logged in. Chromium also starts at login and stays running — in DORMANT state it is hidden (`window.style.visibility = hidden` + `--start-minimized`), not closed, so wake latency is near-zero. If Chromium crashes, systemd restarts it via `Restart=on-failure`.

**Frontend serving:** The Node.js backend (`server.js`) is extended to serve the built Vite output from `frontend/dist/` as static files at the root path. No separate Vite process in production. Development mode keeps Vite at :5173 (URL overridden by `JARVIS_UI_DEV=true` env var).

### Communication channels

| Channel | Transport |
|---|---|
| UI ↔ Backend | WebSocket + HTTP (existing) |
| Wake daemon → Backend | `POST /api/jarvis/wake-detected` |
| Backend → UI | WebSocket push `{type, payload}` |
| Backend → Hyprland | `hyprctl dispatch` via shell exec |
| UI drag intent → Backend | `POST /api/jarvis/ui-state {state}` |

### Compositor independence

All fullscreen/PIP/dismiss operations use Chromium's own APIs:
- `document.documentElement.requestFullscreen()` → fullscreen
- `window.resizeTo(400, 300)` → PIP size
- No `hyprctl` required for these; Hyprland integration is additive, not required.

Only "no window decorations" requires compositor cooperation. Chromium `--app` mode removes browser chrome. Hyprland users get a `windowrulev2 = noborder` rule; other compositors degrade gracefully (decorations visible but functional).

### What is removed

- `electron/main.js` — deleted entirely
- `electron/preload.js` — deleted
- `electron/config.js` — deleted
- Root `package.json` Electron scripts replaced by Linux startup scripts

---

## Section 2 — UI States and Transitions

### States

```
DORMANT
  Chromium running but hidden (window invisible, no screen real estate).
  All daemons running.
  Clap detection and wake word detection active.

AWAKE
  Chromium fullscreen overlay over all windows.
  All features active: gestures, voice, 3D, ring navigation.

PIP
  Chromium floating window ~400×300px.
  Same React UI, responsive layout via ResizeObserver.
  Draggable, stays on top of other apps.
  Clap and wake word still active.

VOICE_MUTED
  Sub-state within AWAKE or PIP.
  STT captures audio but intentClassifier blocks all command processing.
  Clap detection and wake word still active — these always bypass the mute.
  Exits automatically on double clap or wake word.

VOICE (wake-word triggered)
  PIP surface shown with listening indicator.
  STT active, awaiting command after wake word.
  If response needs visuals → transitions to AWAKE automatically.
  If voice-only response → returns to pre-VOICE state.
```

### Transitions

| Trigger | From | To |
|---|---|---|
| Double clap | DORMANT | AWAKE |
| Double clap | AWAKE/PIP | DORMANT |
| Hotkey `Ctrl+Alt+J` | any | AWAKE |
| Wake word "Jarvis" | DORMANT / PIP | VOICE |
| Voice command processed (visual) | VOICE | AWAKE |
| Voice command processed (audio only) | VOICE | previous state |
| Voice "minimizar" / drag to edge zone | AWAKE | PIP |
| Drag to center zone / voice "expandir" | PIP | AWAKE |
| Voice "jarvis no escuches" / "ignora" | AWAKE/PIP | VOICE_MUTED |
| Double clap or wake word | VOICE_MUTED | AWAKE |

### PIP drag mechanics

The drag is UI-driven, not OS-native window drag:

1. AWAKE shows a drag handle bar at top edge.
2. User drags toward screen edge → frontend sends `POST /api/jarvis/ui-state {state: 'pip'}`.
3. Backend calls `window.resizeTo(400, 300)` via WebSocket instruction to frontend; Hyprland users also get `hyprctl dispatch togglefloating`.
4. Frontend switches to PIP layout via `ResizeObserver` (CSS breakpoints, no JS logic).
5. PIP shows a center drop zone. Dragging there → `POST {state: 'awake'}` → fullscreen.

---

## Section 3 — Wake Word Daemon

### jarvis-wake.service

```
PyAudio 16kHz mono stream
  → openWakeWord ONNX model (CPU, ~2% load)
    → confidence ≥ threshold
      → POST /api/jarvis/wake-detected {confidence, ts}
        → backend updates state → WebSocket push to UI
```

Mic is separate from the STT mic — always open at low sample rate. openWakeWord runs the base "hey jarvis" model, calibrated to the user's voice profile.

### Setup wizard (first boot)

Triggered when `~/.config/jarvis/wake-model-profile.json` is absent.

```
Step 1 — Record 4 samples
  "Decí 'Jarvis' 4 veces"
  Captured at different distances/tones via Web Audio API.

Step 2 — Done
  POST /api/jarvis/wake-calibrate {samples: [...]}
  Backend saves voice embeddings via resemblyzer.
  No model training, no threshold slider, no negative samples.
```

No threshold adjustment exposed to user. System auto-calibrates from the 4 samples.

### Short-phrase speaker detection

resemblyzer struggles with audio <1.5s. Fix: accumulate wake word + first sentence before deciding speaker mode:

```
"Jarvis" (~0.8s) + first utterance (~1.5s) = ~2.3s → reliable embedding
```

If confidence is still low after accumulation → LOW_CONF state → Jarvis asks a clarifying question to gather more audio before deciding.

---

## Section 3b — Speaker Identity System

### Four speaker modes

| Mode | Who | Access |
|---|---|---|
| `OWNER` | Registered owner (you) | Full: commands, MCP tools, system, Obsidian, reminders |
| `KNOWN` | Registered non-owner | Limited: text responses, 3D viewer, formulas, URL/file display |
| `UNKNOWN` | Unrecognized voice | Limited (same as KNOWN) + first-contact dialogue + auto-enroll |
| `LOW_CONF` | Low embedding confidence | Hold response, gather more audio, re-evaluate |

### OWNER behavior

On activation:
- Greet by name, time-appropriate ("buenos días señor", "buenas noches")
- Brief daily briefing: today's reminders + pending tasks
- Full banter, jokes, creative conversation
- All MCP tools and system commands available

### UNKNOWN first-contact dialogue

```javascript
// Jarvis chooses randomly from opener set:
const openers = [
  "Usuario no reconocido. Sistema limitado activado.",
  "Sistema comprometido. Autodestrucción en 3... 2... 1... — es broma. Hola desconocido, ¿quién sos?",
  "Alerta de intruso. Iniciando protocolo... — es broma. ¿Con quién tengo el gusto?"
]
```

User says their name → audio captured → marked for speaker enrollment → backend creates new profile via `speaker_id.py`.

### Auto-learning: continuous enrollment

**New person:** name utterance audio → new speaker profile created automatically, no manual recording session needed.

**Existing speakers:** every 5th audio segment longer than 2 seconds → silently marked as reinforcement sample → `speaker_id.py` updates embedding in background.

### Audio cap

- Max **50 samples per speaker** stored on disk.
- When cap reached: FIFO (oldest sample deleted first).
- Each sample trimmed to max 5 seconds before storage.
- Storage path: `backend/voice/samples/<speaker_name>/` (existing structure).

### intentClassifier gate

```
OWNER      → full intent set (all commands)
KNOWN      → limited intent set (display, 3d, formulas, urls, conversation)
UNKNOWN    → same as KNOWN until confirmed, then enroll
LOW_CONF   → no intent processing, gather audio
VOICE_MUTED → all intents blocked except wake/clap
```

---

## Section 4 — Response Latency Architecture

### Problem

Current flow is sequential — voice response waits for function completion:

```
STT → classify → await function() → await Claude → TTS → speak
```

Functions like 3D render, navigation, and display block voice response.

### Solution: two-track parallel response

```
STT → classify →
  Track A [<300ms]  instant ACK → TTS speaks immediately
  Track B [async]   function executes → WebSocket push → UI renders
```

Track A uses a static ACK map — no LLM call:

```javascript
const ACK_MAP = {
  show_3d:        "Preparando visor 3D...",
  navigate:       "Navegando...",
  render_formula: "Calculando...",
  reminder_create:"Anotado, señor.",
  timer_start:    "Temporizador iniciado.",
  gesture_toggle: "Gestos actualizados.",
  // ...
}
```

Track B fires the function without awaiting before Track A completes.

For Claude conversational responses:

```
claude --print streaming →
  first ~10 tokens → TTS immediately
  continues streaming → TTS reads in parallel
  function (if any) fires concurrently
```

### Perceived latency target

| Action | Before | After |
|---|---|---|
| "Muéstrame la superficie de Fermi" | ~3.5s | Voice: <300ms, render: ~1s |
| "Pon un timer de 5 minutos" | ~2s | <300ms |
| Conversational question | ~3s | First words: <400ms |

---

## Section 5 — 3D Viewer: Gestures, Mouse, Controls

### Rotation smoothing (already implemented ✅)

EMA filter applied to all rotation deltas in `Model3DViewer.tsx`:

```typescript
const EMA_ROT = 0.18  // ~93ms time-constant at 60fps
smoothDX.current += (grab.deltaX - smoothDX.current) * EMA_ROT
smoothDY.current += (grab.deltaY - smoothDY.current) * EMA_ROT
smoothDA.current += (grab.deltaAngle - smoothDA.current) * EMA_ROT
```

Resets to 0 on each new grab onset.

### Sensitivity and zoom (already implemented ✅)

| Parameter | Before | After |
|---|---|---|
| `ROTATE_GAIN` (X/Y axis) | 2.2 | 4.0 — less hand travel needed |
| Default camera Z | 6 | 12 — starts outside large figures |
| Max zoom-out | 14–16 | 35 — large figures fully visible |
| Zoom formula base | 6 or 8 | 12 — consistent with camera init |

### Gesture check on 3D open

When `Model3DViewer` mounts:

```typescript
if (!gestureStore.enabled) {
  // show toast: "¿Activar gestos para el visor 3D?" [Sí] [No]
  // [Sí] → gestureStore.setEnabled(true) → Jarvis TTS: "Gestos activados."
}
```

### Mouse controls (fallback)

`@react-three/drei` `<OrbitControls>` added to Scene:

- Left drag → orbit (same as grab gesture)
- Scroll wheel → zoom (same as pinch)
- Right drag → pan

Activation logic:
- If `gestureStore.enabled === true` → OrbitControls disabled (avoid conflict)
- If `gestureStore.enabled === false` → OrbitControls enabled automatically

### Gesture toggle via voice/Jarvis

```
"Jarvis activa gestos"    → intent: toggle_gestures(true)
"Jarvis desactiva gestos" → intent: toggle_gestures(false)
```

Backend → WebSocket push `{type: 'gestures_state', enabled: bool}` → `gestureStore.setEnabled()`.

---

## Section 6 — Code Changes Inventory

### Deleted

```
electron/main.js
electron/preload.js
electron/config.js
```

### Modified

| File | Change |
|---|---|
| `frontend/src/state/bootStore.ts` | Remove Electron IPC; add WebSocket listener for boot state |
| `frontend/src/App.tsx` / `AwakeApp.tsx` | Remove IPC listeners; add PIP drag handle; add VOICE_MUTED state |
| `frontend/src/components/Model3DViewer.tsx` | ✅ Done: EMA, ROTATE_GAIN, zoom, camera, OrbitControls, gesture check |
| `backend/src/handlers/telemetry.js` | Replace `powershell Get-NetAdapterStatistics` with `/proc/net/dev` reader; `nvidia-smi` unchanged |
| `backend/src/lib/intentClassifier.js` | Add ACK_MAP; add `toggle_gestures`, `voice_muted` intents; add speaker_mode gate |
| `backend/src/lib/attentionState.js` | Add `VOICE_MUTED` state and transitions |
| `backend/src/handlers/speech.js` | Two-track response: fire ACK immediately, function fire-and-forget |
| `backend/voice/python/speaker_id.py` | Accumulate audio window; FIFO cap 50 samples/speaker; background embedding update |

### New files

```
backend/voice/python/wake_service.py
  openWakeWord daemon; POST to /api/jarvis/wake-detected on trigger

backend/src/handlers/wakeWord.js
  endpoints: POST /api/jarvis/wake-detected, POST /api/jarvis/wake-calibrate

backend/src/lib/speakerContext.js
  holds current speaker identity + mode; updated per turn; exported to speech.js

frontend/src/components/WakeWordWizard/
  index.tsx — 4-step wizard: record 4 samples → calibrate → done
  triggered on first boot when ~/.config/jarvis/wake-model-profile.json absent

frontend/src/components/UnknownUserDialog/
  index.tsx — unknown-user first contact; asks name; submits for enrollment

scripts/linux/
  jarvis-backend.service   — systemd unit for Node.js backend (serves API + static frontend)
  jarvis-stt.service       — systemd unit for STT Python service
  jarvis-tts.service       — systemd unit for TTS Python service
  jarvis-wake.service      — systemd unit for wake word daemon
  jarvis-ui.service        — systemd unit for Chromium --app (Restart=on-failure, After=jarvis-backend)
  install.sh               — pacman + pip installs; enables systemd units; sets up ~/.config/jarvis/
  hyprland-jarvis.conf     — optional Hyprland window rules (noborder, float rules)
```

---

## Out of scope (future)

- Tauri migration (replace Chromium dependency)
- Native wlr-layer-shell surface
- Multi-monitor support
- KNOWN speaker permission customization UI
