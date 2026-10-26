# backend/

Node ESM, sin framework: `src/server.js` despacha HTTP y upgrades WS por ruta. Tests con vitest (`npm test`).

- Tras cambiar `src/**`: `systemctl --user restart jarvis-backend` (no hay auto-reload) y despierta la UI con `POST /api/skills/system/wake`.
- Rutas nuevas de riesgo: regístralas en `webAuth` (`DANGEROUS_PATHS`) y en `toolRisk.js`.
- Tool nueva para la voz: handler en `src/handlers/` + tool en `mcp-server/` + superficie en `src/lib/voiceTools.js`.
- `node:sqlite` vía `createRequire`; `runClaude` con `multiline: true` si la respuesta ocupa varias líneas.
- `voice/python/`: cada servicio tiene su unit; usa siempre `.venv/bin/python`.

Antes de tocar, lee en `../docs/architecture/`: `backend.md` (mapa), `voz-stt.md` (STT y speaker-id), `memoria-y-telemetria.md`, `verificacion-de-turnos.md`, `permisos-y-proactividad.md`, `herramientas-de-voz.md`, `autodesarrollo.md`, `cli-claude-binario.md`, `acceso-remoto-y-movil.md`.
