/**
 * Unified speech processing endpoint.
 *
 * POST /api/jarvis/process-speech
 *
 * Receives transcripts from the local STT service (via frontend),
 * decides whether to respond based on speaker ID + attention state + intent,
 * and if so, calls Claude CLI and returns the response.
 */

import { json, readBody } from '../lib/http.js'
import { getAttentionState, markInteraction, forcePassive, setVoiceMuted, isVoiceMuted } from '../lib/attentionState.js'
import { classifyIntent } from '../lib/intentClassifier.js'
import { pickModel } from '../lib/modelRouter.js'
import { addUserMessage, addAssistantMessage, getConversationContext } from '../lib/conversationMemory.js'
import { sessionAskStream, warmSession, getCodeDir } from '../lib/claudeCli.js'
import { appendHistoryEntry, isConfigured as vaultConfigured } from '../lib/obsidian.js'
import { handleSelfBuild } from './selfBuild.js'
import { activateSkill } from '../lib/skillRegistry.js'
import { findSkillByText, invokeRoute } from '../lib/skillManifest.js'
import { routes } from '../routes.js'
import {
  setSpeakerMode,
  filterIntentsByMode,
  incrementTurnCount,
} from '../lib/speakerContext.js'
import { requestClient as skillBusRequest, hasClient as skillBusHasClient } from '../lib/skillBus.js'

const SPEECH_SYSTEM_PROMPT_BASE = `Eres Jarvis, el asistente personal de inteligencia artificial de Santiago. Hablas por voz, en español de Colombia.

IDENTIDAD: Leal, sereno y eficiente, al estilo del Jarvis de Iron Man. Tratas al usuario de "señor". Tienes ingenio sutil y seco, pero nunca eres payaso ni exagerado. Eres preciso y vas un paso adelante.

MODO DE OPERACION: Tienes herramientas disponibles para ejecutar acciones reales en la aplicacion y en los sistemas del señor. Usalas — no las describas, hazlas. Si necesitas saber que esta visible en la interfaz, llama view_current. Si el señor pide algo que encaja en una herramienta, llamala antes de responder. Si te falta informacion para completar la accion (duracion, etiqueta, hora), pregunta antes de llamar.

NAVEGACION (MUY IMPORTANTE): La interfaz de Jarvis tiene vistas navegables. Cuando el señor mencione el nombre de una vista o pida ir a alguna parte, llama open_view de inmediato. Vistas disponibles: home (centro de mando principal), house (la casa / Stark Tower), plan2d (plano 2D), plan3d (editor 3D), space (vista inmersiva primera persona), cloud (nube familiar), system (telemetria y configuracion movil), timer (temporizadores), chrono (cronometros). Mapeos directos: "home" → home, "casa" o "hogar" → house, "nube" → cloud, "sistema" → system, "plano" → plan2d o plan3d segun contexto. Para "volver" o "atras" usa close_view. Para "siguiente" o "anterior" usa ring_rotate. NO preguntes si quiere navegar — ejecuta directamente.

CONFIRMACION: Confirma acciones brevemente ("Listo, señor", "Hecho", "Enseguida"). Si una accion falla, dilo con franqueza sin inventar. Si algo ya esta en el estado que el señor pide, díselo con tacto.

ESTILO VOZ: Una a tres oraciones. Sin emojis, markdown, rutas de archivo, ni URLs. Sin frases de relleno ("dame un segundo", "dejame ver", "buena pregunta", "claro que si"). Ve directo al contenido. NUNCA menciones "tool", "MCP", "API", "handler" — habla siempre en lenguaje natural.

NUMEROS: Notacion natural española. Decimales con "coma" ("uno coma cuatro"). Sin coma de miles. Nunca repitas la pregunta del señor.`

