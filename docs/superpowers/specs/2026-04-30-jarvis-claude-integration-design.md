# Jarvis Desktop — Integración con Claude, voz local, HoloScene unificado y rediseño v1

**Fecha:** 2026-04-30
**Autor:** brainstorming Claude Opus 4.7 + santiagoquicenoqp@gmail.com
**Estado:** aprobado — pendiente de implementación

---

## 1. Objetivo

Convertir `jarvis-desktop` de un MVP con backend stub en un asistente de casa funcional, controlable por voz y texto, con:

- Cerebro real (Claude vía Agent SDK + suscripción Claude Code)
- Voz clonada local (XTTS v2 + Whisper.cpp)
- Acceso remoto desde celular (Tailscale + PWA)
- Telemetría de tokens propia (no depende de Anthropic billing API)
- Hologramas 3D funcionales — vinculados a datos en vivo, no decorativos
- Embebido de Claude Code dentro de la app (modo `Lab`)
- Descubrimiento de dispositivos en red WiFi
- Memoria persistente entre sesiones

## 2. Arquitectura general

App empaquetada como **Electron desktop app (.exe)** que envuelve tres procesos. Distribución vía instalador NSIS con autostart opt-in. Acceso remoto desde celular sigue funcionando vía Tailscale a los puertos del backend Node.

```
┌────────────── Electron Shell — Jarvis.exe (autostart on boot, system tray) ──────────────┐
│                                                                                           │
│  Main process (Node):                                                                     │
│    · System tray icon (verde idle / cyan activo / coral error)                            │
│    · Spawns y supervisa los dos child processes                                           │
│    · Maneja dos estados de UI: latente (oculta) y activa (radial wakeup)                  │
│    · Recibe eventos clap/wake del sidecar y dispara el wakeup                             │
│                                                                                           │
│  ┌── child: Backend Node :8788 ──┐   ┌── child: Sidecar Python :8789 ───────────────┐    │
│  │  Agent SDK + tools            │   │  XTTS + Whisper + audio_listener (clap+VAD)  │    │
│  └───────────────────────────────┘   └──────────────────────────────────────────────┘    │
│                                                                                           │
│  ┌── Renderer: Frontend (built `dist/` servido por Electron) ──────────────────────┐     │
│  │  R3F HoloScene global + xterm.js + shell PWA-compat                             │     │
│  └─────────────────────────────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                  Tailscale (acceso desde celular)
```

Decisiones clave:

1. **Cuatro componentes**: Electron shell + 3 processes (Backend Node, Sidecar Python, Renderer Frontend). Electron es el único entry point del usuario.
2. **Backend Node escucha en `0.0.0.0`** para que Tailscale exponga puertos. Firewall corta tráfico no-Tailscale.
3. **Frontend es PWA-compat** (manifest + service worker) para que funcione idéntico cuando se accede desde celular vía Tailscale, sin Electron.
4. **`API_BASE` no se hardcodea**. Resolver: `localStorage.jarvis.api.base ?? window.location.origin`. Cuando corre dentro de Electron, origin es `http://127.0.0.1:8788`; cuando corre desde celular, override apunta a la IP Tailscale del PC.
5. **Un solo `<Canvas>` R3F** persistente — H1: stages per modo, transiciones de cámara animadas.
6. **Agent SDK con sesión persistente** — no re-envía contexto cada turno. Cuando supera ~50k tokens, auto-resume con `summarize_context` tool.
7. **Always-on listening**: el sidecar Python tiene `audio_listener.py` siempre activo escuchando mic. Detecta doble aplauso (primario) o palabra "jarvis" (fallback). Al disparar, captura ventana de 6 s o hasta silencio (VAD), Whisper transcribe, Haiku clasifica intent, y solo si es `directed_at_jarvis` Electron muestra UI con animación radial wakeup.
8. Lo que **no cambia**: `Plan2DEditor`, `Plan3DViewer`, `SpaceViewer`, persistencia en `localStorage`. Endpoints `/api/jarvis/turn`, `/api/jarvis/device-action`, `/modules`, `/health` mantienen contrato externo.

## 3. Componentes

### 3.1 Backend (`backend/src/`)

| Módulo | Responsabilidad | Persistencia |
|---|---|---|
| `agent/JarvisAgent.js` | Wrapper Agent SDK; sesión persistente; `turn(message, ctx)` | — |
| `agent/modelRouter.js` | Heurística + escalation in-flight (ver §5.2) | — |
| `agent/tools/` | `deviceAction`, `houseState`, `networkScan`, `webSearch`, `saveRoutine`, `recallRoutine`, `summarizeContext`, `recordTokenUsage`, `escalate`, `saveMemory`, `recallUserProfile`, `classifyWakeIntent`, `dailyNoteSave`, `dailyNoteRecall`, `dailySummary`, `gcalListEvents`, `gcalCreateEvent`, `gcalUpdateEvent`, `gmailListRecent`, `gmailSummarizeInbox`, `gmailSearch`, `gmailSendDraft` | varía |
| `auth/google.js` | OAuth2 flow Google (Gmail + Calendar). Almacena refresh token cifrado en `backend/data/secrets/google.enc` con clave derivada de Windows Credential Manager. Renueva access token automático | filesystem cifrado |
| `docker/readonly.js` | Solo lectura: `docker ps --format json` cada 30s con cache. Alimenta tile de containers en System. **No hay tool de Docker para Jarvis** — manipulación queda en modo Lab | — |
| `agent/mcps.js` | Registra `claude-mem` como MCP hijo del agente | — |
| `agent/messages.es.json` | Plantillas TTS literales para límites/confirmaciones | — |
| `memory/store.js` | Lee/escribe `backend/data/jarvis-memory/` (formato Claude Code: `.md` + `MEMORY.md` índice) | filesystem |
| `meter/tokenMeter.js` | JSONL append-only `backend/data/tokens.jsonl`. Rotación a 7 MB. Cómputo de ventanas 5h y semanal | JSONL |
| `network/scanner.js` | `arp -a` + `mdns-scan` + RSSI desde `netsh wlan show interfaces` cada 30s. Cache RAM. Diff dispara `network_device_seen` SSE | — |
| `presence/sink.js` | `POST /api/jarvis/presence-event` para futuros ESP32/mmWave; broadcast SSE | — |
| `lab/session.js` | `node-pty` + `claude` CLI por conexión WS `/ws/claude-code`. Sesiones persistentes con `--resume` | `lab-sessions.json` |
| `host/telemetry.js` | CPU/mem nativo (`os.*`); GPU/red bajo demanda con timestamp del último valor | — |
| `routes.js` | Tabla limpia de rutas (reemplaza if/else actual) | — |

