/**
 * Model routing for Jarvis turns.
 *
 * Picks the Claude model by task type so cheap/fast haiku handles chat and
 * commands, sonnet handles deliberate research/science, and opus handles
 * building new tools (self-build code generation).
 *
 * The model string flows into claudeCli.js (runClaude / sessionAsk), which keys
 * its persistent-session cache by `model::hash(prompt)`, so each model gets its
 * own warm process.
 */

/** @typedef {'haiku'|'sonnet'|'opus'} ClaudeModel */

// Delicate / irreversible work → opus (best judgment, follows safety rules):
// building new capabilities (code gen) and destructive file/code operations.
const OPUS_INTENTS = new Set(['self_build', 'file_delicate'])
// Complex reasoning / multi-step analysis → sonnet.
const SONNET_INTENTS = new Set(['complex_task'])

// ── Study routing ───────────────────────────────────────────────────────────
// The intent classifier only tags commands; in practice EVERY turn came back
// `chat` (30 days of traces: 34/34), so a physics question went to haiku. Study
// is decided on the TEXT instead, and deliberately not as an intent tag: a
// non-chat tag forces a response even from PASSIVE (`intentForce`), and an
// overheard "¿por qué…?" must not start answering.
//
// Matched on the accent-free lowercase form — `\b` only understands ASCII
// (same trap as the wake phrases).

// Verbs that ask for teaching or solving.
const STUDY_VERB_RE = /\b(explica\w*|expliqu\w*|ensena\w*|ensen[ae]me|demuestra\w*|demostracion|deriva(r|me|lo|la)?|deduce\w*|deduc(ir|cion)|resuelve\w*|resolver|calcula(r|me|lo|la)?|integra(r|me)|ejercicio\w*|intuicion)\b/
// Domain vocabulary: physics, maths, the degree.
const STUDY_DOMAIN_RE = /\b(fisica|matematica\w*|calculo|algebra|ecuacion\w*|integral\w*|derivada\w*|vector\w*|matri(z|ces)|campo\w*|fuerza\w*|energia|momento|torque|onda\w*|entropia|termodinamica|cuantic\w*|relatividad|electr\w*|magnet\w*|gravedad|gravitacion\w*|orbita\w*|oscilad\w*|armonico|lagrang\w*|hamilton\w*|tensor\w*|autovalor\w*|eigen\w*|probabilidad\w*|estadistica|limite\w*|serie\w*|teorema\w*|circuito\w*|potencial|flujo|divergencia|rotacional|gradiente|cinematica|dinamica|optica|nuclear|particula\w*|fotones?|electron\w*|velocidad|aceleracion|inercia|friccion|presion|temperatura|calor|trabajo mecanico|conservacion|newton|maxwell|schrodinger|kepler|coulomb|ohm)\b/g
const QUESTION_RE = /\b(por que|porque|como (funciona|es que|se (calcula|obtiene|deriva|demuestra|resuelve|define))|que (es|son|significa|pasa|relacion)|cual es la (diferencia|relacion|formula))\b/

// A follow-up inside a study exchange stays on sonnet ("¿y si la masa se
// duplica?") unless it is plainly a command for the desktop.
const STUDY_STICKY_MS = Number(process.env.JARVIS_STUDY_STICKY_MS || 180000)
const COMMAND_HEAD_RE = /^(?:(?:oye|ok|bueno|jarvis|vale)[, ]+)*(abre|cierra|pon|apaga|enciende|sube|baja|pausa|para|silencia|lanza|ve al?|vuelve|siguiente|anterior|inicia|cancela|temporizador|cronometro|volumen|musica|duerme|bloquea|suspende|copia)\b/

// Seen live: "qué ventanas tengo abiertas" right after a physics question
// stayed on sonnet — a QUESTION about the desktop, not an imperative, so the
// head regex missed it. Naming a desktop or day-planning thing ends the study
// exchange too ("ya entrené hoy" after starting a pomodoro went to sonnet).
// "vamos a estudiar" / "repaso" are session logistics, not questions, so they
// are deliberately NOT study verbs above.
const DESKTOP_NOUN_RE = /\b(ventana\w*|escritorio\w*|musica|cancion\w*|volumen|temporizador\w*|cronometro\w*|recordatorio\w*|pantalla|navegador|aplicacion\w*|app|bluetooth|portapapeles|luces|proyector|vista|notificacion\w*|hora|tarea\w*|habito\w*|entren\w*|pomodoro|sesion|descanso|hoy|manana|agenda|tarjeta\w*)\b/

let lastStudyAt = -Infinity

function normalize(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Does this utterance ask Jarvis to teach, explain or solve something?
 * @param {string} text
 */
export function isStudyTurn(text) {
  const t = normalize(text)
  if (!t.trim()) return false
  const domain = (t.match(STUDY_DOMAIN_RE) || []).length
  if (STUDY_VERB_RE.test(t) && (domain > 0 || /\b(explica|ensen|demuestra|resuelve|deriva|deduc)/.test(t))) return true
  if (QUESTION_RE.test(t) && domain > 0) return true
  return domain >= 2
}

/**
 * Map a turn to the model that should answer it. Everything not listed
 * (chat, commands, navigation, timers, quick queries) → haiku for speed.
 * @param {string} intentTag
 * @param {string} [text]  the utterance; enables study routing
 * @param {number} [now]
 * @returns {ClaudeModel}
 */
export function pickModel(intentTag, text = '', now = Date.now()) {
  if (OPUS_INTENTS.has(intentTag)) return 'opus'
  if (SONNET_INTENTS.has(intentTag)) return 'sonnet'
  if (process.env.JARVIS_STUDY_ROUTING === '0' || !text) return 'haiku'
  if (isStudyTurn(text)) {
    lastStudyAt = now
    return 'sonnet'
  }
  const t = normalize(text).trim()
  if (now - lastStudyAt < STUDY_STICKY_MS) {
    // A desktop/day turn ENDS the study exchange instead of just skipping it:
    // "anota una tarea" and then "ya repasé óptica" went back to sonnet live.
    if (COMMAND_HEAD_RE.test(t) || DESKTOP_NOUN_RE.test(t)) {
      lastStudyAt = -Infinity
      return 'haiku'
    }
    lastStudyAt = now
    return 'sonnet'
  }
  return 'haiku'
}

/** Test hook: forget the study stickiness. */
export function resetStudyState() {
  lastStudyAt = -Infinity
}