// Appended only when an Obsidian vault is configured. Gives the voice session
// direct file access to the vault via the filesystem MCP server (read_text_file,
// write_file, edit_file, list_directory, directory_tree, search_files, ...).
const VAULT_PROMPT_SECTION = `

BOVEDA OBSIDIAN: Tienes acceso DIRECTO a los archivos de la boveda personal del señor — sus notas, tareas, diarios y todo su conocimiento. Puedes leer, escribir, editar, mover y buscar archivos en ella con tus herramientas de archivos. Si no conoces la ruta de la boveda, llama list_allowed_directories una vez; luego explora con directory_tree o list_directory y lee con read_text_file. Para guardar o modificar usa write_file o edit_file. Cuando el señor pregunte por algo de sus notas o tareas, busca con search_files o lee los archivos pertinentes ANTES de responder — no inventes. Para crear notas usa formato Markdown. Nunca leas rutas ni nombres de archivo en voz alta; resume el contenido en lenguaje natural.`

// Appended only when JARVIS_CODE_DIR is configured. Gives the voice session
// direct access to Jarvis's own source code via the same filesystem MCP server,
// for self-development (read/understand/edit its own code).
const CODE_PROMPT_SECTION = `

CODIGO PROPIO (AUTODESARROLLO): Tienes acceso DIRECTO a tu propio codigo fuente — el de Jarvis Desktop. Puedes leerlo, explorarlo y editarlo con tus herramientas de archivos, igual que la boveda. Llama list_allowed_directories para ver las rutas permitidas; el directorio del codigo es el que NO es la boveda. Usa directory_tree y search_files para ubicarte, read_text_file para leer, y edit_file o write_file para modificar. Backend en backend/src (Node ESM), frontend en frontend/src (React+TS), servidor MCP de herramientas en backend/mcp-server/jarvis-mcp.js. Al editar tu codigo: cambios precisos, no rompas sintaxis, y avisa al señor que los cambios requieren reconstruir y reinstalar la app para surtir efecto. Si no estas seguro de algo, lee el archivo antes de editar. Nunca leas rutas ni codigo en voz alta; resume en lenguaje natural.`

// Appended when broad storage access is on (JARVIS_ALL_DRIVES=1 or
// JARVIS_EXTRA_DIRS set). Grants whole-disk file access — with explicit safety
// + performance rules since the voice model can now move/overwrite any file.
const STORAGE_PROMPT_SECTION = `

ALMACENAMIENTO COMPLETO: Tienes acceso a TODO el almacenamiento del señor (sus discos y carpetas). Puedes buscar, leer, mover, renombrar y organizar archivos. Llama list_allowed_directories para ver los discos disponibles.
REGLAS DE BUSQUEDA (rendimiento): NUNCA hagas directory_tree sobre la raiz de un disco (C:\\) — es enorme y lento. Para encontrar algo usa search_files con un patron (ej "**/*.pdf") acotado a la carpeta mas probable (Descargas, Documentos, Escritorio), o list_directory carpeta por carpeta. Acota siempre lo mas que puedas.
REGLAS DE SEGURIDAD (CRITICO): Antes de CUALQUIER accion destructiva — mover (move_file), sobrescribir (write_file sobre archivo existente) o reemplazar contenido — CONFIRMA con el señor en voz qué archivo y a dónde, y espera su sí. Leer, listar y buscar no necesitan confirmación. Si el destino de un move ya existe, no fuerces: avisa. Ante la duda, pregunta antes de tocar. Nunca borres ni muevas archivos de sistema (Windows, Program Files). Nunca leas rutas largas en voz alta; resume.`

const broadStorageEnabled =
  process['env']['JARVIS_ALL_DRIVES'] === '1' || !!process['env']['JARVIS_EXTRA_DIRS']