Entry `server.js` queda en ~30 líneas: middleware + montaje de rutas.

Estructura final:

```
backend/
  src/
    server.js
    routes.js
    agent/{JarvisAgent.js, modelRouter.js, mcps.js, messages.es.json, tools/}
    memory/store.js
    meter/tokenMeter.js
    network/scanner.js
    presence/sink.js
    lab/session.js
    host/telemetry.js
    docker/readonly.js
  data/                  (gitignored)
    jarvis-memory/       (auto-memoria)
    tokens.jsonl         (rotada por fecha al pasar 7 MB)
    lab-sessions.json
    voices/jarvis-reference.wav   (provisto por usuario)
    routines.json
    queued-turns.jsonl   (turnos parciales tras rate-limit)
```

### 3.2 Frontend (`frontend/src/`)

| Módulo | Responsabilidad |
|---|---|
| `holo/HoloSceneRoot.tsx` | Único `<Canvas>` global, persistente. `useCameraDirector` interpola entre stages |
| `holo/director.ts` | Springs de cámara, fade in/out de stages, audio-reactivo dispatcher |
| `holo/postFx.ts` | Bloom + chromatic aberration sutil, R3F-postprocessing |
| `holo/stages/CoreStage.tsx` | Núcleo audio-reactivo. Anillo modelo activo (esmeralda/ámbar/dorado) |
| `holo/stages/CasaStage.tsx` | Modelo 3D real desde plan 2D guardado. Cuartos hover-able. Click→`space` |
| `holo/stages/SystemStage.tsx` | Núcleo + anillos métrica (cada anillo encoda un campo) |
| `holo/stages/LabStage.tsx` | Stream partículas + flotante con sesión activa |
| `holo/stages/CloudStage.tsx` | Placeholder hasta definición |
| `modes/CoreView.tsx` | Refactor del core actual; consume `useJarvisTurn()` |
| `modes/HouseView.tsx` | + panel "Dispositivos en red" |
| `modes/SystemView.tsx` | **Reescritura** según mockup (§7) |
| `modes/LabView.tsx` | **Nuevo**: xterm.js + sidebar de sesiones |
| `state/jarvisStore.ts` | Zustand: mode, voiceEnabled, wakeListening, coreReply, focusedEntity, plans, entities, viewpoints |
| `state/systemStore.ts` | Zustand: tokens, modelStats, latencyStats, services, activeSkills, containers, routines |
| `state/networkStore.ts` | Zustand: discoveredDevices, roomAssignments, presenceByZone |
| `api/client.ts` | Resolver `API_BASE` + wrappers REST/SSE/WS |
| `voice/useTts.ts` | TTS streaming server con fallback `speechSynthesis` |
| `voice/useAsr.ts` | ASR server con fallback `webkitSpeechRecognition` |
| `voice/format.ts` | `formatSpoken(ms)` → "1 hora, 23 minutos, 45 segundos" |
| `pwa/manifest.webmanifest` + `pwa/sw.ts` | PWA mínimo |

`App.tsx` actual (1144 líneas) → ~80 líneas: shell + topbar + mode panel + montaje de vista activa. Componentes plan2d/plan3d/space mueven a archivos propios sin reescribir su lógica.

Se borra: `App.tsx` monolítico; `HoloScene.tsx` actual; constantes `API_BASE` y `SYSTEM_TELEMETRY_ENABLED`.

### 3.3 Sidecar Python (`voice-sidecar/`)

| Archivo | Responsabilidad |
|---|---|
| `app.py` | FastAPI :8789 |
| `tts.py` | XTTS v2 cargado al startup; `POST /tts/stream` recibe `{text, voice_ref}`, devuelve WAV chunked |
| `asr.py` | Whisper-cpp small cargado al startup; `POST /asr` recibe webm/wav, devuelve `{text, lang, confidence}` |
| `audio_listener.py` | **Always-on** thread con PyAudio. Detecta doble aplauso (FFT onset detection con `librosa`) y palabra "jarvis" (modelo Vosk pequeño en español, ~50 MB). Al detectar, captura ventana de 6 s o hasta VAD silence (1.2 s sin voz). POST `/api/jarvis/wake-event` al backend con `{trigger: 'clap' \| 'wake-word', audioBase64}` |
| `cues.py` | Genera tonos de feedback inline (ascending sweep / descending sweep) con `numpy` + `scipy.signal`, devuelve WAV. Endpoints `GET /cue/clap`, `GET /cue/reject` |
| `vad.py` | Helper de Voice Activity Detection (webrtcvad o silero-vad). Usado por `audio_listener.py` para cerrar ventana de captura |
| `requirements.txt` | `TTS>=0.22`, `whisper-cpp-python`, `fastapi`, `uvicorn`, `pyaudio`, `librosa`, `numpy`, `scipy`, `webrtcvad`, `vosk` |

Frontend nunca toca el sidecar directo — todo va por backend Node (`POST /api/voice/tts/stream`, `POST /api/voice/asr` que reenvían).

## 4. Flujos de datos

### 4.1 Turno de voz (end-to-end)

```
1. Wake word detectado (webkit en frontend)
2. mic → MediaRecorder webm → POST /api/voice/asr → Whisper local → texto
3. POST /api/jarvis/turn { sessionId, message, context: {mode, focusedEntity, plans} }
4. Backend → JarvisAgent.turn():
   a. modelRouter.pick() → 'haiku-4-5' default
   b. Agent SDK query() con sesión persistente
   c. Si Haiku llama tool `escalate(level)` → router relanza con modelo mayor + contexto
   d. Tools ejecutadas, resultados al agente
   e. tokenMeter.record({model, in, out, latency_ms, intent})
5. Reply → {reply, actions, uiHints}
6. Frontend → POST /api/voice/tts/stream → XTTS streaming chunks → playback on-the-fly
7. UI hints aplicados (highlight entidad, toast, etc.)
```

Latencia objetivo (fin de habla → primera palabra Jarvis):
- Simple ("apaga la luz") + Haiku: **1.2-1.8 s**
- Medio (consulta + tool): **2-3 s**
- Complejo (Sonnet + 2 tools): **3-5 s**

