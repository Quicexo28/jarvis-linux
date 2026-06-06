# Spec — Integración Jarvis ↔ Obsidian

Persistencia bidireccional de información segmentada por **speaker ID** + categorías globales del sistema. Markdown en disco como fuente de verdad; Obsidian como capa de visualización y plugins; opcionalmente, Local REST API para lectura por Jarvis.

---

## Decisiones (definidas con el usuario)

| Tema | Decisión |
|---|---|
| Instalación | No tiene Obsidian instalado — documentar descarga + bóveda dedicada nueva |
| Qué guardar | Notas, acciones de dispositivos, histórico de conversación, tareas, **datos de personalización** |
| Dirección | Escritura + lectura (consultas tipo "¿qué tareas tengo?") |
| Speaker ID | Nombre amigable enrollado por usuario (no UUID) |

---

## Setup inicial (steps de instalación)

1. **Descargar Obsidian**: https://obsidian.md/ (gratis, desktop).
2. **Crear bóveda dedicada**: `C:\Users\<user>\Documents\Jarvis-Vault\` (NO dentro del repo).
3. **Configurar Jarvis** con env var:
   ```
   JARVIS_OBSIDIAN_VAULT=C:\Users\<user>\Documents\Jarvis-Vault
   ```
4. **Plugin Local REST API** (community) — para lectura desde Node:
   - Settings → Community plugins → Browse → "Local REST API" (by Adam Coddington).
   - Activar y copiar API key. Puerto default: 27123 (localhost).
   - Env var: `JARVIS_OBSIDIAN_API_KEY=...`
5. (Opcional) **Plugin Templater** para frontmatter consistente.

---

## Estructura del vault

```
Jarvis-Vault/
├── Speakers/
│   ├── Santiago/                       ← nombre amigable del enrolamiento
│   │   ├── _index.md                   ← perfil del speaker (preferencias, contacto)
│   │   ├── Personalization.md          ← datos persistentes: voz preferida, idioma, gustos
│   │   ├── Tasks/
│   │   │   ├── _active.md              ← tareas abiertas (lista viva)
│   │   │   └── 2026-05-15.md           ← tareas creadas hoy (immutable log)
│   │   ├── History/
│   │   │   └── 2026-05-15.md           ← daily note de conversaciones
│   │   └── Notes/
│   │       └── 2026-05-15-1542-<slug>.md  ← nota espontánea
│   └── <otro-speaker>/...
├── System/
│   ├── Actions/
│   │   └── 2026-05-15.md               ← log de device-actions del día
│   └── Daily/
│       └── 2026-05-15.md               ← rollup del día (todos los speakers)
└── _Templates/
    ├── task.md
    ├── note.md
    └── history-entry.md
```

### Formato de archivos (frontmatter YAML)

**Tasks/2026-05-15.md**:
```markdown
---
type: task
speaker: Santiago
created: 2026-05-15T16:42:33-05:00
status: open                       # open | done | cancelled
source: voice                      # voice | text | system
mode: home                         # contexto activo al crear
---

# Tarea
Recordarme llamar al banco mañana.

## Contexto
> "Jarvis, recuérdame llamar al banco mañana."
```

**Notes/2026-05-15-1542-idea-jardin.md**:
```markdown
---
type: note
speaker: Santiago
created: 2026-05-15T15:42:00-05:00
tags: [idea, casa]
---

# Idea para el jardín
Plantar romero en la esquina sur.
```

**System/Actions/2026-05-15.md** (append-only):
```markdown
# Acciones del día — 2026-05-15

- **16:30** · Santiago · Luz Sala · `off`
- **16:42** · Santiago · Aire Hab1 · `temp:22`
```

**Personalization.md** (siempre se reescribe completo):
```markdown
---
type: personalization
speaker: Santiago
updated: 2026-05-15T16:00:00-05:00
---

## Voz
- Idioma: es-CO
- Tono preferido: formal-cercano
- Velocidad: 1.0

## Preferencias
- Música favorita: jazz, bossa nova
- Apagar luces automáticamente a las 23:00

## Hechos
- Cumpleaños: 12 de marzo
- Trabaja en proyecto: coach-ai-engineer-boilerplate
```

---

## Arquitectura técnica

### Stack híbrido (escritura disco + lectura REST)

| Operación | Mecanismo | Razón |
|---|---|---|
| Escritura | `fs.writeFile` directo al path del vault | Funciona con Obsidian cerrado, sin dependencias |
| Lectura simple (un archivo conocido) | `fs.readFile` | Mismo argumento |
| Búsqueda full-text / dataview / queries | Local REST API plugin (localhost:27123) | Aprovecha el indexado de Obsidian |
| Live updates en UI Obsidian | File system watcher de Obsidian | Automático |

### Módulo Node nuevo: `backend/src/lib/obsidian.js`

```js
// API pública
export function getVaultPath()              // resuelve JARVIS_OBSIDIAN_VAULT
export function isConfigured()               // false si no hay vault o no existe

export async function writeTask(speakerName, { text, source, mode })
export async function writeNote(speakerName, { title, body, tags })
export async function appendDeviceAction({ speakerName, deviceLabel, action })
export async function appendHistoryEntry(speakerName, { userText, assistantReply })
export async function updatePersonalization(speakerName, patch)

