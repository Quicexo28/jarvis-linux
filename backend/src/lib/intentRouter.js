/**
 * LLM-based intent router.
 *
 * Replaces hardcoded regex intent classification with a haiku-driven router
 * that sees the live transcript + recent conversation context and emits a
 * structured tool call. This is what lets Jarvis correctly interpret short
 * follow-ups like "30 segundos ya" right after "pon un temporizador" — the
 * recent context disambiguates what the user meant.
 *
 * Output is strict JSON: { tool: string, params: object, reason: string }.
 *
 * Tools enumerated in the system prompt must stay in sync with the handlers
 * in speech.js and the renderer primitives in frontend/src/skills/primitives.ts.
 */

import { runClaude } from './claudeCli.js'
import { getConversationContext } from './conversationMemory.js'

const ROUTER_SYSTEM = `Eres el clasificador de intenciones de Jarvis. Recibes la última frase del usuario y el historial reciente. Tu trabajo: decidir EXACTAMENTE qué acción del sistema disparar.

Devuelves SOLO un objeto JSON, sin texto ni markdown, con esta forma:
{"tool": string, "params": object, "reason": string}

Catálogo de tools disponibles (usa exactamente uno):

- timer_start: iniciar un temporizador (cuenta regresiva con alarma local). params: {seconds: number, label?: string}
- timer_pause: pausar temporizador en curso. params: {label?: string}
- timer_resume: reanudar temporizador pausado. params: {label?: string}
- timer_add: agregar tiempo a un temporizador activo. params: {seconds: number, label?: string}
- timer_cancel: cancelar temporizador. params: {label?: string, all?: boolean}
- timer_reset: reiniciar temporizador a su duración original. params: {label?: string}
- chrono_start: iniciar cronómetro (cuenta progresiva con vueltas). params: {label?: string}
- chrono_pause: pausar cronómetro. params: {label?: string}
- chrono_resume: reanudar cronómetro. params: {label?: string}
- chrono_reset: poner cronómetro en cero. params: {label?: string}
- chrono_lap: marcar vuelta en cronómetro. params: {label?: string}
- chrono_cancel: cancelar cronómetro. params: {label?: string, all?: boolean}
- reminder_create: recordatorio Telegram con hora del día específica (ej: "mañana a las 8"). params: {text: string}
- reminder_list: leer recordatorios pendientes. params: {}
- notify_now: enviar notificación Telegram inmediata. params: {text: string}
- task_create: crear tarea en Obsidian. params: {}
- note_create: crear nota en Obsidian. params: {}
- query_tasks: consultar tareas pendientes. params: {}
- query_notes: buscar en notas Obsidian. params: {}
- personalize: aprender dato personal del usuario. params: {}
- cloud_save: guardar archivo en nube familiar. params: {}
- cloud_read: leer archivos de nube. params: {}
- query_science: respuesta científica rigurosa. params: {}
- query_research: investigación profunda. params: {}
- self_build: construir una nueva capacidad. params: {}
- activate_skill: activar habilidad pre-existente. params: {}
- chat: conversación normal sin acción específica. params: {}

REGLAS CRÍTICAS:

1. Distingue temporizador (cuenta regresiva, dispara alarma local) de recordatorio (mensaje Telegram a hora futura). "Pon un timer de 10 minutos" → timer_start. "Recuérdame a las 8 de la noche" → reminder_create.

2. Si la última frase es ambigua o muy corta (ej: "30 segundos", "5 minutos ya"), usa el historial. Si en el turno anterior Jarvis estaba hablando de temporizador, interpreta como timer_start o timer_add según el verbo implícito.

3. Para timer_start y timer_add, convierte cualquier expresión de tiempo a segundos enteros. "media hora" → 1800. "una hora y veinte minutos" → 4800. "30 segundos" → 30.

4. Para label: extrae el objeto/actividad solo si está claro ("para la pasta" → label: "pasta"). Si no, omite.

5. Si NO encaja en ninguna tool específica, usa "chat".

6. reason: 1 frase corta explicando tu elección (para debugging).

Ejemplos:

Frase: "pon un temporizador de 5 minutos para la pasta"
JSON: {"tool":"timer_start","params":{"seconds":300,"label":"pasta"},"reason":"verbo claro + duración + label"}

Frase: "30 segundos ya"
Historial: Usuario: pon un timer | Jarvis: ¿de cuántos minutos, señor?
JSON: {"tool":"timer_start","params":{"seconds":30},"reason":"continúa pedido de timer del turno anterior"}

Frase: "pausa eso"
Historial: Usuario: pon timer 10 min | Jarvis: Listo, señor.
JSON: {"tool":"timer_pause","params":{},"reason":"pausa el timer mencionado recientemente"}

Frase: "cómo estás"
JSON: {"tool":"chat","params":{},"reason":"saludo casual"}`

/**
 * Ask haiku to classify the utterance into a tool call.
 *
 * @param {string} text — current user transcript
 * @param {object} [opts]
 * @param {boolean} [opts.includeHistory=true] — pass recent conversation
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<{tool: string, params: object, reason: string} | null>}
 */
export async function routeIntent(text, opts = {}) {
  const { includeHistory = true, timeoutMs = 8000 } = opts
  const utterance = String(text || '').trim()
  if (!utterance) return null

  const history = includeHistory ? getConversationContext() : ''
  const promptBody = history
    ? `Historial reciente:\n${history}\n\nFrase actual: "${utterance}"`
    : `Frase actual: "${utterance}"`

  const raw = await runClaude(promptBody, {
    systemPromptText: ROUTER_SYSTEM,
    timeoutMs,
    model: 'haiku',
    fallbackReply: '',
    namespace: 'jarvis-intent-router',
  })
  if (!raw) return null
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  let obj
  try { obj = JSON.parse(m[0]) } catch { return null }
  if (!obj || typeof obj.tool !== 'string') return null
  return {
    tool: obj.tool,
    params: obj.params && typeof obj.params === 'object' ? obj.params : {},
    reason: typeof obj.reason === 'string' ? obj.reason : '',
  }
}
