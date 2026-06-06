# Plan — Fase 0: Refactor base (invisible al usuario)

**Spec:** `docs/superpowers/specs/2026-04-30-jarvis-claude-integration-design.md` §13 (fase 0)
**Fecha:** 2026-04-30
**Alcance:** **solo Fase 0**. Las fases 1-8 quedan fuera de este plan; cada una se planeará por separado tras completar la anterior.
**Estado:** pendiente de ejecución

---

## Objetivo

Reorganizar el código actual sin cambiar comportamiento visible. Después de Fase 0:

- `backend/src/server.js` (225 líneas) queda partido en `server.js` (~30 líneas) + `routes.js` + `handlers/*` + `lib/*`.
- `frontend/src/App.tsx` (1144 líneas) queda partido en `App.tsx` (~80 líneas) + `modes/*` + `state/*` + `api/client.ts` + `types.ts` + `constants.ts`.
- Existen tres stores Zustand vacíos (`jarvisStore`, `systemStore`, `networkStore`) tipados, montados pero sin lógica todavía.
- `API_BASE` deja de estar hardcoded; `getApiBase()` resuelve `localStorage.jarvis.api.base ?? window.location.origin`.
- Hay `.gitignore` que cubre `backend/data/`, `node_modules/`, `dist/`, etc.
- Repo git inicializado.
- Tests de caracterización pasan (golpean los endpoints actuales y el resolver de API base).

**Criterio de "hecho":** abrir la app antes y después de la fase es indistinguible para el usuario. Endpoints `/health`, `/modules`, `/api/system/telemetry`, `/api/jarvis/turn`, `/api/jarvis/device-action` devuelven exactamente el mismo JSON. Plan 2D, Plan 3D y Space Viewer funcionan idéntico, con la persistencia `localStorage` intacta.

## Pre-flight

Antes de tocar archivos:

- **Sin git todavía**: el directorio no es repo. La primera tarea inicializa git para que las commits frecuentes sean posibles.
- **Backend sin tests, sin lint**: agregamos `vitest` (mismo runner que el frontend) — un solo runtime para todo.
- **Frontend sin tests**: agregamos `vitest` + `jsdom` solo donde haga falta. Para Fase 0 basta para el resolver de `api/client.ts`.
- **No tocar lógica de Plan2DEditor/Plan3DViewer/SpaceViewer/HoloScene**: se extraen como bloques tal cual están. Cualquier "limpieza" oportunista queda fuera de scope (YAGNI).
- **No instalar Zustand sin usarlo**: lo agregamos porque la Fase 1 lo necesita y quiero los tipos listos. Stores quedan vacíos pero compilando.

## Tareas

Cada tarea es un commit. Mantener orden — las dependencias entre tareas son lineales hasta la T6, después se pueden paralelizar T7+T8+T9.

### T0 — Inicializar repo y .gitignore

- `git init` en `C:\proyecto\jarvis-desktop`
- Crear `.gitignore` con (cada línea es una entrada del archivo):
  - `node_modules/`
  - `dist/`
  - `.vite/`
  - `*.log`
  - `.DS_Store`
  - vacía
  - `# Datos locales (Fase 1+)`
  - `backend/data/`
  - `voice-sidecar/.venv/`
  - `voice-sidecar/__pycache__/`
  - vacía
  - `# Editor`
  - `.vscode/`
  - `.idea/`
- `git add -A && git commit -m "chore: init repo with .gitignore"`

**Verificación:** `git status` muestra repo limpio. `git ls-files` no incluye `node_modules/` ni archivos generados.

### T1 — Backend: agregar vitest + characterization tests

Antes de mover código, escribir tests que **fijan el comportamiento actual** (characterization tests). Si después rompemos algo en el refactor, los tests cantan.

- En `backend/`:
  - `npm install -D vitest`
  - Actualizar `package.json` scripts: `"test": "vitest run", "test:watch": "vitest"`
- Crear `backend/tests/routes.test.js`:
  - Levantar el server como subproceso con `child_process.spawn`, esperar a que imprima `Jarvis backend on...`, fetchear, comparar shape. `afterAll` mata el proceso.
  - Casos:
    - `GET /health` → `{status:'ok', service:'jarvis-backend'}`
    - `GET /modules` → `{modules: ['tv','cloud','system','jarvis-turn','telemetry']}`
    - `OPTIONS /` → 200, headers CORS
    - `POST /api/jarvis/device-action` con `{label:'Lampara'}` → `{ok:true, status:'queued', message:/Lampara/, action:{...}}`
    - `POST /api/jarvis/turn` con `{message:'apaga la luz', context:{focusedEntity:{label:'Bombillo',skillName:'lamp.power',skillAction:'off',id:'e1'}}}` → `{ok:true, reply:/Bombillo/, actions:[{type:'device_action', action:'off'}], uiHints:{highlightEntityId:'e1'}}`
    - `POST /api/jarvis/turn` sin focused entity → `{ok:true, actions:[]}`
    - `GET /404-cualquiera` → 404 `{ok:false, error:'not_found'}`
  - **No** testar `/api/system/telemetry` aquí — sus shells (`nvidia-smi`, `powershell`) son del entorno; armar mock se sale de scope.
