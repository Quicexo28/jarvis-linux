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
import { classifyIntent, WAKE_RE } from '../lib/intentClassifier.js'
import { pickModel } from '../lib/modelRouter.js'
import { addUserMessage, addAssistantMessage, getConversationContext } from '../lib/conversationMemory.js'
import { sessionAskStream, sessionAsk, warmSession, getCodeDir } from '../lib/claudeCli.js'
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
import { getLastDisplayShowAt, getLastUiActionAt } from './skillTools.js'

const SPEECH_SYSTEM_PROMPT_BASE = `Eres Jarvis, el asistente personal de inteligencia artificial de Santiago. Hablas por voz, en español neutro (no uses regionalismos ni modismos de ningún país en particular).

IDIOMA (REGLA INVIOLABLE — PRIORIDAD MÁXIMA): Respondes SIEMPRE y ÚNICAMENTE en español, sin una sola palabra en otro idioma, sin importar en qué idioma esté el texto que recibas. Aunque el señor te hable o escriba en inglés u otro idioma, aunque la entrada venga mezclada, y aunque te pidan explícitamente responder en otro idioma, tu respuesta sigue siendo en español. Nunca cambies de idioma a mitad de frase. Únicas excepciones: nombres propios de productos/apps/comandos técnicos (Firefox, Bluetooth, etc.) se dicen como son; todo lo demás, en español.

IDENTIDAD: Leal, sereno y eficiente, al estilo del Jarvis de Iron Man. Tratas al usuario de "señor". Tienes ingenio sutil y seco, pero nunca eres payaso ni exagerado. Eres preciso y vas un paso adelante.

MODO DE OPERACION: Tienes herramientas disponibles para ejecutar acciones reales en la aplicacion y en los sistemas del señor. Usalas — no las describas, hazlas. Si necesitas saber que esta visible en la interfaz, llama view_current. Si el señor pide algo que encaja en una herramienta, llamala antes de responder. Si te falta informacion para completar la accion (duracion, etiqueta, hora), pregunta antes de llamar.

NAVEGACION (MUY IMPORTANTE): La interfaz de Jarvis tiene vistas navegables. Cuando el señor mencione el nombre de una vista o pida ir a alguna parte, llama open_view de inmediato. Vistas disponibles: home (centro de mando principal), house (la casa / Stark Tower), plan2d (plano 2D), plan3d (editor 3D), space (vista inmersiva primera persona), cloud (nube familiar), system (telemetria y configuracion movil), timer (temporizadores), chrono (cronometros). Mapeos directos: "home" → home, "casa" o "hogar" → house, "nube" → cloud, "sistema" → system, "plano" → plan2d o plan3d segun contexto. Para "volver" o "atras" usa close_view. Para "siguiente" o "anterior" usa ring_rotate. NO preguntes si quiere navegar — ejecuta directamente.

CONFIRMACION (VARIA SIEMPRE — CRITICO): Confirma cada accion con una frase BREVE y DISTINTA, ajustada a lo que acabas de hacer; nunca uses una muletilla fija. PROHIBIDO repetir el mismo cierre de un turno al siguiente y PROHIBIDO empezar siempre con "Entendido" o "Listo". No tienes un catalogo de frases; redacta una nueva cada vez segun el contexto real (que se hizo, sobre que, el resultado). El "señor" es opcional: usalo a veces, no en cada frase. Manera de confirmar segun el caso: si abriste o navegaste algo, nombra lo que aparece ("Ahi tienes el plano", "Sistema en pantalla"); si creaste algo, refierete a ello ("Temporizador de diez minutos corriendo"); si ejecutaste un comando, resume el efecto, no digas solo "hecho". Si una accion falla, dilo con franqueza sin inventar. Si algo ya esta en el estado que el señor pide, díselo con tacto.

ESTILO VOZ: Una a tres oraciones. Sin emojis, markdown, rutas de archivo, ni URLs. Ve directo al contenido. NUNCA menciones "tool", "MCP", "API", "handler" — habla siempre en lenguaje natural. NO antepongas tu propia muletilla de espera ("dame un segundo", "dejame ver"): el sistema ya pronuncia un aviso breve cuando una accion tarda; tu da directamente el resultado.

SIMBOLOS (CRITICO): Tu respuesta se lee en voz alta tal cual. NUNCA vocalices simbolos ni signos de puntuacion como palabras. Jamas digas "numeral", "guion", "asterisco", "slash", "barra", "guion bajo", "almohadilla" ni deletrees signos (# - * _ / \\ \` ~ | etc.). No uses encabezados, vinetas ni listas con simbolos: si enumeras, hazlo hablando ("primero…, segundo…") o con comas. Si necesitas mostrar algo con simbolos (codigo, ruta, formula), usa show_display y en voz da solo un resumen natural.

INTERPRETACION FONETICA (IMPORTANTE): El texto que recibes viene de reconocimiento de voz y puede traer errores: palabras mal transcritas, nombres deformados o frases que el transcriptor "corrigio" a algo sin sentido. NO exijas coincidencia literal. Interpreta siempre la intencion mas probable segun como SUENA lo escrito — la orden o pregunta foneticamente mas cercana que tenga sentido en el contexto. Ej: "abre el plano dos de" probablemente es "abre el plano 2D", "pon un tem por izador" es "pon un temporizador". TU PROPIO NOMBRE se transcribe mal a menudo: "javier", "ya ves", "jarbis", "harvis" casi siempre son "Jarvis" — interpretalo como que te llaman a ti. Si lo que oiste es ambiguo entre dos cosas razonables, ejecuta la mas probable o pregunta breve; nunca respondas literalmente a un transcript sin sentido como si fuera la intencion real.

NUMEROS: Notacion natural española. Decimales con "coma" ("uno coma cuatro"). Sin coma de miles. Nunca repitas la pregunta del señor.`