Optimizaciones:
- TTS streaming arranca con primera oración completa
- Sesión persistente Agent SDK ahorra ~30-60% tokens vs stateless
- ASR + LLM en paralelo cuando aplica (turnos texto-solo)

### 4.2 Holograma reactivo (CasaStage como ejemplo)

```
zustand stores (jarvis + network + presence)
   ↓ subscribe en CasaStage
useFrame loop:
  por cada room mesh → estado dispositivos asignados:
    conectado → emisión cian + leve pulse
    desconectado → gris opacity 0.4
    presence event activo → glow dorado pulsando
  hover room → outline + Html label
  click room → setMode('space') con planKey
```

Render no hace fetches. Stores se actualizan por:
- **SSE** `/api/jarvis/events` (presence, network changes, token updates ~1/s)
- **WS** solo para Lab (terminal) y audio levels (alta frecuencia)

### 4.3 Memoria

**Auto-memoria** (entre sesiones, formato Claude Code):
- `recall_user_profile()` lee `MEMORY.md` + archivos relevantes
- `save_memory(type, name, body)` escribe `.md` + actualiza índice

**claude-mem (MCP)**:
- `mem_search(query)` para búsqueda semántica
- Útil para *"¿cómo configuré el sensor del cuarto?"*, *"qué rutinas tengo"*

**Routines** (capacidad D, preferencias aprendidas):
- Detectado patrón o usuario explícito → `save_routine({trigger, actions, persistMemory: true})`
- Escribe `routines.json` + memory entry tipo `feedback`
- Cargados al startup como addendum del system prompt

### 4.4 Token metering

Cada turno → `tokenMeter.append(JSONL record)`.
Frontend `SystemView`: `GET /api/system/tokens?range=window5h,week`
→ backend agrega in-memory (recompute cada minuto)
→ devuelve `{window5h: {in, out, byModel, percent}, week: {...}, top3Costly, avgPerTurn, windowResetMs}`

## 5. Model router y límites

### 5.1 Router heurístico (sin LLM previo) y clasificador de wake intent

**Pre-pass: clasificación de wake intent** (solo cuando el turno viene de un evento de aplauso o wake-word, no cuando el usuario abre la UI y escribe directo):

```
classifyWakeIntent(transcript) → 'directed_at_jarvis' | 'ambient' | 'ambiguous'

Implementación: tool del agente que llama Haiku con prompt corto:
  "Clasifica este texto en español:
   - 'jarvis' si va dirigido a un asistente de voz (orden, pregunta, mención directa)
   - 'ambient' si es conversación de fondo, monólogo, susurro o claramente no dirigido
   - 'ambiguo' si no puedes decidir
   Texto: <transcript>
   Responde SOLO con la palabra clave."

Coste típico: ~50 tokens in / 1 token out / ~200 ms.
```

Comportamiento por resultado:

| Resultado | Acción del Electron main |
|---|---|
| `directed_at_jarvis` | TTS de bienvenida + dispara animación radial wakeup + envía transcript a `/api/jarvis/turn` |
| `ambient` | Reproduce cue de "rechazo" (descending sweep grave) + UI permanece latente |
| `ambiguous` | Reproduce cue de rechazo + escribe entry tipo `feedback` en auto-memoria con el transcript para análisis futuro |

**Router de modelos (turnos confirmados):**

```
modelRouter.pick(message, context):
  if message.length < 60 AND has device-action keywords    → 'haiku-4-5'
  if context.mode in ['plan2d','plan3d','space']           → 'haiku-4-5'
  if message contiene "piensa","razona","planea","ayúdame" → 'sonnet-4-6' + thinking
  if message contiene "investiga","busca a fondo","complejo" → 'opus-4-7'
  default                                                   → 'haiku-4-5'

  // Escalation in-flight
  Si modelo llama tool `escalate(level)` → relanza con modelo mayor, mismo input + contexto
```

Objetivo: ~70-80% turnos en Haiku.

### 5.2 Límites de uso

| Ventana | Default | 75% | 90% |
|---|---|---|---|
| **Rolling 5h** (start = primer turno tras ventana expirada) | 200k tokens | TTS aviso | **Modo restringido**: router fuerza Haiku. Sonnet/Opus → confirmación voz |
| **Semanal** (rolling 7d) | 5M tokens | TTS aviso | TTS aviso fuerte (no fuerza modo restringido) |

### 5.3 Mensajes TTS literales (en `agent/messages.es.json`)

```json
{
  "window5h_75": "Uso al 75%, próxima recarga en {timeSpoken}",
  "window5h_90": "Uso al 90%, estado crítico, se recomienda uso de sistema en ahorro, próxima recarga en {timeSpoken}",
  "week_75": "Uso semanal al 75%",
  "week_90": "Uso semanal al 90%, estado crítico",
  "heavyConfirm": "Modo ahorro activado, modelo solicitado {model}, ¿confirma uso?",
  "heavyWarning": "ADVERTENCIA, es posible que su respuesta quede incompleta, quedará en espera hasta la recarga en {timeSpoken}",
  "rechargeComplete": "Recarga completada, retomando tu solicitud"
}
```

`{timeSpoken}` formateado con `voice/format.ts` como *"1 hora, 23 minutos, 45 segundos"*.

### 5.4 Comportamiento ante rate-limit real

Si Agent SDK retorna error rate-limit mid-stream:
1. Persiste turno parcial en `queued-turns.jsonl` con: `{originalRequest, partialResponse, modelRequested, ts}`
2. Inicia timer al `windowStartTs + 5h`
3. Cuando reset llega, agente reintenta automático
4. Al completar, TTS `rechargeComplete` y reproduce respuesta final

### 5.5 State pendingConfirmation

Estado del agente: `pendingConfirmation: { intent, model, originalRequest } | null`.
- Set al disparar `heavyConfirm`
- Próximo turno con keyword `sí`/`confirma`/`adelante` → desbloquea, dispara `heavyWarning`, ejecuta
- Próximo turno con keyword `no`/`cancela`/`deja eso` → aborta, fallback a Haiku
- Otro turno cualquiera → mantiene pending; ejecuta el nuevo turno en Haiku

Se serializa en sesión, sobrevive restart del backend.

## 6. Voz clonada local + always-on listening

### 6.1 Stack