- Correr `npm test` — debe pasar todo.
- Commit: `test: add characterization tests for current backend routes`

**Verificación:** `npm test` muestra todos los casos en verde. Si falla algo, **detenerse** — el comportamiento actual no es lo que pensabas; entender antes de seguir.

### T2 — Backend: extraer `lib/http.js` y `lib/exec.js`

- Crear `backend/src/lib/http.js`:
  - Exporta `json(res, code, payload)` y `readBody(req)` (copia idéntica de las que están en `server.js`).
- Crear `backend/src/lib/exec.js`:
  - Exporta `execCmd(command, timeoutMs = 3000)` (copia idéntica).
- Editar `backend/src/server.js`: borrar las definiciones locales, importar de `./lib/http.js` y `./lib/exec.js`.
- `npm test` — debe seguir verde.
- Commit: `refactor(backend): extract http and exec helpers to lib/`

### T3 — Backend: extraer `handlers/health.js` y `handlers/modules.js`

- Crear `backend/src/handlers/health.js` con un export `handleHealth(_req, res)` que devuelve `{ status: 'ok', service: 'jarvis-backend' }` con código 200, usando `json` de `../lib/http.js`.
- Crear `backend/src/handlers/modules.js` con un export `handleModules(_req, res)` que devuelve `{ modules: ['tv','cloud','system','jarvis-turn','telemetry'] }` con código 200.
- Editar `server.js`: importar y usar los handlers en lugar de los `if`s inline.
- `npm test` — verde.
- Commit: `refactor(backend): extract health and modules handlers`

### T4 — Backend: extraer `handlers/telemetry.js`

- Crear `backend/src/handlers/telemetry.js`:
  - Mover `lastCpuSnapshot`, `lastNetSnapshot` (módulo-level state) y todas las funciones `takeCpuSnapshot`, `getCpuTelemetry`, `getGpuTelemetry`, `getNetworkTelemetry`, `getOpenClawTelemetry`, `handleTelemetry`.
  - Exportar solo `handleTelemetry`.
- Editar `server.js`: borrar todo eso, importar `handleTelemetry`.
- `npm test` — verde (telemetry no se testea, pero el resto sigue).
- **Verificación manual:** `npm run dev` y `curl http://127.0.0.1:8788/api/system/telemetry` — debe devolver el mismo shape (CPU/mem/gpu/network/openclaw).
- Commit: `refactor(backend): extract telemetry handler with its module-level state`

### T5 — Backend: extraer `handlers/jarvis.js`

- Crear `backend/src/handlers/jarvis.js`:
  - Mover `handleDeviceAction` y `handleJarvisTurn` (sin cambiar su lógica).
  - Exportar ambos.
- Editar `server.js`: importar y usar.
- `npm test` — verde.
- Commit: `refactor(backend): extract jarvis turn and device-action handlers`

### T6 — Backend: introducir `routes.js` y reducir `server.js`

- Crear `backend/src/routes.js` con:
  - Imports: `json` de `./lib/http.js`; `handleHealth`, `handleModules`, `handleTelemetry`, `handleDeviceAction`, `handleJarvisTurn` de los handlers.
  - Constante `routes` = array de `{ method, path, handler }` con las 5 rutas actuales.
  - Función `dispatch(req, res)`: si `OPTIONS` → `json(res, 200, { ok: true })`. Buscar route con `find`. Si no hay → 404 con `{ ok: false, error: 'not_found' }`. Si hay → llamar handler.

- Reescribir `backend/src/server.js` a ~10 líneas:
  - Import `http` y `dispatch`.
  - Leer `PORT` y `HOST` desde el entorno con defaults `8788` y `127.0.0.1` (usar `globalThis.process?.env?.PORT` si quieres evitar el formato literal habitual; la idea es: defaults son los actuales).
  - `http.createServer((req, res) => dispatch(req, res)).listen(port, host, ...)`.
- `npm test` — verde.
- Commit: `refactor(backend): collapse server.js to entry + routes table`