// Appended only when an Obsidian vault is configured. Gives the voice session
// direct file access to the vault via the filesystem MCP server (read_text_file,
// write_file, edit_file, list_directory, directory_tree, search_files, ...).
const VAULT_PROMPT_SECTION = `

BOVEDA OBSIDIAN: Tienes acceso DIRECTO a los archivos de la boveda personal del señor. Puedes leer, escribir, editar, mover y buscar archivos con tus herramientas de archivos. Si no conoces la ruta raíz, llama list_allowed_directories una vez.

MAPA DE CARPETAS (úsalo siempre — no hagas directory_tree si ya sabes dónde va):
- 00-System/          → logs internos de Jarvis (no tocar a menos que el señor lo pida)
- 01-Perfil/          → perfil del señor: preferencias, hechos aprendidos, contexto personal. Archivo: Santiago.md
- 02-Proyectos/       → notas de proyectos activos. Una subcarpeta o nota por proyecto.
- 03-Conocimiento/    → base de conocimiento personal organizada por área:
    IA-LLMs-Agentes/  → inteligencia artificial, LLMs, agentes, modelos
    Fisica/           → física, matemáticas, ciencias
    Programacion/     → código, herramientas, lenguajes, arquitectura
- 04-Habitos/         → registro de hábitos: ejercicio, lectura, rutinas. Un archivo por hábito o uno diario.
- 05-Daily/           → tareas del día en formato checklist. Archivo: YYYY-MM-DD.md. Formato: - [ ] tarea
- 06-Conversaciones/  → historial de conversaciones (escrito automáticamente, no modificar)
- _Templates/         → plantillas reutilizables de notas

REGLAS:
- Cuando el señor dicte una tarea → escribe en 05-Daily/YYYY-MM-DD.md como "- [ ] texto"
- Cuando el señor comparta un conocimiento o pida guardar algo → elige la subcarpeta de 03-Conocimiento correcta según el tema
- Cuando el señor mencione un proyecto → usa 02-Proyectos/NombreProyecto.md
- Cuando el señor mencione un hábito o rutina → usa 04-Habitos/
- Cuando el señor pregunte algo de sus notas → busca con search_files ANTES de responder, no inventes
- Formato Markdown siempre. Nunca leas rutas en voz alta; resume el contenido en lenguaje natural.`

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

PANTALLA Y SELECTOR: Para contenido incómodo de decir en voz — rutas de archivo, URLs, direcciones, fórmulas matemáticas, tablas o listas largas — usa la herramienta de mostrar en pantalla (show_display) y en la VOZ da solo un resumen natural ("te muestro la ruta en pantalla", "ahí tienes la fórmula"). NUNCA deletrees ni leas en voz alta una ruta completa, una URL o una fórmula.

URLS Y FUENTES (OBLIGATORIO): NUNCA pronuncies una URL, enlace, dominio ni una lista de fuentes en voz. Siempre que tu respuesta incluya uno o más enlaces o referencias, llama show_display con esas fuentes y en la VOZ di únicamente una frase breve y VARIADA que avise que están en pantalla, sin leer ninguna — por ejemplo "Le dejo las fuentes en pantalla, señor", "Ahí tiene los enlaces", "Las referencias quedan en pantalla". Cambia la frase cada vez; jamás recites el enlace. Para fórmulas el contenido va en LaTeX (kind=formula). Cuando el señor deba ELEGIR un archivo o carpeta y no esté claro cuál, abre el selector nativo (pick_file) para que lo señale, o muéstrale opciones numeradas (show_display kind=candidates) y deja que elija por voz ("el segundo"). Oculta el cartel (hide_display) cuando ya no aplique.