- **TTS**: XTTS v2 (Coqui). Multilingüe — clip de referencia en inglés sirve para sintetizar español. Streaming chunked. Primera palabra ~400 ms con GPU NVIDIA.
- **ASR**: Whisper.cpp `small`. Latencia ~300-500 ms para frase de 3-4 s.
- **Wake fallback (palabra "jarvis")**: Vosk small `vosk-model-small-es-0.42` (~50 MB), corre always-on en `audio_listener.py` con coste despreciable (<2% CPU).
- **Detector de doble aplauso**: `librosa` onset detection sobre stream PyAudio en `audio_listener.py`. Heurística: dos onsets con energía pico > umbral, separados 150-450 ms, con valle de "silencio relativo" entre ellos.
- **VAD (cierre de ventana)**: `webrtcvad` o `silero-vad`. Cierra captura cuando detecta 1.2 s sin voz.
- **Voz de referencia**: `backend/data/voices/jarvis-reference.wav` (6-10 s, sin música, sin ruido). Provista por usuario.

### 6.2 Triggers always-on

Dos triggers paralelos en `audio_listener.py`, ambos siempre escuchando:

1. **Doble aplauso** (primario)
2. **Palabra "jarvis"** (fallback — útil cuando tienes manos ocupadas o contexto donde no puedes aplaudir)

Cuando cualquiera dispara:
- Reproduce cue de "encendido" (sweep ascendente 600→900 Hz, 600 ms — sensación de boot)
- Captura audio durante max(6 s, hasta VAD silence detectado)
- POST `/api/jarvis/wake-event` al backend con `{trigger, audioBase64, ts}`
- Backend → Whisper transcribe → `classifyWakeIntent(transcript)`
- Si `directed_at_jarvis`:
  - Backend dispara IPC al Electron main → muestra ventana principal con animación radial wakeup
  - TTS de bienvenida via XTTS (frase corta default *"Aquí estoy"*, configurable)
  - Procesa el transcript como turno normal (`/api/jarvis/turn`)
- Si `ambient` o `ambiguous`:
  - Reproduce cue de "apagado" (sweep descendente 500→200 Hz, 400 ms)
  - UI permanece latente
  - Si `ambiguous`, escribe entry de feedback en auto-memoria

### 6.3 Audio cues — especificación técnica

Generados inline por `voice-sidecar/cues.py` (no archivos de disco) usando `numpy` + `scipy.signal`:

| Cue | Forma | Frecuencia | Duración | Envolvente |
|---|---|---|---|---|
| **Encendido (clap detected)** | sweep lineal | 600 → 900 Hz | 600 ms | attack 50 ms, sustain 450 ms, release 100 ms |
| **Bienvenida** (post-confirm) | TTS via XTTS | — | variable | — |
| **Apagado (rechazo)** | sweep lineal | 500 → 200 Hz | 400 ms | attack 30 ms, sustain 250 ms, release 120 ms |

Volumen default 0.4 (suave). Configurable en `System` panel.

### 6.4 Setup inicial

- venv en `voice-sidecar/.venv` (creado por electron-builder install hook)
- Modelos descargados al primer arranque: ~2 GB XTTS + ~500 MB Whisper small + ~50 MB Vosk wake-word
- Pre-warm al startup: cargar XTTS y Whisper a VRAM. Cold start 3-5 s una vez; inferencias subsecuentes rápidas.
- `audio_listener.py` arranca después de pre-warm (no necesita GPU; corre en CPU thread separado).

### 6.5 Fallback

Si sidecar caído (health check falla):
- TTS → `speechSynthesis` browser (solo si UI activa)
- ASR → `webkitSpeechRecognition` (solo si UI activa)
- **Sin sidecar no hay always-on listening** — usuario debe abrir UI desde tray manualmente
- Banner sutil topbar: *"voz local offline — abre Jarvis manualmente para hablar"*
- Electron tray icon vira a coral
- App sigue funcional para texto + UI

## 7. Sistema visual

### 7.1 Paleta

Mantiene cian holográfico actual; agrega cuatro acentos con **rol funcional fijo**:

| Token | Hex | Rol |
|---|---|---|
| Fondo base | `#02060c` | sin cambio |
| Cian primario | `#7de9ff` | bordes, texto secundario |
| Cian luminoso | `#9af7ff` | activos, hover |
| Cian profundo | `#2ec5ff` | shadows, lights 3D |
| **Esmeralda** | `#5cffd4` | salud OK, modelo Haiku |
| **Ámbar** | `#ffb547` | warnings 75%, modelo Sonnet |
| **Dorado** | `#ffd166` | presence detected, modelo Opus |
| **Coral** | `#ff6b8a` | críticos 90%, errores |
| Texto cuerpo | `#eaf9ff` | sin cambio |
| Texto secundario | `#95afbf` | sin cambio |

### 7.2 Tipografía

- **Body / UI**: Inter (sin cambio)
- **Display** (titles, eyebrows, métricas grandes): **Rajdhani 600/700**
- **Mono** (Lab terminal, IDs, valores): **JetBrains Mono**

Carga: Google Fonts o local en `frontend/public/fonts/`.

### 7.3 Sistema de espaciado y geometría

- Grid base 4 px. Múltiplos: 4 / 8 / 12 / 16 / 24 / 32 / 48
- `border-radius`: chips/inputs 12px, botones 14px, panels 20px, modals 24px
- Bordes principales: gradient borders con `mask-composite: exclude`
- Shadows: dos capas (sombra negra exterior + glow cian interior, ya presentes)

### 7.4 Componentes

| Componente | Notas |
|---|---|
| `<HoloPanel>` | Reemplazo de `.hologram-panel`. Gradient border, header eyebrow + acción right, scroll holográfico, estado loading con scanline |
| `<Tile size="sm\|md\|lg">` | System: métrica grande Rajdhani 700 + label eyebrow + sparkline opcional. Hover elevación + glow. Click expande inline a drawer |
| `<Drawer side="right\|bottom">` | Slide+fade 240ms cubic-bezier(.22,1,.36,1). Overlay borroso, holograma sigue visible |
| `<ModelBadge model>` | Pill con punto + texto, color del acento. Junto a respuestas Jarvis |
| `<StatusDot kind>` | 8px, pulse en busy. Esmeralda/ámbar/coral/cian-pulse |

### 7.5 Iconografía

Set: **Lucide**. Tamaños 16/20/24 px. Iconos en mode-buttons (Core: pulso, Casa: home, Cloud: cloud, Lab: terminal, System: gauge). Tiles System: cpu, gpu, network, key, bot, boxes, brain, wifi.

### 7.6 Animaciones — lenguaje

