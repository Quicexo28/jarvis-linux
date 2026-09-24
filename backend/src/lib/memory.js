/**
 * Long-term memory: recall before the turn, learning after it.
 *
 * What existed before: `conversationMemory.js` (8 turns, RAM, gone on restart)
 * and the vault's 06-Conversaciones log, which nothing ever read back. So Jarvis
 * could be told something on Monday and have no way to know it on Tuesday.
 *
 * The two halves here:
 *
 *   recallContext(text)  — full-text search over stored facts (and, further
 *                          back, past turns) for whatever relates to what the
 *                          user just said. Injected into the turn as context.
 *   learnFromTurn(...)   — after replying, a cheap haiku pass pulls DURABLE
 *                          facts out of the exchange and stores them. Fire and
 *                          forget: it must never add latency to the spoken turn,
 *                          same discipline as the STT's `_learn_async`.
 *
 * Retrieval is BM25 (SQLite FTS5), not embeddings, on purpose: it is already
 * installed, needs no model to load and no GPU, and for "what do I know about
 * the word this person just said" it is strong. Embeddings are the upgrade path
 * once traces show recall misses, not the starting point.
 */

import { runClaude } from './claudeCli.js'
import { addFact, searchFacts, searchTurns } from './turnStore.js'

const RECALL_ENABLED = () => process['env']['JARVIS_MEMORY_RECALL'] !== '0'
const LEARN_ENABLED = () => process['env']['JARVIS_MEMORY_LEARN'] !== '0'
const MAX_FACTS = Number(process['env']['JARVIS_MEMORY_FACTS'] ?? 6)
const MAX_TURNS = Number(process['env']['JARVIS_MEMORY_TURNS'] ?? 2)

/**
 * Build the memory block to prepend to a turn, or '' when nothing is relevant.
 * Kept deliberately small — every line here is spent on every turn.
 * @param {string} text  what the user just said
 * @returns {string}
 */
export function recallContext(text) {
  if (!RECALL_ENABLED()) return ''
  const query = String(text ?? '').trim()
  if (query.length < 4) return ''
  try {
    const facts = searchFacts(query, MAX_FACTS)
    // Past turns are the weaker signal (they include Jarvis's own chatter), so
    // they only come along when facts didn't already fill the budget.
    const turns = facts.length >= MAX_FACTS ? [] : searchTurns(query, MAX_TURNS)
    if (!facts.length && !turns.length) return ''

    const lines = []
    if (facts.length) {
      lines.push('Lo que ya sabes del señor (memoria persistente):')
      for (const f of facts) lines.push(`- ${f.text}`)
    }
    if (turns.length) {
      lines.push('Conversaciones anteriores relacionadas:')
      for (const t of turns) {
        const when = new Date(t.ts).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })
        lines.push(`- (${when}) el señor dijo "${clip(t.text, 90)}" y respondiste "${clip(t.reply, 90)}"`)
      }
    }
    lines.push('Usa esto solo si viene al caso; no lo recites ni menciones que lo recordaste de una base de datos.')
    return '\n\n' + lines.join('\n')
  } catch (e) {
    console.warn('[memory] recall failed —', e?.message)
    return ''
  }
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const EXTRACT_PROMPT = `Extraes hechos DURADEROS sobre el usuario a partir de un intercambio de voz con su asistente.

Devuelves SOLO un array JSON, sin texto ni markdown. Cada elemento: {"kind": "...", "subject": "...", "text": "..."}.

kind es uno de: preference (gustos, formas de trabajar), project (proyecto en curso), person (gente de su vida), routine (hábito u horario), config (ajuste técnico suyo), fact (cualquier otro dato estable).

QUÉ SÍ extraer: información que seguirá siendo cierta dentro de un mes y que sirve para atenderlo mejor. Ejemplos: "Trabaja en un proyecto llamado Jarvis", "Prefiere respuestas cortas", "Su hermana se llama Ana", "Entrena por la mañana".

QUÉ NO extraer (devuelve [] si solo hay esto):
- Órdenes y su ejecución ("pon un temporizador", "abre el navegador", "sube el volumen").
- Preguntas del usuario y respuestas de conocimiento general.
- Estados momentáneos ("tengo sueño hoy", "está lloviendo").
- Lo que dijo el asistente sobre sí mismo o sobre lo que acaba de hacer.
- Cualquier cosa insegura o inventada: si no está dicho explícitamente, no lo escribas.

Cada "text" es una frase en español, en tercera persona, autocontenida (se leerá sin el contexto original). Máximo 3 elementos. Si no hay nada duradero, devuelve exactamente [].`

/**
 * Pull durable facts out of a finished exchange and store them. Fire-and-forget:
 * callers must NOT await this on the voice path.
 * @param {{text: string, reply: string, turnId?: number|null, intent?: string}} turn
 */
export function learnFromTurn({ text, reply, turnId = null, intent = '' } = {}) {
  if (!LEARN_ENABLED()) return
  const user = String(text ?? '').trim()
  if (user.length < 12) return                 // "sí", "gracias", "abre eso"
  // Pure device commands never carry durable facts; skip the model call entirely.
  if (/^(timer|chrono|navigate|open_view|close_view|ring_rotate|system_)/.test(intent)) return

  const exchange = `Usuario: ${user}\nAsistente: ${String(reply ?? '').trim()}`
  runClaude(exchange, {
    systemPromptText: EXTRACT_PROMPT,
    model: 'haiku',
    timeoutMs: 20000,
    namespace: 'jarvis-memory',
    fallbackReply: '[]',
    // The extractor answers with a JSON array, often pretty-printed: without
    // this the caller would only ever see its last line.
    multiline: true,
  })
    .then((out) => {
      const facts = parseFacts(out)
      if (!facts.length) return
      for (const f of facts) addFact({ ...f, source: turnId ? `turn:${turnId}` : 'turn' })
      console.log(`[memory] learned ${facts.length}: ${facts.map((f) => f.text).join(' | ')}`)
    })
    .catch((e) => console.warn('[memory] learn failed —', e?.message))
}

/**
 * Parse the extractor's output defensively — a model can wrap JSON in prose or
 * a code fence, and a malformed answer must cost nothing.
 * @param {string} out
 * @returns {Array<{kind: string, subject: string|null, text: string}>}
 */
export function parseFacts(out) {
  const raw = String(out ?? '')
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const KINDS = new Set(['preference', 'project', 'person', 'routine', 'config', 'fact'])
  return arr
    .filter((f) => f && typeof f.text === 'string')
    .map((f) => ({
      kind: KINDS.has(f.kind) ? f.kind : 'fact',
      subject: typeof f.subject === 'string' && f.subject.trim() ? f.subject.trim().slice(0, 60) : null,
      text: f.text.trim().slice(0, 300),
    }))
    .filter((f) => f.text.length > 8)
    .slice(0, 3)
}