**Decisión explícita:** `host` se queda en `127.0.0.1` por default. La spec dice que cambia a `0.0.0.0` cuando lleguemos a Fase 7 (Tailscale + PWA). No anticipar.

### T7 — Frontend: extraer `types.ts` y `constants.ts`

- Crear `frontend/src/types.ts`:
  - Mover todos los `type` declarados al inicio de `App.tsx`: `Mode`, `HoloMode`, `WallType`, `Segment`, `SavedPlan`, `EntityCategory`, `EntityKind`, `SceneEntity`, `Viewpoint`, `SystemTelemetry`, y los que aparezcan más abajo en el archivo (revisar de arriba a abajo y mover todos).
- Crear `frontend/src/constants.ts`:
  - Mover `GRID_CELLS`, `CELL_METERS`, `VIEWBOX_SIZE`, `STEP`, `PLAN_STORAGE_KEY`, `PLAN3D_ENTITY_STORAGE_KEY`, `PLAN3D_VIEWPOINT_STORAGE_KEY`, `modeMeta`.
  - **No mover `API_BASE` ni `SYSTEM_TELEMETRY_ENABLED` todavía** — eso es T9.
- Editar `App.tsx`: borrar las definiciones, agregar `import { ... } from './types'` y `import { ... } from './constants'`.
- `npm run build` — debe compilar.
- `npm run dev` y abrir el browser — UI idéntica, navegar entre modos.
- Commit: `refactor(frontend): extract types and constants from App.tsx`

### T8 — Frontend: extraer modos a archivos propios

Tres tareas pequeñas (commits separados, cada una compila):

**T8.1 — `Plan2DEditor` → `modes/Plan2DEditor.tsx`**
- Crear `frontend/src/modes/Plan2DEditor.tsx`. Copiar el componente con sus helpers locales (`snap`, `loadSavedPlans` si es local — verificar si la usan otros componentes; si sí, dejar `loadSavedPlans` en `App.tsx` o moverla a `modes/utils.ts`).
- Decisión: si una util es usada por varios modos, va a `frontend/src/modes/utils.ts`. Si es solo del componente, queda local.
- Importar tipos/constantes desde `../types` y `../constants`.
- En `App.tsx`: `import { Plan2DEditor } from './modes/Plan2DEditor'` y borrar la definición inline.
- `npm run build` y prueba manual del modo Plan 2D.
- Commit: `refactor(frontend): extract Plan2DEditor to modes/`

**T8.2 — `Plan3DViewer` (con `EntityPrimitive`) → `modes/Plan3DViewer.tsx`**
- Mismo patrón. `EntityPrimitive` es helper de este modo, va con él.
- Probar Plan 3D en browser.
- Commit: `refactor(frontend): extract Plan3DViewer and EntityPrimitive`

**T8.3 — `SpaceViewer` (con `ImmersiveFirstPersonController`, `GazeDetector`) → `modes/SpaceViewer.tsx`**
- Helpers locales van con él.
- Probar modo `space` (entrar al inmersivo desde un plan3d con viewpoint guardado).
- Commit: `refactor(frontend): extract SpaceViewer and immersive helpers`

Después de T8: `App.tsx` debería estar ~700-800 líneas (bajó de 1144). El resto en T10.

### T9 — Frontend: introducir `api/client.ts` con resolver de API base + tests

- Crear `frontend/src/api/client.ts`:
  - Constante `API_BASE_KEY = 'jarvis.api.base'`.
  - Constante `DEV_BACKEND = 'http://127.0.0.1:8788'`.
  - Función `getApiBase()`:
    1. Try-catch sobre `localStorage.getItem(API_BASE_KEY)`. Si hay valor no vacío, devolver con `.trim().replace(/\/$/, '')`.
    2. Si `window` y `window.location.origin` existen y el origin contiene `:5173` (puerto Vite dev), devolver `DEV_BACKEND`.
    3. Si `origin` empieza con `http`, devolverlo.
    4. Fallback: `DEV_BACKEND`.
  - Función `apiFetch(path, init?)`: resuelve la URL contra `getApiBase()` (a menos que `path` ya empiece con `http`) y delega en `fetch`.

- **Decisión clave sobre el resolver:** la spec §3.2 dice `localStorage.jarvis.api.base ?? window.location.origin`. Pero hoy el frontend dev corre en `:5173` (Vite) y debe golpear el backend en `:8788`. Si solo usamos `window.location.origin` rompemos el dev local. El compromiso para Fase 0: si el origin termina en `:5173`, usar `http://127.0.0.1:8788`. Si no (futuro PWA detrás de Tailscale donde el frontend lo sirve el backend), usar `origin`.

