/**
 * Intent classifier for Jarvis speech processing.
 *
 * Determines whether a transcript should be sent to Claude based on:
 * - Speaker confidence (is it the owner?)
 * - Attention state (recency of interaction)
 * - Linguistic cues (action words, questions, direct address)
 */

const ACTION_WORDS = [
  'apaga', 'enciende', 'prende', 'abre', 'cierra', 'sube', 'baja', 'pon', 'quita',
  'activa', 'desactiva', 'muestra', 'dime', 'dimelo', 'que', 'cual', 'cuanto',
  'cuando', 'como', 'por que', 'puedes', 'puede', 'ayuda', 'ayudame',
  'busca', 'encuentra', 'lista', 'explica', 'necesito', 'quiero', 'hazlo',
  'cambia', 'ajusta', 'configura', 'modo', 'reproduce', 'pausa', 'detente',
  'recuerda', 'olvidalo', 'repite', 'conecta', 'desconecta',
]

const DIRECT_ADDRESS_RE = /^(dime|hazme|ponme|ayudame|muestrame|pon|apaga|enciende|abre|cierra|jarvis)/i
// Explicit wake phrase anywhere in the utterance. In wake-word mode, naming
// Jarvis must always engage, even from PASSIVE — so this overrides the score
// threshold entirely.
const WAKE_RE = /\b(jarvis|desp[ie]ert|oye jarvis|hola jarvis)\b/i
const QUESTION_RE = /\?$/
const SLEEP_COMMANDS = /\b(descansa|duerme|silencio|callate|no molestes)\b/i

// self_build fires when the user asks Jarvis to grow a new capability or repair
// itself. Two families: (1) generic self-expansion / self-repair phrasing, and
// (2) the original camera shortcuts. Capability verbs are anchored to capability
// nouns (capacidad|habilidad|función|skill|herramienta) so normal chat like
// "crea una nota" does NOT match.
const SELF_BUILD_RE = new RegExp([
  // intent-to-extend openers
  'no\\s+puedes',
  'no\\s+sabes\\s+c[oó]mo',
  'necesito\\s+que\\s+puedas',
  'aprende\\s+a\\b',
  '(conf[ií]g[uú]rate|act[íi]vate|modif[ií]cate|prep[aá]rate|exti[eé]ndete|ampl[ií]ate)\\s+para',
  // "crea/créate/constrúyete (una nueva) capacidad|habilidad|función|skill|herramienta"
  '(crea|cr[eé]ate|h[aá]zte|constr[uú]yete|gen[eé]rate|desarr[oó]lla(te)?|impl[eé]menta(te)?|construye|programa|a[ñn][aá]de(te)?)\\s+(te\\s+)?(una?\\s+)?(nueva\\s+)?(capacidad|habilidad|funci[oó]n|funcionalidad|skill|herramienta)',
  // "... como una (nueva) capacidad creada"
  'como\\s+(una\\s+)?(nueva\\s+)?(capacidad|habilidad|funci[oó]n|skill)\\s+(creada|nueva|propia)',
  // self-modify / self-repair
  'auto[\\s-]?(modif[ií]ca|arr[eé]gla|repar[ae]|expand|exti[eé]nd|constr[uú]y)',
  '(modif[ií]cate|arr[eé]glate|repar[aá]te|ampl[ií]ate|exti[eé]ndete|exp[aá]ndete)\\b',
  // original camera shortcuts
  'implementa\\s+(la\\s+)?capacidad',
  't[oó]ma(me)?\\s+una\\s+foto',
  'saca(me)?\\s+una\\s+foto',
  'haz(me)?\\s+una\\s+foto',
  'con[eé]ctate\\s+a\\s+(mi\\s+|la\\s+)?c[aá]mara',
  'usa\\s+(mi\\s+|la\\s+)?c[aá]mara',
].join('|'), 'i')
const ACTIVATE_SKILL_RE = /\b(activa\s+(la?\s+)?habilidad|activa\s+(el?\s+)?skill|habilita\s+(la?\s+)?funci[oó]n|enciende\s+(la?\s+)?habilidad)\b/i
const TOGGLE_GESTURES_RE = /\b(activa|desactiva|enciende|apaga)\s+(los?\s+)?gestos\b/i
const VOICE_MUTED_RE = /\b(no\s+escuches|ign[oó]ra(me)?|modo\s+silencio|silencio\s+de\s+voz)\b/i

// Delicate / irreversible work → routed to opus (modelRouter). A destructive
// file verb NEAR a file/code noun, OR editing Jarvis's own code. The noun gate
// avoids mis-routing "mueve la vista/cámara" (navigation, stays haiku).
const FILE_DELICATE_RE = /\b(mueve|mover|borra|borrar|elimina|eliminar|sobre?escrib\w+|renombra\w*|reorganiza\w*)\b.{0,40}\b(archivo|fichero|carpeta|directorio|documento|foto|imagen|video|pdf|\.\w{2,4})\b|\b(edita|edíta|modifica|corrige|arregla|refactoriza|reescribe)\b.{0,40}\b(c[oó]digo|backend|frontend|archivo|funci[oó]n|m[oó]dulo|\.\w{2,4})\b/i

