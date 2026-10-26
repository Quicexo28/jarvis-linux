# Shell de escritorio, arranque y systemd

> Extraído de CLAUDE.md. Detalle de referencia: leer antes de tocar esta zona.

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
- **Double clap** → `useClapDetection` (adaptador WebAudio) + `audio/clapEngine.ts` (DSP puro, testeable en Node) fires `setBootState('AWAKE')`. Gates por frame: LOUD (sobre suelo adaptativo **y** piso absoluto `absMinRms`), SHARP (ataque), BROADBAND (planitud > 0.9), NO-GRAVE (<1 kHz aporta < 40%). Gates de par: el primer aplauso debe CAER al 25% de su pico en ≤200 ms (validado durante la espera → gratis) y ambos espectros deben parecerse (coseno ≥ 0.80). Dos onsets 200–1000 ms aparte = doble aplauso; dispara en el SEGUNDO onset. Silenciado mientras `isTtsSpeaking()`. Micro compartido vía `micFeed` (`noiseSuppression:false` + `autoGainControl:false`). `debug: true` loguea cada evento; el disparo se loguea SIEMPRE (`[clap] DOBLE APLAUSO ...` → journald).
- **Sleep tool** → backend `POST /api/skills/system/sleep` → skill bus → frontend calls `setBootState('DORMANT')`.

`DormantLayer` always mounts and runs clap detection while `DORMANT`. `AwakeApp.tsx` mounts when `AWAKE`.

- **`jarvis-ui.service` necesita `TimeoutStartSec=90`.** Su `ExecStartPre` espera hasta 30 s por el socket Wayland pero el manager de usuario trae `DefaultTimeoutStartSec=15s` → systemd mataba el start-pre y el servicio entraba en bucle de reinicios (32 seguidos observados).
- **Tauri global shortcut (Super+J) only works when the Tauri binary is running**, not when using the Chromium app-mode service. For Chromium+Hyprland, wire Super+J via a Hyprland `bind` that hits the backend API.