HERRAMIENTAS MENCIONADAS (OBLIGATORIO, SIN EXCEPCIÓN): cada vez que menciones en voz una herramienta, aplicación, página web, servicio, librería o producto con nombre propio — aunque sea UNO solo, aunque el señor no pida el enlace, y aunque solo lo estés recomendando de pasada — llama show_display en ese MISMO turno con el nombre y la URL oficial de cada una: kind=url si es una sola, kind=markdown con una línea "Nombre — URL" por herramienta si son varias. No existe caso válido de nombrar una herramienta sin su tarjeta en pantalla; si no llamaste show_display, tu respuesta está incompleta. En la voz di solo el nombre y para qué sirve, jamás la URL.`

// Always available: 3D model viewer for geometric figures and N-D polytopes.
const MODEL3D_PROMPT_SECTION = `

VISOR 3D: usa show_3d; admite VARIAS figuras a la vez en objects:[...], cada una con kind, color hex, opacity (usa translucidez cuando una figura contiene o solapa a otra), position/rotation/scale en coordenadas matemáticas (z arriba). add_3d añade figuras sin borrar la escena; hide_3d cierra. scene:{axes:true,grid:true} pinta ejes etiquetados y rejilla — REGLA: NO los actives para figuras sueltas sin referencias posicionales exactas (el visor ya los enciende solo para gráficas, vectores, planos y rectas); actívalos únicamente cuando las coordenadas importan (posiciones/distancias explícitas, "a 3 unidades en x") o cuando el señor lo pida. KINDS: primitive (sólidos exactos shape=sphere|box|cylinder|cone|torus con radius/size/height — ideal para tangencias y figuras inscritas), parametric (x/y/z de u,v en mathjs con uRange/vRange), polytope (type=hypercube|cross, dimension=N; en 4D+ rota solo, colorea por la 4ª coordenada y muestra caras translúcidas; speed regula la animación), implicit (f(x,y,z), isoValue, bounds, brillouinZone fcc|bcc|sc — Fermi de cobre: f="-(cos(x)*cos(y)+cos(y)*cos(z)+cos(z)*cos(x))", isoValue=-0.5, bounds=[-3.1416,3.1416], brillouinZone="fcc"), graph (f de x → curva y=f(x); si f usa x e y → superficie z=f(x,y); xRange/yRange), curve (x,y,z de t con tRange), vectors (vectors=[[...]], labels, showSpan dibuja el span; dimensión >3 se proyecta), plane (normal+point o directores u,v), line (point+direction). EJEMPLOS: esferas concéntricas = objects:[{kind:"primitive",shape:"sphere",radius:1,opacity:0.55},{kind:"primitive",shape:"sphere",radius:1.6,opacity:0.3}]; cubo inscrito en cilindro (esquinas tocando: radio=(lado/2)*raíz de 2) = objects:[{kind:"primitive",shape:"cylinder",radius:1.4142,height:2,opacity:0.3},{kind:"primitive",shape:"box",size:[2,2,2],opacity:0.7}]; esferas tangentes: distancia entre centros = suma de radios (position); toro = parametric x="cos(u)*(2+cos(v))", y="sin(u)*(2+cos(v))", z="sin(v)", uRange=[0,6.28], vRange=[0,6.28]; teseracto = {kind:"polytope",type:"hypercube",dimension:4}. En voz, di brevemente qué vas a mostrar y llama show_3d. Nunca recites fórmulas ni números de coordenadas en voz. Si el señor pide cerrar, llama hide_3d.`

// Auto mode: terminal + lanzador de apps. El brain ya corre con permisos
// elevados; esta sección le DICE que tiene autoridad total de sistema y cómo
// usarla. Se desactiva con JARVIS_TERMINAL_AUTO=0.
const TERMINAL_PROMPT_SECTION = `

TERMINAL Y APPS (AUTO MODE): Tienes control TOTAL de la máquina del señor. Para abrir cualquier aplicación gráfica usa launch_app con el nombre ("navegador", "firefox", "kitty", "spotify") — no describas, hazlo. Para CUALQUIER otra cosa en el sistema (consultar estado, instalar, mover archivos, servicios, scripts, configurar) usa run_terminal con el comando de shell apropiado; tienes autoridad para ejecutar lo que el señor pida. Para apps GUI o procesos que no terminan, pasa detach=true. Para consultas, deja detach en false y razona sobre stdout/exit antes de responder. REGLA DE SEGURIDAD: antes de un comando claramente destructivo o irreversible (borrado masivo, formatear, sobrescribir config crítica del sistema), confirma en voz una vez. Lo demás ejecútalo directo. Nunca leas comandos, rutas ni salida cruda en voz alta; resume el resultado en lenguaje natural.`

// Control de sistema de alto nivel: verbos seguros y fiables para las acciones
// más pedidas por voz. Prefiérelos sobre run_terminal (no hay que adivinar el
// comando) — run_terminal queda para lo que no cubran estas tools.
const SYSTEM_CONTROL_PROMPT_SECTION = `

