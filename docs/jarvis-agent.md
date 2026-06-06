# Jarvis como agente operativo

Jarvis controla la app llamando a **capacidades** (tools) registradas en el
frontend. El flujo es: voz/texto → **router Tier-0** (comandos frecuentes, sin
LLM) → si no, **cerebro** (backend, vía WebSocket) → ejecuta capacidades en la UI
→ respuesta hablada.

## Componentes

- **Frontend** (`frontend/src/agent/`): `registry.ts` (registro + validación +
  ejecución), `capabilities/*` (navegación, plan, timer…), `snapshot.ts` (estado
  vivo para el modelo), `router.ts` (Tier-0), `bridge.ts` (cliente WebSocket).
- **Backend** (`backend/src/agent/`): `ws.js` (WebSocket sin dependencias),
  `bridge.js` (sesiones + tool-calls), `brain.js` (cerebro intercambiable).

El frontend **anuncia su registro** al backend al conectar, así el cerebro
descubre dinámicamente qué puede hacer (árbol de capacidades dinámico).

## Cerebros disponibles (`JARVIS_BRAIN`)

| Valor | Qué usa | Auth | Para |
|---|---|---|---|
| `heuristic` (def.) | Reglas, offline, sin deps | — | Dev / fallback. Funciona en el `.exe` sin nada. |
| `agent-sdk` | `@anthropic-ai/claude-agent-sdk` | **Suscripción Claude** | **Uso personal/local.** |
| `messages-api` | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | App distribuida a otros usuarios. |

Cualquier cerebro Claude que falle (sin deps / sin login) **cae automáticamente
al heurístico**, así la app nunca se queda muda.

## Modo suscripción (recomendado para ti)

```bash
cd backend
npm run setup:claude     # instala @anthropic-ai/claude-agent-sdk + zod (no-save)
claude login             # autentica con tu suscripción Claude
npm run dev:claude       # arranca con JARVIS_BRAIN=agent-sdk
```

Opcional: `JARVIS_MODEL=claude-sonnet-4-6` para fijar el modelo.

> ⚠️ **Política de Anthropic:** usar la **suscripción** es válido para uso
> **personal en tu máquina**. Si distribuyes Jarvis a otras personas, debes usar
> `messages-api` con tu propia `ANTHROPIC_API_KEY` (no se permite enrutar la
> suscripción de los usuarios). Cambiar de cerebro NO toca el registro ni el
> frontend.

## Variables de entorno (backend)

- `JARVIS_BRAIN` — `heuristic` | `agent-sdk` | `messages-api`
- `JARVIS_MODEL` — id de modelo (opcional)
- `JARVIS_MAX_STEPS` — máx. iteraciones de tool-use (messages-api, def. 8)
- `JARVIS_TOOL_TIMEOUT_MS` — timeout por tool-call (def. 15000)
- `ANTHROPIC_API_KEY` — solo para `messages-api`

`GET /api/jarvis/agent/health` informa el cerebro activo y sesiones abiertas.

## Añadir una capacidad nueva (ejemplo: el temporizador)

1. (Si necesita UI/estado) crea el store/componente — p.ej. `state/timerStore.ts`
   + `components/TimerOverlay.tsx`.
2. Declara la capacidad en `agent/capabilities/<dominio>.ts` con `id`,
   `description`, `params` (JSON-Schema) y `run()` que muta el store.
3. Regístrala en `agent/index.ts` (`setupAgent`).
4. (Opcional) añade un atajo Tier-0 en `router.ts` para frases muy frecuentes.
5. (Opcional) enseña al cerebro heurístico a planificarla en `backend/.../brain.js`.

El cerebro `agent-sdk`/`messages-api` la descubre sola: aparece en el registro
anunciado, sin tocar el backend.

## Generar el `.exe` de Windows

No se puede compilar en Linux (target NSIS). El workflow
`.github/workflows/build-windows.yml` lo construye en un runner Windows y lo
publica como artefacto/Release al pushear un tag `v*` (o manualmente desde la
pestaña Actions). El binario no se versiona en git.