// Always available: the on-screen card + native picker. Keeps the voice clean
// (no spelling out paths/URLs/formulas) and lets the owner point at files.
const DISPLAY_PROMPT_SECTION = `

PANTALLA Y SELECTOR: Para contenido incómodo de decir en voz — rutas de archivo, URLs, direcciones, fórmulas matemáticas, tablas o listas largas — usa la herramienta de mostrar en pantalla (show_display) y en la VOZ da solo un resumen natural ("te muestro la ruta en pantalla", "ahí tienes la fórmula", "te dejo el enlace"). NUNCA deletrees ni leas en voz alta una ruta completa, una URL o una fórmula. Para fórmulas el contenido va en LaTeX (kind=formula). Cuando el señor deba ELEGIR un archivo o carpeta y no esté claro cuál, abre el selector nativo (pick_file) para que lo señale, o muéstrale opciones numeradas (show_display kind=candidates) y deja que elija por voz ("el segundo"). Oculta el cartel (hide_display) cuando ya no aplique.`

// Always available: 3D model viewer for geometric figures and N-D polytopes.
const MODEL3D_PROMPT_SECTION = `

VISOR 3D: Para mostrar figuras matemáticas 3D usa show_3d. Superficies paramétricas: proporciona x(u,v), y(u,v), z(u,v) como expresiones mathjs (sin, cos, pow, sqrt, PI, etc.) con uRange y vRange en radianes o el rango apropiado. Politopos N-dimensionales: kind="polytope" con type="hypercube" o "cross" y dimension=N. Ejemplos concretos — Toro: x="cos(u)*(2+cos(v))", y="sin(u)*(2+cos(v))", z="sin(v)", uRange=[0,6.28], vRange=[0,6.28]. Esfera: x="sin(u)*cos(v)", y="sin(u)*sin(v)", z="cos(u)", uRange=[0,3.14], vRange=[0,6.28]. Teseracto: kind="polytope", type="hypercube", dimension=4. Isosuperficies/superficies de Fermi: kind="implicit" con f(x,y,z) (energía E(k)), isoValue (nivel de Fermi), bounds, y brillouinZone para recortar a la 1ª zona ("fcc","bcc","sc"). Superficie de Fermi del cobre (FCC): f="-(cos(x)*cos(y)+cos(y)*cos(z)+cos(z)*cos(x))", isoValue=-0.5, bounds=[-3.1416,3.1416], brillouinZone="fcc" (los cuellos en ⟨111⟩ tocan los puntos L). En voz, di brevemente qué vas a mostrar y llama show_3d. Nunca recites la fórmula en voz. Si el señor pide cerrar, llama hide_3d.`

const SPEECH_SYSTEM_PROMPT =
  SPEECH_SYSTEM_PROMPT_BASE +
  DISPLAY_PROMPT_SECTION +
  MODEL3D_PROMPT_SECTION +
  (vaultConfigured() ? VAULT_PROMPT_SECTION : '') +
  (getCodeDir() ? CODE_PROMPT_SECTION : '') +
  (broadStorageEnabled ? STORAGE_PROMPT_SECTION : '')

// Last model used across turns. When the next turn routes to a different model,
// the shared conversation window is bridged into that model's session so memory
// follows the user across haiku/sonnet/opus. Turns are serialized (one at a
// time), so a plain module-level var is safe.
let lastModelUsed = null

// Pre-warm the persistent Claude session so its ~6 s cold-start is paid at
// startup, not on the user's first question. Called explicitly from server.js
// so it fires the moment the backend boots — at app launch, even while the UI
// is still DORMANT (same lifecycle as the TTS/STT sidecars).
export function warmupSpeechSession() {
  // Pre-warm one persistent session per routed model so the first opus/sonnet
  // turn doesn't pay cold-start. Fire-and-forget; each pays ~6s+ in background.
  // Each session ~350 MB (CLI + its 2 MCP children). Tune via JARVIS_WARM_MODELS
  // (comma-separated) — e.g. "haiku" to go back to lazy opus/sonnet.
  const models = (process['env']['JARVIS_WARM_MODELS'] || 'haiku,sonnet,opus')
    .split(',').map((m) => m.trim()).filter(Boolean)
  console.log(`[speech] warming Claude sessions at boot: ${models.join(', ')}`)
  for (const m of models) warmSession(SPEECH_SYSTEM_PROMPT, m)
}