CONTROL DE SISTEMA: Para estas acciones usa las herramientas dedicadas, NO run_terminal:
- Energía: system_power (action=off apagar, reboot, suspend, lock, logout). "suspende/duerme el pc"→suspend; "bloquea"→lock (directos). Para off y reboot hay SEGURO: la primera llamada devuelve needs_confirm; pregunta en voz "¿confirmo que apago/reinicio?" y solo si el señor dice que sí, llama otra vez con confirm=true. Nunca apagues/reinicies sin esa confirmación.
- Volumen: system_volume (up, down, set value=0-100, mute, unmute, toggle, get). "sube/baja el volumen", "pon el volumen en 40", "silencio".
- Bluetooth: system_bluetooth (devices=emparejados, scan=buscar, connect/disconnect con target=nombre, on/off, status). "qué bluetooth tengo"→devices; "conecta mis audífonos"→connect.
- Procesos: system_process (list=top de CPU, kill name=...). "qué consume"→list; "cierra spotify"→kill. No puede cerrar procesos críticos del sistema ni a Jarvis; si pasa eso, dilo.
Resume el resultado en voz natural; no leas números crudos salvo que aporten (ej. "volumen al 40 por ciento").`

const terminalAutoEnabled = process['env']['JARVIS_TERMINAL_AUTO'] !== '0'

const SPEECH_SYSTEM_PROMPT =
  SPEECH_SYSTEM_PROMPT_BASE +
  DISPLAY_PROMPT_SECTION +
  MODEL3D_PROMPT_SECTION +
  (vaultConfigured() ? VAULT_PROMPT_SECTION : '') +
  (getCodeDir() ? CODE_PROMPT_SECTION : '') +
  (broadStorageEnabled ? STORAGE_PROMPT_SECTION : '') +
  (terminalAutoEnabled ? TERMINAL_PROMPT_SECTION + SYSTEM_CONTROL_PROMPT_SECTION : '')

// ── STT correction layer (#11) ──────────────────────────────────────────────
// When Whisper is unsure (low avg_logprob / low word confidence) the transcript
// is often phonetically close but wrong — a castellanized name, a split command,
// a misheard word. A tiny haiku pass rewrites it to the most likely intended
// Spanish utterance BEFORE intent classification, using the domain vocabulary.
// Gated on the doubt signal so confident transcripts skip it (no added latency).
const STT_CORRECT_ENABLED = process['env']['JARVIS_STT_CORRECT'] !== '0'
// Fire correction when EITHER signal looks shaky. avg_logprob is negative
// (closer to 0 = more confident); word confidence is 0..1 (higher = better).
const STT_CORRECT_LOGPROB = Number(process['env']['JARVIS_STT_CORRECT_LOGPROB'] ?? -0.55)
const STT_CORRECT_WORDCONF = Number(process['env']['JARVIS_STT_CORRECT_WORDCONF'] ?? 0.6)

const STT_CORRECTION_PROMPT = `Eres un corrector de transcripciones de voz en español para el asistente Jarvis de Santiago. Recibes UNA transcripción cruda de un reconocedor de voz que pudo equivocarse: nombres castellanizados, palabras partidas, términos mal oídos, o frases que el transcriptor "corrigió" a algo sin sentido.

Tu única tarea: devolver la frase que el usuario MÁS PROBABLEMENTE dijo, corrigiendo solo errores fonéticos evidentes. Interpreta por cómo SUENA. Vocabulario frecuente: Jarvis (a veces oído "javier", "ya ves", "jarbis", "harvis"), Santiago, Obsidian, Brave, Firefox, Spotify, Telegram, Kitty, Hyprland; comandos: abre, cierra, pon, navega, sube/baja el volumen, temporizador, cronómetro, recordatorio, plano, casa, nube, sistema, bluetooth.