| Evento | Animación |
|---|---|
| Cambio modo | Cámara R3F lerp 800ms spring; topbar h1 cross-fade 300ms |
| Hover mesh 3D | Outline pass + scale 1.02 |
| Click tile | Glow pulse 200ms + drawer slide |
| Audio-reactivo Core | Mesh scale + emisión modulados por amplitud RMS, smoothing exp 0.15 |
| Token threshold cruzado | Anillo color transición 600ms; pulse breathing en panel |
| Network device nuevo | Toast + flash dorado 1s en CasaStage |
| Loading reply | Núcleo Core scanline + ring rotation acelerado |
| Modo restringido | Núcleo Core teñido coral; anillo modelo bloquea Sonnet/Opus visualmente |
| **Wakeup radial (post-confirm intent)** | Ventana principal aparece con `clip-path: circle(0% at 50% 50%)` → `circle(150% at 50% 50%)` en 700 ms con `cubic-bezier(0.16, 1, 0.3, 1)`. Holograma Core ya respondiendo al audio del usuario antes de que la animación termine. Topbar y mode-panel hacen fade-in escalonado a los 200 ms y 400 ms |
| **Goodbye (UI vuelve a latente)** | Animación inversa de wakeup, 500 ms; tray icon vira a verde idle |

`useFrame` para 3D, CSS keyframes / Framer Motion para 2D. Framer Motion solo en transiciones complejas.

### 7.7 Mobile (PWA)

- ≥ 1024 px: layout actual
- < 1024 px: mode-panel → bottom tab bar (5 iconos). info-panel → bottom-sheet (swipe up)
- < 768 px: holograma full-screen al fondo, controles flotantes
- Lab mobile: terminal full-screen + barra superior sticky con `Tab`/`Esc`/`Ctrl`/flechas

### 7.8 Mockup `System` (texto)

```
┌─ JARVIS DESKTOP / SYSTEM ──────────────── 14:32 BOGOTÁ ─┐
│ Visual del Sistema                                       │
│ Telemetría, consumo y servicios                          │
│                                                          │
│ ┌──TOKENS────────────┐ ┌──MODELOS──────────────────────┐│
│ │ 5h window          │ │ ● Haiku    187 turnos  142k ✓ ││
│ │ 47k / 200k     24% │ │ ● Sonnet    12 turnos   38k ⚠ ││
│ │ ▁▁▂▃▅▇          ⚠ │ │ ● Opus       3 turnos   18k ⨯ ││
│ │                    │ │  Activo: Haiku — p50 480ms     ││
│ │ Semanal            │ │                                ││
│ │ 1.2M / 5M    24%   │ └────────────────────────────────┘│
│ └────────────────────┘                                   │
│                                                          │
│ ┌──CONTAINERS DOCKER──┐ ┌──MEMORIA──┐ ┌──RUTINAS──────┐ │
│ │ ● nginx-jarvis :80  │ │ 14 entries│ │ modo-cine     │ │
│ │ ● postgres   :5432  │ │ último    │ │ modo-dormir   │ │
│ │ +nuevo container... │ │ 2 min     │ │ +nueva rutina │ │
│ └─────────────────────┘ └───────────┘ └───────────────┘ │
│                                                          │
│ ┌──HOST [actualizar GPU/red]──────────────────────────┐ │
│ │ CPU 23%  Mem 41% [GPU pendiente] [Red pendiente]    │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ▼ Skills/MCPs cargadas (4)    ▼ Historial dispositivos  │
│ ▼ Conversaciones recientes    ▼ Servicios backend       │
│                                                          │
│ ●●●●● claude-mem · agent · meter · network · presence   │
└──────────────────────────────────────────────────────────┘
```

## 8. HoloScene unificado (H1)

Un único `<Canvas>` global persistente. Stages en coordenadas distintas del mundo 3D. Cámara hace transiciones animadas entre ellas con springs. Datos vivos React → meshes reaccionan.

| Modo | Holograma |
|---|---|
| **Core** | Núcleo audio-reactivo: respira en idle, pulsa con volumen mic al escuchar, ondula con TTS al hablar. Anillo exterior color = modelo activo (esmeralda Haiku / ámbar Sonnet / dorado Opus) |
| **Casa** | Modelo 3D real construido desde plan 2D guardado. Hover habitación → glow + label. Click → modo `space`. Dispositivos asignados parpadean cian si conectados, gris si no, dorado si presence |
| **System** | Núcleo central + anillos métrica. Cada anillo encoda tokens / latencia / memoria / containers. Velocidad/grosor/color = valor. Hover anillo ↔ tile correspondiente. Click anillo → drawer abre |
| **Lab** | Stream partículas verticales tipo "matrix elegante" — cada partícula es un mensaje de la sesión activa. Flotante con modelo en uso, tokens sesión, tools/MCPs activos |
| **Cloud** | Placeholder hasta definición usuario |

`useFrame` selectivo: solo el stage visible se anima; los demás congelados pero montados (estado preservado).

## 9. Capacidades de Jarvis

Capacidades aprobadas (A, B, C, D, F, H):

| Letra | Capacidad | Implementación |
|---|---|---|
| **A** | Control de dispositivos por intent | tool `device_action` → `POST /api/jarvis/device-action` (existente) |
| **B** | Rutinas compuestas (modo cine, etc.) | tool `save_routine` + `recall_routine` + persistencia `routines.json` + system prompt addendum |
| **C** | Consultas sobre la casa | tool `house_state` lee plans/entities/viewpoint del backend (frontend sincroniza vía `POST /api/jarvis/sync-state` al cambiar localStorage) |
| **D** | Memoria de preferencias aprendidas | claude-mem MCP + auto-memoria; tool `save_memory` |
| **F** | Búsqueda web | tool `web_search` (Agent SDK built-in) |
| **H** | Reportes proactivos por TTS | event-driven: `network_device_seen`, `presence_event`, threshold tokens, container down → cola interna emite TTS sin esperar input |

Fuera de scope v1: E (razonamiento espacial complejo), G (modificar 3D por voz), Nivel 2 CSI (hooks listos), Nivel 3 DensePose.

## 10. Lab — Claude Code embebido

### 10.1 Decisión arquitectónica

En lugar de dar a Jarvis tools de Docker / file-write / dev-server, embebemos Claude Code real dentro de la app como modo `Lab`. Cero duplicación; cuando salgan nuevos modelos o skills en Claude Code, ya están disponibles sin tocar Jarvis.