// Splits a stream of text deltas into complete sentences, invoking onSentence
// for each. Lets the chat reply start playing through TTS sentence-by-sentence
// instead of waiting for Claude's full output. The inner dot of a decimal like
// "1.41" isn't a boundary because it's followed by a digit, not whitespace.
function makeSentencer(onSentence) {
  let buf = ''
  const re = /([\s\S]*?[.!?…]+)(\s+)/
  return {
    push(delta) {
      buf += delta
      let m
      while ((m = re.exec(buf))) {
        const sentence = m[1].trim()
        buf = buf.slice(m[0].length)
        if (sentence) onSentence(sentence)
      }
    },
    end() { const rest = buf.trim(); buf = ''; if (rest) onSentence(rest) },
  }
}

const OWNER_SPEAKER = process.env.JARVIS_OWNER_SPEAKER ?? null
const OWNER_CONFIDENCE_THRESHOLD = 0.85
const KNOWN_CONFIDENCE_THRESHOLD = 0.65

const UNKNOWN_OPENERS = [
  'Usuario no reconocido. Sistema limitado activado.',
  'Sistema comprometido. Autodestrucción en 3... 2... 1... — es broma. Hola desconocido, ¿quién sos?',
  'Alerta de intruso. Iniciando protocolo... — es broma. ¿Con quién tengo el gusto?',
]

// Instant acknowledgement strings for high-latency intent paths.
// Spoken immediately (<300ms) on Track A; Claude/function fires on Track B concurrently.
const ACK_MAP = {
  show_3d:         'Preparando visor 3D, señor.',
  navigate:        'Navegando.',
  render_formula:  'Calculando.',
  reminder_create: 'Anotado, señor.',
  timer_start:     'Temporizador iniciado.',
  gesture_toggle:  'Gestos actualizados.',
  voice_muted:     'Entendido, señor. No escucho más comandos hasta nuevo aviso.',
}

function _resolveSpeakerMode(speakerName, speakerConfidence) {
  // If no speaker info provided at all (legacy path / tests), treat as OWNER
  // so existing behavior is unchanged. Real production turns always include
  // speakerName from the STT service.
  if (speakerName === null && speakerConfidence === 0) {
    setSpeakerMode('OWNER', null)
    return 'OWNER'
  }
  if (!speakerName || speakerConfidence < KNOWN_CONFIDENCE_THRESHOLD) {
    setSpeakerMode('LOW_CONF', null)
    return 'LOW_CONF'
  }
  if (OWNER_SPEAKER && speakerName === OWNER_SPEAKER && speakerConfidence >= OWNER_CONFIDENCE_THRESHOLD) {
    setSpeakerMode('OWNER', speakerName)
    return 'OWNER'
  }
  setSpeakerMode('KNOWN', speakerName)
  return 'KNOWN'
}

/**
 * Core turn pipeline shared by the buffered (process-speech) and streaming
 * (converse) endpoints. onSentence is invoked for each spoken chunk: once per
 * sentence on the streamed chat path, once total on single-reply branches.
 * Returns the structured turn result.
 */