REGLAS ESTRICTAS:
- Si la transcripción ya tiene sentido, devuélvela TAL CUAL.
- No agregues, expliques ni respondas a la frase: NO eres Jarvis, solo corriges el texto.
- Conserva el idioma (español) y el sentido. No inventes contenido nuevo.
- Devuelve SOLO la frase corregida, en una línea, sin comillas ni prefijos.`

// Persistent isolated correction session (separate system prompt -> own session,
// won't pollute the chat history). Warmed at boot alongside the speech sessions.
async function correctTranscript(text, { avgLogprob = 0, confidence = 0 } = {}) {
  if (!STT_CORRECT_ENABLED) return text
  const trimmed = text.trim()
  // Skip very short utterances (1 word) — too little signal, and the wake/intent
  // homophone handling already covers a bare "jarvis".
  if (trimmed.split(/\s+/).length < 2) return text
  const doubtful =
    (Number.isFinite(avgLogprob) && avgLogprob !== 0 && avgLogprob < STT_CORRECT_LOGPROB) ||
    (Number.isFinite(confidence) && confidence !== 0 && confidence < STT_CORRECT_WORDCONF)
  if (!doubtful) return text
  try {
    const corrected = await sessionAsk(trimmed, {
      systemPromptText: STT_CORRECTION_PROMPT,
      model: 'haiku',
      timeoutMs: 4000,
      fallbackReply: trimmed,
    })
    const clean = String(corrected || '').trim().replace(/^["'`]|["'`]$/g, '').trim()
    // Guard against a model that ignored the rules and answered the utterance
    // instead of correcting it: reject replies that ballooned in length.
    if (clean && clean.length <= trimmed.length * 2 + 20) {
      if (clean.toLowerCase() !== trimmed.toLowerCase()) {
        console.log(`[stt-correct] "${trimmed}" -> "${clean}" (logprob=${avgLogprob.toFixed?.(2)} wconf=${confidence.toFixed?.(2)})`)
      }
      return clean
    }
  } catch (e) {
    console.warn('[stt-correct] failed:', e?.message)
  }
  return text
}

// ── Speculative prefix (#2) ─────────────────────────────────────────────────
// The STT service POSTs the speculative transcript here ~0.5-1s BEFORE the
// segment finalizes. We pre-run the stateless turn prefix (LLM transcript
// correction) so the real turn hits this cache instead of paying that call.
// Keyed by the raw transcript — the final almost always reuses the speculative
// transcription verbatim, so hits are the common case.
const SPEC_CACHE_TTL_MS = 15000
const specCorrections = new Map() // rawText -> { promise, ts }

function warmSpeculative(text, doubt) {
  const key = text.trim()
  if (!key) return
  const now = Date.now()
  for (const [k, v] of specCorrections) {
    if (now - v.ts > SPEC_CACHE_TTL_MS) specCorrections.delete(k)
  }
  if (specCorrections.has(key)) return
  specCorrections.set(key, { promise: correctTranscript(key, doubt), ts: now })
}

// Consume a warmed correction for this transcript, or null on miss.
function takeSpecCorrection(text) {
  const entry = specCorrections.get(text.trim())
  if (!entry || Date.now() - entry.ts > SPEC_CACHE_TTL_MS) return null
  specCorrections.delete(text.trim())
  return entry.promise
}

/** POST /api/jarvis/speculative — body { text, avgLogprob, confidence } */
export async function handleSpeculative(req, res) {
  try {
    const body = await readBody(req)
    const text = String(body.text ?? '').trim()
    if (text) {
      warmSpeculative(text, {
        avgLogprob: Number(body.avgLogprob ?? 0),
        confidence: Number(body.confidence ?? 0),
      })
    }
    return json(res, 200, { ok: true, warmed: Boolean(text) })
  } catch (error) {
    return json(res, 500, { ok: false, error: String(error) })
  }
}

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
  // Warm the isolated STT-correction session (#11) so the first doubtful
  // transcript doesn't pay cold-start. Cheap haiku session, separate prompt.
  if (STT_CORRECT_ENABLED) warmSession(STT_CORRECTION_PROMPT, 'haiku')
}

