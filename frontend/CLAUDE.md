# frontend/

React + Vite + zustand, empaquetado en Tauri (`src-tauri/`). Corre en WebKitGTK, no en Chromium: asume menos rendimiento y un cliente PipeWire frágil.

- Tras cambiar `src/**`: `npm run tauri:build` y después `systemctl --user restart jarvis-ui`. En `npm run dev` hay hot-reload.
- Micrófono solo por `src/audio/micFeed.ts` (`acquireMic`/`releaseMic`).
- Cero asignaciones por frame en `useFrame`, gestos y simulador; la física no pasa por React (a zustand solo llega el HUD).
- Matemática pura (`src/lib/geometry/`, `src/lib/sim/`, `src/audio/clapEngine.ts`) sin Three ni DOM, para que se pueda testear en Node.
- Kinds 3D nuevos: envuélvelos en try/catch; una fórmula mala del LLM debe dar un objeto vacío, no tumbar el overlay.
- Textos en español. Colores por `src/lib/theme.ts`, no hex sueltos.

Antes de tocar, lee en `../docs/architecture/`: `shell-y-arranque.md`, `frontend-ui.md`, `gestos.md`, `visor-3d-y-simulacion.md`.