// Complex reasoning / multi-step analysis → routed to sonnet. Deliberate verbs
// that imply more than a one-shot command or quick chat.
const COMPLEX_TASK_RE = /\b(investiga\w*|analiza\w*|an[aá]lisis|compara\w*|res[uú]me\w*|res[uú]men|diagnostica\w*|audita\w*|revisa\s+(el|mi|tu)\s+c[oó]digo|plane?a\w*|dise[ñn]a\w*|eval[uú]a\w*|examina\w*|explica\w+\s+(a\s+fondo|en\s+detalle|por\s+qu[eé]\s+funciona))\b/i

// Timer and chrono constants — unused for routing but kept for reference.
const TIMER_RE = /\b(temporizador(es)?|cuenta\s+(regresiva|atr[aá]s)|alarma\s+(de|en|por|para)|timer)s?\b/i
const CHRONO_RE = /\b(cron[oó]metro|cron[oó]metra|stopwatch|cuenta\s+(progresiva|hacia\s+arriba))\b/i

function detectIntentTag(text) {
  // self_build + activate_skill bypass the normal Claude path (special handling
  // in speech.js). file_delicate + complex_task go to Claude like chat but pick
  // a stronger model (modelRouter.pickModel). Order = most specific first.
  if (SELF_BUILD_RE.test(text))     { console.log('[intent] -> self_build:', text);    return 'self_build' }
  if (ACTIVATE_SKILL_RE.test(text)) { console.log('[intent] -> activate_skill:', text); return 'activate_skill' }
  if (FILE_DELICATE_RE.test(text))  { console.log('[intent] -> file_delicate:', text);  return 'file_delicate' }
  if (COMPLEX_TASK_RE.test(text))   { console.log('[intent] -> complex_task:', text);   return 'complex_task' }
  if (TOGGLE_GESTURES_RE.test(text)) { console.log('[intent] -> toggle_gestures:', text); return 'toggle_gestures' }
  if (VOICE_MUTED_RE.test(text))    { console.log('[intent] -> voice_muted:', text);    return 'voice_muted' }
  return 'chat'
}

const THRESHOLDS = {
  ENGAGED: 0.3,
  ATTENTIVE: 0.5,
  PASSIVE: 0.7,
}

const SPEAKER_MIN_CONFIDENCE = 0.65

/**
 * @param {string} transcript
 * @param {{ state: string, speakerConfidence: number }} context
 * @returns {{ shouldRespond: boolean, score: number, state: string, isSleepCommand: boolean }}
 */
export function classifyIntent(transcript, context) {
  const { state, speakerConfidence, alwaysOn } = context
  const text = transcript.toLowerCase().trim()
  // Strip accents so keyword matching works on "cómo", "qué", etc.
  const norm = text.normalize('NFD').replace(/\p{Diacritic}/gu, '')
  const words = text.split(/\s+/)

  // Gate: speaker confidence too low = not the owner
  if (speakerConfidence < SPEAKER_MIN_CONFIDENCE) {
    return { shouldRespond: false, score: 0, state, reason: 'not_owner', isSleepCommand: false }
  }

  // Check for sleep/dismiss commands
  if (SLEEP_COMMANDS.test(text)) {
    return { shouldRespond: false, score: 0, state, reason: 'sleep_command', isSleepCommand: true }
  }

  let score = 0.0

  // Direct address patterns
  if (DIRECT_ADDRESS_RE.test(norm)) score += 0.4

  // Question ending
  if (QUESTION_RE.test(text)) score += 0.2

  // Action words (accent-insensitive)
  if (ACTION_WORDS.some(w => norm.includes(w))) score += 0.3

  // Recency boost by state
  if (state === 'ENGAGED') score += 0.4
  else if (state === 'ATTENTIVE') score += 0.2

  // Length heuristic
  if (words.length >= 5) score += 0.15
  else if (words.length >= 3) score += 0.05
  else if (words.length <= 2 && state !== 'ENGAGED') score -= 0.15

  // Explicit "jarvis" mention always boosts
  if (norm.includes('jarvis')) score += 0.3

  score = Math.min(Math.max(score, 0), 1.0)

  const threshold = THRESHOLDS[state] ?? THRESHOLDS.PASSIVE
  const intentTag = detectIntentTag(text)
  // Intent-tagged sentences should always trigger a response (override
  // threshold) — the user clearly addressed Jarvis with a task/note/query.
  const intentForce = intentTag !== 'chat'
  // Wake-word model: naming Jarvis always engages, even from PASSIVE.
  const isWake = WAKE_RE.test(norm)
  // Always-on mode (set while the UI is AWAKE): the owner already summoned
  // Jarvis, so respond to every owner utterance without a wake word. Speaker
  // confidence + sleep-command gates above still apply.
  const reason = alwaysOn ? 'always_on'
    : isWake ? 'wake'
    : intentForce ? `intent:${intentTag}`
    : score >= threshold ? 'classified'
    : 'below_threshold'
  return {
    shouldRespond: alwaysOn || isWake || intentForce || score >= threshold,
    score,
    state,
    intentTag,
    reason,
    isSleepCommand: false,
  }
}