### 10.2 Implementación

- **Backend**: `/ws/claude-code` WS endpoint. Cada conexión spawn `claude` en pseudo-terminal con `node-pty`. Soporta resize. Pipea stdin/stdout/stderr.
- **Frontend**: `LabView.tsx` con `xterm.js` themed (fondo `#02060c`, fg `#eaf9ff`, accent cian, JetBrains Mono). Conecta WS al backend.
- **Sesiones**: persistentes vía `--resume <id>`. Sidebar muestra sesiones recientes (`backend/data/lab-sessions.json` con `{id, title, lastUsed}`). Botón "Nueva sesión" o click en una existente.
- **Auth**: el binario `claude` ya está autenticado en la máquina del usuario (suscripción Claude Code).
- **No funciona desde celular vía Tailscale automáticamente** — `node-pty` requiere que `claude` esté instalado en el host. PC sigue siendo cerebro; celular renderiza terminal.

### 10.3 Cloud

Mode `Cloud` se mantiene en navegación pero sin función nueva en v1. Usuario definirá uso futuro.

## 11. Network discovery + presence hooks

### 11.1 Nivel 0 — descubrimiento

`network/scanner.js` cada 30s:
1. `arp -a` → MAC + IP de dispositivos en red local
2. `mdns-scan` (libreria `bonjour-service` o similar) → hostname amigable + servicio
3. `netsh wlan show interfaces` → RSSI del PC al AP (hint relativo)
4. Cache RAM con TTL 60s
5. Diff vs scan anterior → SSE event `network_device_seen` (nuevo dispositivo) o `network_device_lost`

Frontend Casa: panel "Dispositivos en red" (drawer). UI de asignación: drag MAC a habitación del plan3d, persistente en `localStorage.jarvis.network.assignments.v1`.

Una vez asignado: marcador 3D del dispositivo en CasaStage parpadea cian si conectado, gris si no.

### 11.2 Nivel 1-light — RSSI hint

Sin sensores múltiples no podemos triangular. Lo que sí: el RSSI del PC al AP combinado con la asignación manual de dispositivos a habitaciones cubre el caso útil.

### 11.3 Nivel 2 — hooks listos para futuro

- Endpoint `POST /api/jarvis/presence-event` recibe `{source, zone, kind: 'motion'|'presence', value, ts}`
- Campo nuevo en `SceneEntity`: `presenceSource?: string` (ej: `'csi-zone-1'`, `'mmwave-bedroom'`)
- Cuando llega evento, broadcast SSE → CasaStage glow dorado en marcadores asociados a esa zona
- Cuando usuario tenga ESP32 o mmWave, conecta al endpoint y ya funciona — sin tocar Jarvis

Niveles 3 (DensePose) y mayores: fuera de scope v1.

## 12. Resiliencia y errores

### 12.1 Modos de falla — respuestas

| Falla | Respuesta |
|---|---|
| Rate-limit mid-turn | Persiste turno parcial → retry post-recarga + TTS `rechargeComplete` |
| Sidecar Python down | Fallback a `speechSynthesis`/`webkitSpeechRecognition` + banner topbar |
| Backend Node muere | Frontend SSE reconnect exponential backoff; modo degradado solo localStorage |
| Tailscale offline | Banner "reconectando con tu PC..." + reintento; LAN sigue |
| Lab WS desconectado | Auto-resume con `--resume` |
| Tool fallida | Tool retorna `{ok:false, error}` → agent decide siguiente paso |
| localStorage corrupto | Backup en `localStorage.jarvis.*.backup` antes de cada write; restaura último válido |
| MEMORY.md corrupto | Backup en `backend/data/jarvis-memory/.backups/MEMORY-{ts}.md`; rollback |
| Disk full | Rotación tokens.jsonl a 7 MB; logs purgados a 30 días |
| Wake-word destructivo | Keywords peligrosos (`borra`, `elimina`, `apaga todo`) siempre confirman por TTS |
| Reply vacío/inválido | Reintento 1x; luego escalation con contexto extra; tras 2 fallos TTS *"no pude procesar"* |
| TTS cortado | Frontend cancela playback si gap > 2s; muestra reply en pantalla; botón "reproducir de nuevo" |
| ASR vacío | Sin enviar turno; toast "no escuché"; mic apagado para evitar loops |
| Container Docker no existe (Lab no aplica; aquí solo lectura para tile) | Tile muestra error inline |
| Network scan falla | Cache último valor; banner "escaneo de red pausado" |
| GPU host telemetry timeout | Campo `unavailable`; sin reintento hasta refresh manual |
| claude-mem MCP no responde | Falla blanda; agent procede sin esa info; no bloquea |

### 12.2 Patrones transversales

**Tool signature uniforme:** `async tool(args, ctx) → {ok: true, result} | {ok: false, error: string, retry?: boolean}`. Sin throws sueltos.

**Logs estructurados:** cada turno emite JSON con `business_event`: `{event, sessionId, ts, model, latency_ms, tokens, intent, error?}`.

**Health endpoint expandido:**
```json
{
  "status": "ok",
  "services": { "agent": "ok", "voice_sidecar": "ok|degraded|down", "claude_mem": "ok|down", "memory_store": "ok", "network_scanner": "ok", "token_meter": "ok" },
  "uptime_s": 12345,
  "version": "0.2.0"
}
```
Status bar en `System` consume cada 10s.

**Confirmaciones por voz:** comandos destructivos + escalation modelo en restringido + `docker_*` con stop/rm. Estado `pendingConfirmation` se serializa.

**Cancelación:** botón ☓ flotante en Core durante TTS/turno → AbortController + cancel TTS + TTS *"cancelado"*. Wake-word "Jarvis cancela"/"Jarvis para" → mismo efecto.

**Recovery startup:**
1. Cargar `routines.json` (restore backup si corrupto)
2. Cargar `MEMORY.md` (restore backup si corrupto)
3. Procesar `queued-turns.jsonl` si reset 5h ya pasó
4. Health check sidecar Python (espera 8s; si muerto, marca degraded)
5. claude-mem MCP probe
6. Emit SSE `system_ready` → frontend quita splash

## 13. Plan de implementación por fases

