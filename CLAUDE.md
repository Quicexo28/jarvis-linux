# Jarvis (jarvis-linux)

Asistente de voz y escritorio para Linux/Hyprland. Backend Node ESM (cerebro), frontend React+Vite dentro de un shell Tauri, servicios Python de voz (STT/TTS/wake/embeddings), agentes Rust para otras máquinas y companions Android/iOS.

Este archivo solo trae lo que aplica a cualquier tarea. El detalle vive en `docs/architecture/` — **lee el doc de la zona antes de tocarla** (índice al final).

## Mapa

| Ruta | Qué es |
|---|---|
| `backend/src/` | Servidor HTTP+WS (`server.js`), `handlers/`, `lib/`, `agent/`, `services/` |
| `backend/mcp-server/` | Paquete Node aparte: expone las skills como tools MCP (stdio, `.mcp.json`) |
| `backend/voice/python/` | `stt_service.py`, `xtts_service.py`, `wake_service.py`, `embed_service.py` (venv propio) |
| `backend/data/` | Estado y secretos locales (gitignored): `secrets.local.json`, `jarvis.db`, jobs |
| `frontend/src/` | UI React + zustand; `gestures/`, `audio/`, `lib/sim/`, `state/` |
| `frontend/src-tauri/` | Shell Rust (Super+J, ventana fullscreen transparente) |
| `agents/` | Workspace Cargo separado: `protocol`, `hub`, `agent` |
| `android-companion/`, `ios-companion/` | Apps móviles |
| `scripts/linux/` | Units systemd, `install.sh`, `pc-ctl`, conf de Hyprland |

## Comandos

- Backend: `cd backend && npm run dev` (→ `http://0.0.0.0:8788`). Tests: `npm test`. **No hay auto-reload**: `dev` es `node src/server.js`.
- Frontend: `cd frontend && npm run dev` (Vite, 5173, hot-reload). Build: `npm run build`. Tests: `npm test`.
- Tauri dev: `cd frontend && npm run tauri dev`. Build producción: `cd frontend && npm run tauri:build` (el script ya lleva `--no-bundle`) → `frontend/src-tauri/target/release/jarvis`.
- Python: `cd backend/voice/python && .venv/bin/python <servicio>.py`. Deps: `.venv/bin/pip install -r requirements.txt`.
- MCP server (primera vez): `cd backend/mcp-server && npm install`.
- Agentes Rust: `cd agents && cargo build` / `cargo test`.
- Eval de voz: `cd backend && npm run eval:voice` — gasta tokens reales, maneja el asistente real y exige la UI despierta.
- Atajos desde la raíz: `npm run dev:backend|dev:frontend|build:frontend|test:backend|test:frontend`.

## Producción (systemd de usuario)

Units en `scripts/linux/*.service`, instaladas en `~/.config/systemd/user/` por `scripts/linux/install.sh`. Usan `%h/jarvis-linux`: `~/jarvis-linux` es un symlink a este repo, no lo rompas.

Servicios: `jarvis-backend`, `jarvis-stt`, `jarvis-tts`, `jarvis-wake`, `jarvis-embed`, `jarvis-ui`, `jarvis-agenthub`, `jarvis-notifier`, `jarvis-jarvisbot`, `jarvis-cloudbot`, `jarvis-sunshine-pc`.

Logs: `journalctl --user -u <servicio> -f`. Estado: `systemctl --user status <servicio>`.

Puertos: backend 8788 · python 8789-8791 (STT 8790) · pc_control 8792 · hub de máquinas 8794 (WS) / 8795 (control local) · Agent Hub de Claude 8796 (repo aparte, servicio `claude-agenthub`).

### Tras cada cambio, reinicia lo afectado

| Cambiaste | Haz |
|---|---|
| `backend/src/**` | `systemctl --user restart jarvis-backend` |
| `backend/voice/python/*.py` | reinicia el servicio Python tocado (`jarvis-stt` / `jarvis-tts` / `jarvis-wake` / `jarvis-embed`) |
| `requirements.txt` | `pip install -r` en el `.venv`, luego reinicia el servicio |
| `backend/package*.json` | `npm install` en `backend/`, luego reinicia `jarvis-backend` |
| `frontend/src/**` | `npm run tauri:build` **y después** `systemctl --user restart jarvis-ui` |
| `scripts/linux/*.service` | `systemctl --user daemon-reload` + reinicia la unit |
| `.mcp.json`, `backend/mcp-server/**` | recarga la conexión MCP de Claude Code (no hay unit) |
| `backend/data/secrets.local.json` | reinicia `jarvis-backend` (se lee al arrancar) |

## Reglas globales