- Crear `frontend/src/api/client.test.ts`:
  - Setup: vitest con `jsdom` para tener `window.location` y `localStorage`.
  - Casos:
    - `localStorage.setItem('jarvis.api.base', 'http://10.0.0.5:9000')` → `getApiBase()` devuelve `'http://10.0.0.5:9000'`.
    - Storage value con barra final → trim trailing slash.
    - Storage vacío + origin `http://localhost:5173` → `'http://127.0.0.1:8788'`.
    - Storage vacío + origin `http://100.64.1.2:8788` (Tailscale-style) → `'http://100.64.1.2:8788'`.

- Configurar vitest para frontend:
  - Crear `frontend/vitest.config.ts` exportando `defineConfig({ test: { environment: 'jsdom', globals: true } })`.
  - `npm install -D vitest jsdom`.
  - Agregar script `"test": "vitest run"` a `frontend/package.json`.

- En `App.tsx`: reemplazar `const API_BASE = 'http://127.0.0.1:8788'` por `import { getApiBase } from './api/client'` y, donde se use, llamar `getApiBase()` (en `useEffect`/handlers, no en top-level porque podemos no tener `window` en algún test).
- **Mantener `SYSTEM_TELEMETRY_ENABLED` por ahora** — moverlo en T10 a un store o constante separada.
- `npm test` (frontend) — verde. Build — verde. Dev manual — UI idéntica.
- Commit: `feat(frontend): add api/client with API base resolver and tests`

### T10 — Frontend: stores Zustand vacíos + reducir `App.tsx`

- `npm install zustand` en `frontend/`.

- Crear `frontend/src/state/jarvisStore.ts`:
  - Importa `Mode`, `SavedPlan`, `SceneEntity`, `Viewpoint` desde `../types`.
  - Tipo local `FocusedEntity = { id: string; label: string; skillName?: string; skillAction?: string } | null`.
  - Tipo `JarvisState`: `mode: Mode`, `voiceEnabled: boolean`, `wakeListening: boolean`, `coreReply: string | null`, `focusedEntity: FocusedEntity`, `plans: SavedPlan[]`, `entitiesByPlan: Record<string, SceneEntity[]>`, `viewpointsByPlan: Record<string, Viewpoint>`, `setMode(m)`, `setFocusedEntity(e)`.
  - `useJarvisStore = create<JarvisState>(...)` con defaults: `mode: 'home'`, todo vacío/false/null. Setters simples.
  - **No conectar al `useState` actual de `App.tsx` todavía** — el store queda creado, exportado, sin consumidores. La conexión real viene en Fase 1.

- Crear `frontend/src/state/systemStore.ts`:
  - Tipo `SystemState`: `tokens: { window5h: {in,out,pct} | null; week: {in,out,pct} | null }`, `modelStats: Record<string, {turns, tokens, latencyMs}>`, `activeModel: string | null`.
  - `useSystemStore = create<SystemState>(() => ({ tokens: { window5h: null, week: null }, modelStats: {}, activeModel: null }))`.

- Crear `frontend/src/state/networkStore.ts`:
  - Tipo `Device = { mac, ip, hostname?, vendor?, lastSeen, assignedRoom? }`.
  - Tipo `NetworkState`: `discoveredDevices: Device[]`, `presenceByZone: Record<string, {value, ts} | null>`.
  - `useNetworkStore = create<NetworkState>(() => ({ discoveredDevices: [], presenceByZone: {} }))`.

- **Reducir `App.tsx` a shell + topbar + mode panel + montaje de vista activa**: con T8 ya extraídos los modos pesados, el cambio aquí es:
  - Mantener el resto de los modos (`Core`/Home, `House`, `Cloud`, `System`) inline o moverlos a `modes/` también.
  - **Decisión:** mover `HomeView`, `HouseView`, `CloudView`, `SystemView` a `modes/` solo si están claramente delimitados como funciones/JSX blocks. Si están entrelazados con state global de `App()`, dejarlos por ahora — su refactor profundo vive en Fases 3/4.
  - Lo importante es que `API_BASE` y `SYSTEM_TELEMETRY_ENABLED` ya no estén como top-level constants sueltas: `API_BASE` desapareció en T9; `SYSTEM_TELEMETRY_ENABLED` se queda como constante local del archivo (Fase 4 lo elimina).
- Build verde, dev verde, navegación entre modos verde, persistencia `localStorage` intacta (probar: dibujar un plan, recargar, plan ahí).
- Commit: `feat(frontend): add empty zustand stores and reduce App.tsx`

### T11 — Cierre: README + verificación final