| # | Fase | Deps | Complejidad | Riesgos |
|---|---|---|---|---|
| **0** | Refactor base (invisible): partir App.tsx, routes.js backend, api/client.ts, Zustand stores, gitignore | — | M | bajo |
| **1** | Agent SDK + memoria + tools mínimas (device_action, house_state, save/recall_routine, summarize_context); claude-mem MCP; auto-memoria; health expandido | 0 | L | auth Agent SDK con suscripción; MCP claude-mem en proceso hijo |
| **2** | Voz local sidecar Python (XTTS + Whisper); endpoints backend; useTts/useAsr con fallback; mensajes TTS de límites; carga de `jarvis-reference.wav` | 0 | L | calidad XTTS depende del clip; cold start; venv CUDA |
| **3** | HoloScene unificado: HoloSceneRoot, stages Core/Casa/System/Lab/Cloud, director cámara, post-fx, paleta + Rajdhani + gradient borders + scrollbar | 0 | L | performance multi-stage — useFrame solo stage visible |
| **4** | System reformado: tiles + drawers según mockup; SystemStage anillos; host telemetry on-demand; status bar; ventanas 5h/semanal con thresholds y modo restringido + confirmación voz; queued-turns recovery | 1, 3 | M | que cálculo ventana 5h coincida con suscripción real |
| **5** | Lab — Claude Code embebido: lab/session.js node-pty; WS `/ws/claude-code`; LabView xterm.js themed; sidebar sesiones | 0 | M | node-pty Windows ConPTY; resize handling |
| **6** | Network discovery + presence hooks: scanner; UI asignación dispositivo→habitación; SSE `/api/jarvis/events`; endpoint `/presence-event`; CasaStage marcadores reactivos | 0, 3 | M | permisos `arp -a` Windows; mDNS lib |
| **7** | Mobile & Tailscale: PWA manifest+SW; layouts responsive; README setup Tailscale; verificar voz por Tailscale | 1, 3, 4 | M | webkit speech iOS pide permisos; testar real |
| **8** | Pulido + Docker tile + a11y: tile containers `docker ps` cada 30s read-only; animaciones finas; focus rings, aria-labels; QA mobile/desktop | 4 | S | bajo |
| **9** | **Empaque .exe (Electron + NSIS)**: Electron shell con main process; spawn supervisado de backend Node y sidecar Python; system tray con tres estados (idle/active/error); manejo de dos estados UI (latente/activa) con animación radial wakeup; IPC eventos clap/wake; autostart on boot opt-in; instalador NSIS via electron-builder; firma de código si está disponible | 1, 2, 3 | XL | electron-builder con Python sidecar; codesigning Windows; PyInstaller para empaquetar voice-sidecar; tamaño bundle ~150 MB |
| **10** | **Integraciones Google + Daily notes**: OAuth Google (Gmail + Calendar) con token cifrado vía Windows Credential Manager; tools `gcal*` y `gmail*`; daily notes en `backend/data/daily/{YYYY-MM-DD}.md` con tools `dailyNoteSave/Recall/Summary`; primer setup vía pantalla `System → Conexiones`; refresh token automático | 1 | L | OAuth flow complicado en desktop app (loopback redirect); rate limits Google |

### Orden recomendado

1. **Fase 0** (blocker)
2. **Fase 1** + **Fase 3** (paralelo o secuencial según capacidad)
3. **Fase 2** (cuando llegue clip referencia)
4. **Fase 4**
5. **Fases 5-8** en cualquier orden
6. **Fase 9** (empaque) — antes de Fase 10 porque la animación radial wakeup vive en Electron
7. **Fase 10** (integraciones Google) — independiente; puede hacerse después de Fase 1 sin esperar Fase 9

### Smallest Shippable v1

Fases 0+1+3+4 → "Jarvis Beta": Claude real (texto + voz fallback browser), HoloScene unificado, System reformado. ~60% del valor con ~50% del trabajo. Resto se suma incremental.

### Fuera de scope v1 (definidos)

- Cloud rework (pendiente definición usuario)
- Nivel 2 ESP32 CSI (cuando llegue hardware: mini-fase nueva)
- DensePose / pose estimation
- Editor 3D voice-driven (capacidad G)
- Razonamiento espacial complejo (capacidad E)

## 14. Configuración y secretos

- **Clip de voz Jarvis**: usuario coloca en `backend/data/voices/jarvis-reference.wav`. Gitignored. No sale del PC.
- **Suscripción Claude Code**: `claude` CLI ya autenticado en host. Backend invoca SDK que hereda credenciales.
- **Tailscale**: instalación en PC + celular. IP `100.x.x.x` se resuelve por mDNS. Frontend detecta vía `window.location.origin`.
- **Límites tokens**: editables desde panel "Límites de uso" en `System`. Defaults: 5h=200k, semanal=5M.
- **Wake phrase**: editable en `Core` panel. Default `jarvis`.

## 15. Empaque y distribución

### 16.1 Stack

- **Electron** (último estable). Main process Node, renderer carga `frontend/dist/index.html`.
- **electron-builder** para empaquetar a NSIS installer.
- **Python sidecar empaquetado con PyInstaller** (`voice-sidecar/.dist/jarvis-voice-sidecar.exe`) e incluido como `extraResources` en el bundle Electron. Evita requerir Python instalado en el PC del usuario.
- **Node modules del backend** se copian al bundle como `extraResources` también (no se rebundlean — el backend ejecuta como child process Node usando el Node embebido en Electron).

### 16.2 Estructura del proyecto

```
jarvis-desktop/
  electron/
    main.js                  # Electron main process
    preload.js               # Bridge IPC seguro
    tray.js                  # System tray manager
    states.js                # Latente vs activa
    spawnBackend.js          # Supervisión backend Node
    spawnSidecar.js          # Supervisión voice sidecar
    ipc-handlers.js          # Eventos clap/wake → main → renderer
  build/                     # electron-builder config (icons, NSIS scripts)
  package.json               # Root — el comando "build" empaqueta todo
  backend/                   # ya existente
  frontend/                  # ya existente
  voice-sidecar/             # ya existente
```

### 16.3 Estados de UI

| Estado | Visibilidad ventana | Tray icon | Procesos | Disparadores que cambian estado |
|---|---|---|---|---|
| **Latente** | oculta (`win.hide()`) | verde `idle` | backend + sidecar + audio_listener corriendo | clap/wake confirmado → activa; click manual en tray → activa |
| **Activa** | visible con animación radial | cyan `active` | igual | comando "duerme" via TTS → latente; click "minimizar a bandeja" → latente; cierre desde tray "Salir" → exit |
| **Error** | indistinto | coral `error` | sidecar caído o backend caído | health check restaura → vuelve al estado anterior |