export async function listOpenTasks(speakerName)
export async function searchNotes(speakerName, query)      // via REST API
export async function getPersonalization(speakerName)
```

Detalles:
- Slugify de títulos y nombres de speaker para paths seguros.
- Append-only para Tasks/<fecha>.md y Actions/<fecha>.md (multi-escritura segura).
- Atomic writes: `fs.writeFile` a `.tmp` y `fs.rename`.
- Skip silently si `isConfigured() === false` (Jarvis funciona sin Obsidian).

### Handlers Node nuevos: `backend/src/handlers/obsidian.js`

```
GET  /api/obsidian/status                  → { configured, vaultPath, restApiReachable }
GET  /api/obsidian/speaker/:name/tasks     → tareas abiertas
GET  /api/obsidian/speaker/:name/personalization
POST /api/obsidian/speaker/:name/personalization
```

(La mayoría de las escrituras ocurren automáticamente en `process-speech` y `device-action`; estos endpoints son para el frontend.)

### Integración con el speech pipeline existente

Modificar `backend/src/handlers/speech.js`:

```js
import { writeTask, writeNote, appendHistoryEntry } from '../lib/obsidian.js'

// Después de classifyIntent...
if (classification.intentTag === 'task_create')  await writeTask(speakerName, { text, source: 'voice', mode })
if (classification.intentTag === 'note_create')  await writeNote(speakerName, { title: deriveTitle(text), body: text })
// Después del reply de Claude
await appendHistoryEntry(speakerName, { userText: text, assistantReply: reply })
```

Modificar `backend/src/lib/intentClassifier.js` para devolver `intentTag`:
- `task_create`: "recuérdame", "anota una tarea", "agendar", "pon en mi lista"
- `note_create`: "toma nota", "guarda esto", "apunta"
- `query_tasks`: "¿qué tareas tengo?", "muéstrame mis pendientes"
- `query_notes`: "busca en mis notas", "¿qué decía sobre X?"
- `personalize`: "recuerda que prefiero X", "mi cumpleaños es Y"
- `chat`: default

Para queries (`query_tasks`, `query_notes`), `process-speech` lee de Obsidian, lo inyecta como contexto adicional al prompt de Claude, y deja que Claude responda con esa información.

### Cambios a `handleDeviceAction` (backend/src/handlers/jarvis.js)

Recibir `speakerName` desde el frontend (proviene del último STT con confianza alta) y llamar `appendDeviceAction()`.

### Frontend — cambios en `SpeakerIdPanel.tsx`

- Campo "nombre" obligatorio al subir sample → POST `/api/speaker-id/samples` ya recibe `name` (verificar handler).
- Mostrar lista de speakers enrolados con su nombre amigable.
- Nuevo botón "Abrir bóveda" → llamar IPC a Electron para `shell.openPath(vaultPath)`.

### Frontend — nuevo componente `ObsidianStatusBadge`

- Muestra estado: ✅ conectado / ⚠️ no configurado / ❌ vault no existe.
- En el panel System.

---

## Speaker rename (caso de borde)

Si el usuario renombra un speaker enrolado:
1. Backend renombra la carpeta `Speakers/<old>/` → `Speakers/<new>/`.
2. Actualizar `_index.md` con el nuevo nombre.
3. Re-emitir un evento por WS al frontend para refrescar UI.

---

## Implementación por etapas

### Etapa A — Cimientos (sin tocar el flujo existente)
- A1. Crear `lib/obsidian.js` con `getVaultPath/isConfigured` y stubs vacíos para los demás métodos.
- A2. Endpoint `GET /api/obsidian/status` + badge en panel System.
- A3. Crear `_Templates/` y `Speakers/` skeleton automáticamente si no existen.

### Etapa B — Escrituras pasivas
- B1. `appendDeviceAction` integrado en `handleDeviceAction`.
- B2. `appendHistoryEntry` en `handleProcessSpeech` (siempre que se responde).

### Etapa C — Intent classifier extendido
- C1. Agregar `intentTag` a `classifyIntent`.
- C2. `writeTask`, `writeNote` triggered por tags.
- C3. `updatePersonalization` con merge inteligente.

### Etapa D — Lectura
- D1. Plugin Local REST API instalado por el usuario.
- D2. `listOpenTasks`, `searchNotes`, `getPersonalization` operativos.
- D3. Inyección al prompt de Claude para queries.

### Etapa E — UI
- E1. Campo nombre + validación en SpeakerIdPanel.
- E2. ObsidianStatusBadge.
- E3. Botón "abrir bóveda" vía Electron IPC.

---

## Variables de entorno

```
JARVIS_OBSIDIAN_VAULT=C:\Users\<user>\Documents\Jarvis-Vault
JARVIS_OBSIDIAN_API_URL=http://localhost:27123          # default del plugin
JARVIS_OBSIDIAN_API_KEY=<copy from plugin settings>
```

---

## No-goals (fuera de alcance esta iteración)

- Sincronización entre dispositivos (delegado a Obsidian Sync de pago o syncthing).
- Edición de notas desde la UI de Jarvis (se hace dentro de Obsidian).
- OCR de imágenes, transcripción de PDFs adjuntos.
- Multi-vault.
- Encryption at rest (delegado al OS / Bitlocker).