- Actualizar `README.md` (root del proyecto) con un breve párrafo de la nueva estructura:
  - Backend: `src/server.js` entry, `routes.js`, `handlers/*`, `lib/*`.
  - Frontend: `App.tsx` shell, `modes/*`, `state/*`, `api/client.ts`, `types.ts`, `constants.ts`.
  - Cómo correr tests: `npm test` en `backend/` y `frontend/`.
  - **No** anunciar todavía las fases siguientes — el README es para alguien que clona ahora.
- Verificación final manual (golden path):
  1. `cd backend && npm run dev` → backend en :8788.
  2. `cd frontend && npm run dev` → frontend en :5173.
  3. Browser: cambiar entre `Core`, `Casa`, `Plano 2D`, `Espacio 3D`, `Inmersivo`, `Cloud`, `System`. Cada modo carga.
  4. Plano 2D: dibujar 3 segmentos, guardar como `room=Sala, plan=test`.
  5. Espacio 3D: cargar el plan, agregar un mueble, guardar viewpoint.
  6. Inmersivo: entrar, ver el viewpoint persistido.
  7. Recargar browser: todo el state localStorage sigue.
  8. Core: enviar texto "apaga la luz" — backend devuelve reply stub. Voz fallback browser sigue funcionando si el usuario lo prueba.
  9. `curl /api/system/telemetry` — JSON shape igual.
- `git log --oneline` → debe verse una secuencia limpia de commits T0-T11.
- Commit: `docs: update README with phase 0 structure`

## Fuera de scope (explícito)

Estas cosas se ven tentadoras durante el refactor pero **no entran en Fase 0**:

- Reescribir `Plan2DEditor`, `Plan3DViewer`, `SpaceViewer` (queda igual; mover el bloque, no editarlo).
- Eliminar `HoloScene.tsx` actual (la Fase 3 lo reemplaza con HoloSceneRoot; hoy se queda).
- Conectar los Zustand stores al state actual de `App.tsx` (Fase 1).
- Cambiar `host` a `0.0.0.0` (Fase 7).
- Borrar `SYSTEM_TELEMETRY_ENABLED` (Fase 4).
- Arreglar warnings de TS o lint si los hay (a menos que **bloqueen** el build) — lista de "después" en un comentario al final del refactor, no en código.
- Agregar archivos de configuración con secretos — Fase 0 no necesita secretos.
- Setup de Tailscale, PWA, voz, Agent SDK — todo eso son fases separadas.

## Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| El characterization test (T1) levanta el server con `child_process.spawn` y queda colgado en CI/local | `afterAll` debe matar el proceso. Timeout de 5s en cada `fetch`. |
| Mover `lastCpuSnapshot`/`lastNetSnapshot` a otro módulo cambia su scope | Son `let` a nivel módulo en JS — siguen siendo globales del módulo `handlers/telemetry.js`, comportamiento idéntico. Test manual con dos `curl` consecutivos verifica que el delta funciona. |
| `EntityPrimitive`, `ImmersiveFirstPersonController`, `GazeDetector` cierran sobre vars del scope de `App()` | Verificar caso por caso al extraer. Si lo hacen, mover el var como prop. Es probable que **no** lo hagan (son R3F components con props bien definidos). Si pasa, parar y discutir. |
| `getApiBase()` rompe el dev workflow al detectar `:5173` | Test cubre los dos casos (Vite dev y Tailscale-style origin). Probar manualmente con backend corriendo. |
| Un commit grande rompe algo que el siguiente tapa | Cada T es un commit; revertir uno solo es trivial (`git revert <sha>`). Ese es el seguro. |

## Checklist de salida (criterio de aceptación)

- [ ] Repo git inicializado, `.gitignore` cubre datos locales y `node_modules/`.
- [ ] `backend/src/server.js` ≤ 35 líneas.
- [ ] `frontend/src/App.tsx` reducido (objetivo ≤ 250 líneas; aceptable hasta 400 si los modos no extraídos en este plan ocupan mucho).
- [ ] `cd backend && npm test` verde (al menos los 5 endpoints cubiertos).
- [ ] `cd frontend && npm test` verde (resolver de API base).
- [ ] `cd frontend && npm run build` sin errores.
- [ ] Smoke test manual del golden path (T11) pasa.
- [ ] `git log --oneline` muestra commits T0-T11 limpios.
- [ ] No se introdujo ninguna dependencia más allá de `vitest`, `jsdom`, `zustand`.
- [ ] Ningún archivo en `backend/data/` (la carpeta no existe todavía — Fase 1 la crea).

Cuando todo esto esté chequeado, Fase 0 está cerrada y se puede planear Fase 1 (Agent SDK + tools + memoria) sobre estructura limpia.