- **Compila Tauri ANTES de reiniciar `jarvis-ui`.** El binario embebe el frontend; si no, sirve assets viejos (síntoma: primitivas del skill bus fallan con errores de código antiguo, p. ej. `invalid_model3d_kind`).
- **Reiniciar `jarvis-backend` deja la UI en DORMANT** (`Requires=`). Lo que toque el renderer falla con `renderer_not_connected` hasta `POST /api/skills/system/wake`.
- **Secretos en `backend/data/secrets.local.json`**, no en `backend/`. Un archivo en la ruta equivocada se ignora en silencio. El entorno ya definido (p. ej. en el `.service`) gana sobre el fichero.
- **Textos de UI en español.** Etiquetas, toasts y respuestas habladas.
- **Persistencia**: SQLite built-in (`node:sqlite`) en `backend/data/jarvis.db` para turnos, hechos y `kv`. `attentionState` y `conversationMemory` (ventana de 8 turnos) siguen siendo globales en RAM y se pierden al reiniciar.
- **`node:sqlite` se carga con `createRequire`, nunca con import estático**: vitest muere en la colección con `Failed to load url sqlite`.
- **`runClaude` devuelve solo la última línea de stdout.** Si la respuesta ocupa varias líneas (JSON), pasa `multiline: true`.
- **Nunca `--bare` con el CLI de Claude**: fuerza `ANTHROPIC_API_KEY` y rompe la auth por suscripción.
- **Rutas de riesgo son local-only** (`webAuth` `DANGEROUS_PATHS`) y pasan por `toolRisk`. Una ruta nueva que ejecute, escriba o lance agentes debe registrarse en ambos. No relajes un gate para que pase un test.
- **El micrófono del renderer es un único stream compartido** (`frontend/src/audio/micFeed.ts`). Nunca `getUserMedia` propio ni `track.stop()` sobre él: usa `acquireMic`/`releaseMic`. Varios streams tumban el WebProcess de WebKitGTK.
- **Nada asigna memoria por frame** (`useFrame`, pipeline de gestos, simulador): en este WebKitGTK la basura se ve como tirones. La física no pasa por React.
- **La wake phrase se matchea en tres runtimes** (`frontend/src/lib/wakePhrase.ts`, `backend/src/lib/intentClassifier.js`, `stt_service.py`). Toca uno ⇒ toca los tres y sus tests.
- **Speaker-id recibe audio crudo; solo Whisper recibe audio sin ruido.** No bajes umbrales del backend para "arreglar" un score bajo, no borres `_cohort/` ni saltes el gate de cohorte.
- **`nativePrimitives.js` es Windows-first**: cámara y captura fallan en silencio en Linux; el camino válido es el renderer por el skill bus.
- **Super+J solo existe con el binario Tauri en marcha.** En modo Chromium hay que cablearlo con un `bind` de Hyprland contra la API.
- **Puente 2D→3D por clave compuesta `room::name`**, no por id: renombrar un plano en 2D deja huérfanas sus entidades 3D.
- **El modo `studio` (Estudio 3D) se eliminó a propósito.** No lo reconstruyas sin que lo pidan (`docs/HISTORY.md`).
- **Autodesarrollo**: el backend se reinicia al final por `scheduleRestart()` (exit 99), nunca con `systemctl` desde un job — mataría al propio agente. Detalle en `docs/architecture/autodesarrollo.md`.

## Al trabajar aquí

- Verifica con tests o contra el servicio vivo antes de dar algo por hecho; di qué comprobaste y qué no.
- Los valores medidos (umbrales de voz, de aplauso, de gestos) salieron de grabaciones reales. No los cambies sin medir.
- Cuando aprendas un gotcha nuevo, añádelo al doc de su zona. A este archivo solo sube lo que afecte a todo el repo, en una línea y sin fecha.
- No hagas commit ni push salvo que se pida.

## Índice de `docs/architecture/`

| Vas a tocar | Lee |
|---|---|
| Tauri vs Chromium, estados DORMANT/AWAKE/PIP, doble aplauso, Hyprland, `jarvis-ui.service` | `shell-y-arranque.md` |
| `server.js`, handlers, libs, bridge del agente, MCP server | `backend.md` |
| `agents/`, hub Rust, protocolo, Wake-on-LAN, despliegue en Windows | `agentes-distribuidos.md` |
| `computerAgent.js`, `pc-ctl`, ydotool, `riskAuth.js`, elevación desde la tablet | `agente-escritorio-y-autorizacion.md` |
| `claudeAgents.js`, servicio `claude-agenthub` | `agent-hub.md` |
| `devAgent.js`, `code_task`, checkpoints y rollback | `autodesarrollo.md` |
| `turnStore.js`, `memory.js`, sesiones del CLI, stats | `memoria-y-telemetria.md` |
| `verifier.js`, correctivos tras el turno | `verificacion-de-turnos.md` |
| `toolRisk.js`, proactividad, sentidos | `permisos-y-proactividad.md` |
| `JARVIS_CLAUDE_BIN`, CLI roto tras actualizar | `cli-claude-binario.md` |
| `voiceTools.js`, qué tools ve la voz | `herramientas-de-voz.md` |
| Modo estudio, escritorio, velocidad del turno | `estudio-y-productividad.md` |
| Autodiagnóstico, agenda, embeddings, recall híbrido | `autodiagnostico-agenda-memoria-semantica.md` |
| STT, endpointing, speaker-id, voiceprint, wake phrase, keyring | `voz-stt.md` |
| QR móvil, acceso web por Tailscale, `webAuth`, companions | `acceso-remoto-y-movil.md` |
| `frontend/src/gestures/` | `gestos.md` |
| `theme.ts`, grafo del vault, stores, persistencia, `micFeed`, `clapEngine` | `frontend-ui.md` |
| `Model3DViewer`, kinds 3D, `lib/sim/`, física | `visor-3d-y-simulacion.md` |

Otros: `docs/HISTORY.md` (decisiones cerradas), `docs/PENDIENTES.md`, specs sueltas en `docs/`.