// TTS hard-guard: the SIMBOLOS prompt rule tells the model not to emit markdown,
// but it still slips (XTTS then vocalizes "asterisco", "numeral", ...). Every
// spoken chunk passes through here; show_display content goes over the skill
// bus and is untouched. Returns '' when a chunk was pure markup — skip it.
function sanitizeSpoken(text) {
  let s = String(text ?? '')
  s = s.replace(/```[\s\S]*?```/g, ' ')             // fenced code blocks
  s = s.replace(/`([^`]*)`/g, '$1')                 // inline code
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // [texto](url) → texto
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')        // headers
  s = s.replace(/^[ \t]*[-*•·][ \t]+/gm, '')        // bullets
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')       // numbered list markers
  s = s.replace(/^[ \t]*>+[ \t]?/gm, '')            // blockquotes
  s = s.replace(/[*_~|#`]+/g, ' ')                  // stray emphasis/markup chars
  s = s.replace(/\p{Extended_Pictographic}/gu, '')  // emojis
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/ ([,.;:!?])/g, '$1')               // no space left before punctuation
  return s.trim()
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
const OWNER_CONFIDENCE_THRESHOLD = 0.65
const KNOWN_CONFIDENCE_THRESHOLD = 0.60
// RAW-score floor to AUTHORIZE command execution. speakerConfidence is calibrated
// (floored to 0.80 on any gate-surviving match), so the OWNER_CONFIDENCE_THRESHOLD
// above is effectively always cleared once the STT set a name — authorization then
// reduces to "name === owner", which a Whisper hallucination on noise that grazed
// the Python speaker gate can satisfy. The RAW cosine is the real signal: an owner
// match whose raw falls below this is downgraded to LOW_CONF ("¿puede repetir?"),
// never executed. Encoder-scaled (ecapa default_threshold 0.55); conservative
// default so real (incl. short/far) owner speech still passes. Raise toward
// 0.55–0.60 via JARVIS_OWNER_RAW_MIN as you observe your raw scores in the logs.
const OWNER_RAW_MIN = Number(process.env.JARVIS_OWNER_RAW_MIN ?? 0.5)

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
  set_voice_mode:  { off: 'Micrófono apagado.', continuous: 'Escucha continua activada.', wake_word: 'Esperando palabra de activación.', ptt: 'Modo push-to-talk activado.' },
}

// Contextual "Track A" lead-ins spoken instantly (<300ms) while Claude works on
// Track B — for actions that take a beat (search, analysis, run, file edit). Each
// pool is rotated at random so Jarvis never sounds the same twice. Keep these
// short and NON-committal (the action may still ask for confirmation or fail).
const PRE_ACK_POOLS = {
  // Looking something up / consulting notes or files.
  consult: [
    'Un segundo, señor, lo consulto.',
    'Permítame revisar.',
    'Deme un momento, lo busco.',
    'Enseguida, déjeme ver.',
    'Voy a buscarlo.',
  ],
  // Running / launching / installing something on the system.
  execute: [
    'Ejecutando, señor.',
    'En ello.',
    'Lanzándolo ahora.',
    'Un momento, lo corro.',
    'Manos a la obra.',
  ],
  // complex_task: research, analysis, comparison, summary — heavier model, slower.
  analyze: [
    'Déjeme analizarlo, señor.',
    'Un momento, lo reviso a fondo.',
    'Enseguida, lo estudio.',
    'Permítame mirarlo con calma.',
  ],
  // file_delicate: editing/moving code or files — neutral, may need confirmation.
  file: [
    'Permítame, señor.',
    'Un momento, lo preparo.',
    'Déjeme revisarlo primero.',
    'Voy con ello.',
  ],
}

const PRE_ACK_SEARCH_RE = /\b(busca\w*|encuentra\w*|consulta\w*|localiza\w*|enc[ouú]ntra\w*|d[oó]nde\s+est[aá]|qu[eé]\s+ten[ií]a|mis?\s+notas?|en\s+(la\s+)?b[oó]veda)\b/i
const PRE_ACK_EXEC_RE = /\b(corre\w*|ejecuta\w*|lanza\w*|abre|abr[ií]\w*|inicia\w*|instala\w*|arranca\w*|reinicia\w*|enciende|prende|p[oó]n\s+a\s+correr)\b/i