### 16.4 Autostart on boot

Opción en pantalla final del instalador NSIS: *"Iniciar Jarvis al arrancar Windows"*. Si checked:
- Crea entry en `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` apuntando a `Jarvis.exe --hidden`
- App arranca minimizada en tray (estado **latente**)
- Sin checkbox: usuario lanza manualmente desde inicio o shortcut

Configurable post-install desde `System → Configuración → Autostart`.

### 16.5 Instalador NSIS — flujo

1. Bienvenida + selección de carpeta (default `Program Files\Jarvis`)
2. Opcional: shortcut en escritorio + entrada menú inicio
3. Opcional: autostart on boot
4. Instalación: copia `jarvis.exe`, `voice-sidecar/`, `backend/`, modelos pre-descargados (si caben en bundle)
5. Pantalla final: *"¿Lanzar Jarvis ahora?"*

Tamaño estimado bundle: **~150 MB** (Electron 90 MB + frontend dist 5 MB + voice-sidecar exe 30 MB + backend 5 MB + iconos/scripts 5 MB) **+ modelos descargados al primer arranque** (~2.5 GB en `%APPDATA%\Jarvis\models\`).

### 16.6 Codesigning

Opcional para v1. Sin firma, Windows muestra SmartScreen warning la primera vez. Si el usuario consigue certificado EV o sponsoring, se agrega a `electron-builder.yml` con `signtool`.

---

## 16. Integraciones — Google + Daily notes

### 17.1 OAuth Google (Gmail + Calendar)

**Flujo desktop**:
1. Usuario va a `System → Conexiones → Google → Conectar`
2. Electron abre browser default con URL OAuth + scope `gmail.readonly gmail.send calendar`
3. Server local efímero `http://127.0.0.1:38347` recibe el callback con el code
4. Backend intercambia code por refresh + access tokens
5. Refresh token cifrado con DPAPI Windows (Credential Manager-backed) y guardado en `backend/data/secrets/google.enc`
6. UI confirma "Conectado como tu@email.com"

Renovación: backend renueva access token en silencio cuando `expires_at - now < 5 min`.

Revocación: botón *"Desconectar Google"* en `System → Conexiones`. Borra `google.enc` y revoca el refresh token via API.

### 17.2 Tools de Google

| Tool | Argumentos | Comportamiento |
|---|---|---|
| `gcalListEvents` | `{from, to}` ISO timestamps | Devuelve eventos del calendario primario en ese rango. Incluye link, location, attendees |
| `gcalCreateEvent` | `{summary, start, end, description?, location?, attendees?}` | Crea evento; pide confirmación por TTS si `attendees.length > 0` |
| `gcalUpdateEvent` | `{eventId, patch}` | Actualiza campos. Confirmación TTS si afecta atendees |
| `gmailListRecent` | `{count: 10}` | Últimos N emails inbox: `{from, subject, snippet, ts, unread}` |
| `gmailSummarizeInbox` | `{count: 20}` | Llama Sonnet para resumir últimos N emails en bullets |
| `gmailSearch` | `{query}` | Sintaxis Gmail (`from:x is:unread`) |
| `gmailSendDraft` | `{to, subject, body}` | **Crea borrador** y lo deja en Drafts. Nunca envía sin confirmación TTS *"borrador listo, ¿lo envío?"* + segundo turno |

### 17.3 Daily notes

Almacenamiento simple, local, privado:

```
backend/data/daily/
  2026-04-30.md
  2026-05-01.md
  ...
```

Estructura por archivo (YAML frontmatter + cuerpo libre Markdown):

```markdown
---
date: 2026-04-30
created: 2026-04-30T08:14:23Z
updated: 2026-04-30T22:01:11Z
tags: [trabajo, casa, salud]
---

## Mañana

- Revisar PR #234 — pendiente de QA de Carlos
- Llamar al pediatra — recordatorio 15:00

## Tarde

Sentí dolor de cabeza fuerte hacia las 4. Tomé ibuprofeno.

## Notas sueltas

> "La luz al fondo del pasillo se quema cada 2 meses, revisar voltaje"
```

Tools:

| Tool | Argumentos | Comportamiento |
|---|---|---|
| `dailyNoteSave` | `{content, date?, section?}` | Append a la sección o al final. Si `date` ausente, usa hoy. Crea archivo si no existe con frontmatter |
| `dailyNoteRecall` | `{date}` ISO | Devuelve contenido completo del día |
| `dailySummary` | `{from, to}` | Llama Sonnet con todos los archivos del rango → bullets de patrones, recordatorios, eventos importantes |

Comandos de voz típicos:
- *"Jarvis, anota que el pediatra dijo que volvamos en dos semanas"* → `dailyNoteSave` en sección Notas
- *"Jarvis, ¿qué hice ayer?"* → `dailyNoteRecall` + Haiku resumen
- *"Jarvis, resumen de la semana"* → `dailySummary` + Sonnet

### 17.4 Privacidad

- **Tokens Google**: cifrados con DPAPI Windows. Se descifran solo en proceso backend, en memoria.
- **Daily notes**: archivos planos en disco local. Gitignored. **Nunca se suben a la nube** — solo viven en el PC del usuario. Si quieres backup, es manual (copia carpeta).
- **Audio del wake**: el clip de 6 s capturado por aplauso/wake no se persiste — se procesa por Whisper, se descarta inmediatamente. Solo el `transcript` puede llegar a auto-memoria si entró clasificación `ambiguous`.

---

## 17. Referencias

- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk`
- Modelos: Opus 4.7 `claude-opus-4-7`, Sonnet 4.6 `claude-sonnet-4-6`, Haiku 4.5 `claude-haiku-4-5-20251001`
- node-pty para PTY en Windows (ConPTY)
- xterm.js + xterm-addon-fit + xterm-addon-web-links
- Coqui TTS XTTS v2; whisper-cpp-python
- Vosk small ES `vosk-model-small-es-0.42` (wake word fallback)
- librosa, webrtcvad, silero-vad (audio listener + VAD)
- bonjour-service (mDNS)
- Tailscale (zero-config VPN)
- Electron + electron-builder + NSIS (empaque desktop)
- PyInstaller (empaque sidecar Python)
- Google APIs: Gmail v1, Calendar v3 (vía `googleapis` Node SDK)
- Lucide icons; Rajdhani / JetBrains Mono fonts