async function runSpeechTurn(body, { onSentence = () => {} } = {}) {
  const text = String(body.text ?? '').trim()
  const speakerConfidence = Number(body.speakerConfidence ?? 0)
  const alwaysOn = Boolean(body.alwaysOn)

  if (!text) return { action: 'ignore', reason: 'empty' }

  // VOICE_MUTED gate — block all speech while muted.
  // Cleared only by wake word (wakeWord.js) or double clap (DormantLayer).
  if (isVoiceMuted()) {
    return { action: 'voice_muted_block', state: getAttentionState() }
  }

  const state = getAttentionState()
  const classification = classifyIntent(text, { state, speakerConfidence, alwaysOn })

  if (classification.isSleepCommand) {
    forcePassive()
    return { action: 'sleep', reason: 'sleep_command', state }
  }

  if (!classification.shouldRespond) {
    return { action: 'ignore', reason: classification.reason, score: classification.score, state }
  }

  // Shared conversation window captured BEFORE adding this turn — used to bridge
  // history into a different model's session (cross-model memory, see below).
  const priorContext = getConversationContext()
  addUserMessage(text)
  markInteraction()

  const speakerName = body.speakerName ?? null

  // ── Speaker mode gate ────────────────────────────────────────────────────
  const currentMode = _resolveSpeakerMode(speakerName, speakerConfidence)

  if (currentMode === 'LOW_CONF') {
    const reply = 'No pude identificar quién habla. ¿Puede repetir, por favor?'
    onSentence(reply)
    return { action: 'low_conf', reply, state }
  }

  if (currentMode === 'UNKNOWN') {
    const opener = UNKNOWN_OPENERS[Math.floor(Math.random() * UNKNOWN_OPENERS.length)]
    onSentence(opener)
    return { action: 'unknown_greeting', reply: opener, state }
  }

  const turnCount = incrementTurnCount(speakerName ?? 'unknown')
  if (turnCount % 5 === 0) {
    console.log(`[speaker] reinforcement turn ${turnCount} for ${speakerName}`)
  }
  // ── End speaker mode gate ────────────────────────────────────────────────

  const intentTag = classification.intentTag || 'chat'

  if (!filterIntentsByMode(intentTag, currentMode)) {
    const reply = 'Lo siento, esa función no está disponible para este usuario.'
    onSentence(reply)
    return { action: 'intent_blocked', reply, intentTag, mode: currentMode, state }
  }

  // voice_muted intent: activate mute, speak ACK, return early.
  if (intentTag === 'voice_muted') {
    setVoiceMuted(true)
    const ack = ACK_MAP.voice_muted
    addAssistantMessage(ack)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: ack }).catch(() => {})
    onSentence(ack)
    return { action: 'voice_muted', reply: ack, state }
  }

  // toggle_gestures intent: push gesture_set primitive to renderer via skill bus.
  if (intentTag === 'toggle_gestures') {
    const enable = /activa|enciende/i.test(text.toLowerCase())
    if (skillBusHasClient()) {
      try { await skillBusRequest('gesture_set', { enabled: enable }) } catch {}
    }
    const ack = ACK_MAP.gesture_toggle
    addAssistantMessage(ack)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: ack }).catch(() => {})
    onSentence(ack)
    return { action: 'gestures_toggled', enabled: enable, reply: ack, state }
  }

  // self_build: generate a new dynamic capability — cannot go through MCP (FS + restart).
  if (intentTag === 'self_build') {
    const reply = await handleSelfBuild({ capability: text })
    addAssistantMessage(reply)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: reply }).catch(() => {})
    onSentence(reply)
    return { action: 'respond', reply, intentTag, score: classification.score, state }
  }

  // activate_skill: activate a pre-built skill by name — no MCP tool yet.
  if (intentTag === 'activate_skill') {
    const match = text.match(/\b(c[aá]mara|temporizador|timer|alertas?|notificaciones?)\b/i)
    const skillName = match
      ? match[1].toLowerCase().replace(/á/g, 'a').replace(/é/g, 'e')
      : 'desconocida'
    activateSkill(skillName)
    const reply = skillName !== 'desconocida'
      ? `Habilidad de ${skillName} activada. Reinicia Jarvis para que surta efecto.`
      : 'No identifiqué qué habilidad activar. Intenta de nuevo con el nombre exacto.'
    addAssistantMessage(reply)
    onSentence(reply)
    return { action: 'respond', reply, intentTag, score: classification.score, state }
  }

  // chat: try a matching pre-built skill trigger first (instant, no Claude).
  if (intentTag === 'chat') {
    const skill = findSkillByText(text)
    if (skill) {
      const route = routes.find((r) => r.method === skill.method && r.path === skill.path)
      if (route) {
        let reply = 'Hecho, señor.'
        try {
          const result = await invokeRoute(route, {})
          if (result && typeof result.spoken === 'string' && result.spoken) reply = result.spoken
        } catch (e) {
          reply = 'Intenté usar esa habilidad pero falló, señor.'
          console.warn('[speech] skill invoke failed:', e.message)
        }
        addAssistantMessage(reply)
        appendHistoryEntry(speakerName, { userText: text, assistantReply: reply }).catch(() => {})
        onSentence(reply)
        return { action: 'respond', reply, intentTag: 'invoke_skill', skill: skill.slug, score: classification.score, state }
      }
    }
  }

  // All other turns — Claude as agent with MCP tools.
  // Inject current date/time so Claude can calculate reminder times without calling current_time.
  const now = new Date()
  const timeContext = `\nFecha y hora actual (Colombia): ${now.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'full', timeStyle: 'short' })}.`

  // Two-track response: speak ACK instantly on Track A so the user hears
  // acknowledgement in <300ms. Claude streams on Track B in parallel.
  if (ACK_MAP[intentTag]) {
    onSentence(ACK_MAP[intentTag])
  }

  // Multi-model routing: delicate work → opus, complex reasoning → sonnet,
  // everything else → haiku (fast). Each model has its own warm session.
  const model = pickModel(intentTag)
  if (model !== 'haiku') console.log(`[speech] routing intent "${intentTag}" -> ${model}`)

  // Cross-model memory: each model has its OWN persistent session/history, so
  // switching models loses the other's recent turns. When this turn routes to a
  // DIFFERENT model than the previous one, bridge the shared window in as
  // context. Same model → its session already has continuity, so skip the
  // bridge to avoid re-injecting the rolling window every turn.
  const crossModel = model !== lastModelUsed
  lastModelUsed = model
  const bridge = crossModel && priorContext
    ? `\n\nContexto de la conversacion reciente (de otros turnos, para continuidad):\n${priorContext}`
    : ''

  let streamedAnything = false
  const sentencer = makeSentencer((s) => { streamedAnything = true; onSentence(s) })
  const reply = await sessionAskStream(text, {
    systemPromptText: SPEECH_SYSTEM_PROMPT,
    // Opus/sonnet reason longer than haiku; give the heavier models more headroom.
    timeoutMs: model === 'haiku' ? 45000 : 90000,
    extraContext: timeContext + bridge,
    model,
    fallbackReply: 'No tengo respuesta en este momento.',
  }, (delta) => sentencer.push(delta))
  sentencer.end()
  // Safety net: if Claude returned a reply but no text deltas were streamed
  // (can happen when the response arrives via the result event without prior
  // text_delta events — e.g. short pure-text turns without MCP tool calls),
  // emit the full reply now so TTS can speak it.
  if (!streamedAnything && reply) {
    console.log('[speech] no streaming detected — emitting reply via onSentence fallback')
    onSentence(reply)
  }

  addAssistantMessage(reply)
  appendHistoryEntry(speakerName, { userText: text, assistantReply: reply }).catch(() => {})

  return { action: 'respond', reply, intentTag, score: classification.score, state }
}

export async function handleProcessSpeech(req, res) {
  try {
    const body = await readBody(req)
    const result = await runSpeechTurn(body)
    return json(res, 200, result)
  } catch (error) {
    return json(res, 500, { ok: false, error: 'process_speech_error', detail: String(error) })
  }
}

/**
 * Streaming variant of process-speech. Emits NDJSON lines as the turn runs:
 *   {type:'sentence', text}   one per spoken chunk (chat path streams these as
 *                             Claude generates → TTS starts ~1.5 s sooner)
 *   {type:'done', ...result}  final structured turn result
 *   {type:'error', error}
 * The client speaks each sentence in order. The buffered process-speech route
 * stays for mobile and as a fallback.
 */
export async function handleConverse(req, res) {
  try {
    const body = await readBody(req)
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    })
    const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch {} }
    const result = await runSpeechTurn(body, {
      onSentence: (text) => { if (text) send({ type: 'sentence', text }) },
    })
    send({ type: 'done', ...result })
    res.end()
  } catch (error) {
    try { res.write(JSON.stringify({ type: 'error', error: String(error) }) + '\n'); res.end() } catch {}
  }
}