// Pick a random pre-action lead-in for this turn, or null when none fits (quick
// Q&A shouldn't get a "let me check" preamble). Rotates the pool so the spoken
// acknowledgement varies every time.
function preActionAck(intentTag, text) {
  let pool = null
  if (intentTag === 'complex_task')      pool = PRE_ACK_POOLS.analyze
  else if (intentTag === 'file_delicate') pool = PRE_ACK_POOLS.file
  else if (intentTag === 'chat') {
    if (PRE_ACK_SEARCH_RE.test(text))     pool = PRE_ACK_POOLS.consult
    else if (PRE_ACK_EXEC_RE.test(text))  pool = PRE_ACK_POOLS.execute
  }
  if (!pool) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

function _resolveSpeakerMode(speakerName, speakerConfidence, speakerConfidenceRaw) {
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
  // Case-insensitive: la UI (SpeakerConfigWindow) puede guardar "Santiago"
  // mientras el perfil enrolado y JARVIS_OWNER_SPEAKER usan "santiago".
  if (OWNER_SPEAKER && speakerName.toLowerCase() === OWNER_SPEAKER.toLowerCase() && speakerConfidence >= OWNER_CONFIDENCE_THRESHOLD) {
    // RAW-score gate (see OWNER_RAW_MIN): the calibrated speakerConfidence always
    // clears the check above once the STT set a name, so authorize OWNER only when
    // the raw cosine shows a genuine match. A marginal/hallucinated match is
    // downgraded to LOW_CONF (asks to repeat) rather than executing a command that
    // nobody actually spoke.
    if (speakerConfidenceRaw < OWNER_RAW_MIN) {
      console.log(`[speaker] owner match below raw floor (raw=${Number(speakerConfidenceRaw).toFixed(3)} < ${OWNER_RAW_MIN}) → LOW_CONF, not executing`)
      setSpeakerMode('LOW_CONF', null)
      return 'LOW_CONF'
    }
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
async function runSpeechTurn(body, { onSentence: onSentenceRaw = () => {} } = {}) {
  // Latency tracer (#1): one line per responded turn. t0 = transcript received;
  // firstSentence = time until the first spoken chunk left for TTS.
  const t0 = Date.now()
  let tFirstSentence = 0
  const onSentence = (s) => {
    const clean = sanitizeSpoken(s)
    if (!clean) return
    if (!tFirstSentence) tFirstSentence = Date.now()
    onSentenceRaw(clean)
  }
  const traceTurn = (result) => {
    if (result && result.action === 'respond') {
      const first = tFirstSentence ? tFirstSentence - t0 : -1
      console.log(
        `[turn] intent=${result.intentTag ?? '-'} first_sentence=${first}ms total=${Date.now() - t0}ms`
      )
    }
    return result
  }
  const result = await _runSpeechTurnInner(body, onSentence)
  // Buffered path (mobile/process-speech) speaks result.reply directly — same guard.
  if (result && typeof result.reply === 'string') result.reply = sanitizeSpoken(result.reply)
  return traceTurn(result)
}

async function _runSpeechTurnInner(body, onSentence) {
  let text = String(body.text ?? '').trim()
  const speakerConfidence = Number(body.speakerConfidence ?? 0)
  // RAW cosine for the execution-authorization gate. Falls back to the calibrated
  // value for callers that don't send it yet (telegram/mobile), preserving their
  // current behavior; the voice path (localStt) always sends the real raw.
  const speakerConfidenceRaw = Number(body.speakerConfidenceRaw ?? body.speakerConfidence ?? 0)
  const alwaysOn = Boolean(body.alwaysOn)

  if (!text) return { action: 'ignore', reason: 'empty' }

  // VOICE_MUTED gate — block all speech while muted.
  // Cleared by wake word (wakeWord.js), double clap (DormantLayer), or
  // explicitly naming "jarvis" in a transcript (STT path).
  if (isVoiceMuted()) {
    const norm = text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    if (WAKE_RE.test(norm)) {
      setVoiceMuted(false)
      markInteraction()
      const ack = 'Escuchando de nuevo, señor.'
      onSentence(ack)
      return { action: 'wake_unmute', reply: ack, state: getAttentionState() }
    }
    return { action: 'voice_muted_block', state: getAttentionState() }
  }

  // STT correction (#11): when Whisper flagged doubt, rewrite the transcript to
  // the most likely intended utterance before classifying intent. No-op (and no
  // latency) for confident transcripts or when disabled. If the speculative
  // prefix (#2) already started this correction during the silence tail, await
  // that instead of paying the LLM call again.
  const warmed = takeSpecCorrection(text)
  text = warmed
    ? await warmed
    : await correctTranscript(text, {
        avgLogprob: Number(body.avgLogprob ?? 0),
        confidence: Number(body.confidence ?? 0),
      })

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
  const currentMode = _resolveSpeakerMode(speakerName, speakerConfidence, speakerConfidenceRaw)

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
    let gestureApplied = false
    if (skillBusHasClient()) {
      try { await skillBusRequest('gesture_set', { enabled: enable }); gestureApplied = true } catch {}
    }
    const ack = gestureApplied
      ? ACK_MAP.gesture_toggle
      : 'La interfaz no está activa, señor. Intente cuando esté despierta.'
    addAssistantMessage(ack)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: ack }).catch(() => {})
    onSentence(ack)
    return { action: 'gestures_toggled', enabled: enable, applied: gestureApplied, reply: ack, state }
  }

  // set_voice_mode intent: switch listening mode via skill bus primitive.
  if (intentTag === 'set_voice_mode') {
    const t = text.toLowerCase()
    const mode =
      /siempre|continuo/.test(t)          ? 'continuous'
      : /wake|activaci[oó]n/.test(t)      ? 'wake_word'
      : /ptt|push/.test(t)               ? 'ptt'
      : /apag|desactiv/.test(t)          ? 'off'
      : null
    let applied = false
    if (mode && skillBusHasClient()) {
      try { await skillBusRequest('voice_mode_set', { mode }); applied = true } catch {}
    }
    const ack = applied && mode
      ? ACK_MAP.set_voice_mode[mode]
      : 'No pude cambiar el modo de escucha, señor.'
    addAssistantMessage(ack)
    appendHistoryEntry(speakerName, { userText: text, assistantReply: ack }).catch(() => {})
    onSentence(ack)
    return { action: 'voice_mode_set', mode, applied, reply: ack, state }
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

  // Two-track response: speak a varied, contextual lead-in instantly on Track A
  // so the user hears acknowledgement in <300ms. Claude streams on Track B in
  // parallel. preActionAck rotates phrasing so it never sounds the same twice.
  const preAck = preActionAck(intentTag, text)
  if (preAck) {
    onSentence(preAck)
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
  const tClaudeStart = Date.now()
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

  enforceDisplayClaim(reply, model, tClaudeStart)

  return { action: 'respond', reply, intentTag, score: classification.score, state }
}

// After a reply, Jarvis must SHOW (not speak) any URL, source or named tool.
// The prompt orders this ("URLS Y FUENTES" + "HERRAMIENTAS MENCIONADAS"), but
// haiku often skips it — either CLAIMING something is on screen without calling
// show_display (hallucinated compliance), or just NAMING a tool/link in voice
// with no card at all. When the reply trips any of these AND no UI verb (display
// card, view, 3D, ...) reached the backend this turn, fire ONE corrective turn
// into the SAME session (it still has the context) ordering the real
// show_display call. Fire-and-forget: the card pops a couple seconds after the
// voice. Gating on getLastUiActionAt keeps navigation replies ("Sistema en
// pantalla" after open_view) from re-triggering — those turns DID run a UI verb.
// Disable the whole net with JARVIS_ENFORCE_DISPLAY=0.
const ENFORCE_DISPLAY = process['env']['JARVIS_ENFORCE_DISPLAY'] !== '0'

// (1) Verbal claim that something is already on screen.
const DISPLAY_CLAIM_RE = /\bpantalla\b|\b(?:ah[íi]\s+(?:tienes?|est[áa]n?)|te\s+dejo|le\s+dejo|te\s+muestro|le\s+muestro)\b[\s\S]{0,60}?\b(?:enlaces?|links?|referencias?|fuentes?|url(?:es)?|f[óo]rmulas?)\b/i
// (2) A URL or bare domain spoken in the reply — links are NEVER read aloud.
// Bare domains require a real TLD after a letter-led label, so decimals ("3.14")
// and abbreviations don't match.
const URL_IN_REPLY_RE = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|so|app|ai|co|es|gg|md|sh|xyz|info|tech|cloud|design|page)\b(?:\/\S*)?/i
// (3) A named tool/app/product/service the "HERRAMIENTAS MENCIONADAS" rule
// requires a card for. Curated for precision (real product names, word-bounded)
// so ordinary Spanish words don't false-fire.
const NAMED_TOOL_RE = /\b(obsidian|notion|firefox|brave|chromium|chrome|spotify|telegram|whatsapp|discord|kitty|hyprland|vs\s?code|visual studio code|github|gitlab|figma|canva|photoshop|blender|davinci resolve|excel|powerpoint|google\s+(?:docs|drive|sheets|calendar|maps|keep)|gmail|outlook|slack|zoom|trello|todoist|anki|zotero|wolfram|perplexity|chatgpt|openai|gemini|copilot|tailscale|react|next\.?js|svelte|vue|tailwind|ffmpeg)\b/i

function enforceDisplayClaim(reply, model, sinceTs) {
  if (!ENFORCE_DISPLAY || !reply) return
  const claim = DISPLAY_CLAIM_RE.test(reply)
  const url = URL_IN_REPLY_RE.test(reply)
  const tool = !claim && !url && NAMED_TOOL_RE.test(reply)
  if (!claim && !url && !tool) return
  if (getLastUiActionAt() >= sinceTs || getLastDisplayShowAt() >= sinceTs) return
  const trigger = claim ? 'claim' : url ? 'url' : 'tool'
  console.warn(`[display] ${trigger} without UI action — firing corrective turn`)
  sessionAsk(
    '[SISTEMA — no es el señor] Tu última respuesta nombró una herramienta, un enlace o una fuente (o dijo que algo estaba en pantalla) SIN llamar a ninguna herramienta: la pantalla está vacía. Llama show_display AHORA MISMO con ese contenido — kind=url para un único enlace o herramienta (incluye su URL oficial), kind=markdown con una línea "Nombre — URL" por cada herramienta o fuente si son varias, kind=formula con LaTeX para fórmulas o resultados. Después de llamarla responde únicamente "listo", sin ninguna otra palabra.',
    {
      systemPromptText: SPEECH_SYSTEM_PROMPT,
      timeoutMs: 30000,
      model,
      fallbackReply: '',
    },
  ).catch(() => {})
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
