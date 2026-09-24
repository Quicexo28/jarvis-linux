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

// Phonetic homophones of "jarvis" that the STT commonly mishears, in TWO TIERS
// because the failure modes pull in opposite directions. Single source of truth
// for the backend; mirrored in frontend/src/lib/wakePhrase.ts (renderer gate runs
// FIRST in wake_word mode — keep both in sync or turns die there) and in
// `_WAKE_TEXT_RE` of backend/voice/python/stt_service.py.
//
// 1. STRONG (anywhere) — the invented-word family. Whisper keeps the SHAPE of
//    "jarvis" (consonante + a/e + r + oclusiva + is) and swaps the initial
//    consonant, the fricative and the tail: garbis, garvis, jarbis, harvis,
//    yarvis, charvis, jervis, yardis, yardish, yardist, yaris… Generated from
//    the shape, never enumerated (enumerating always lagged reality; all of
//    these came out of journald). \b + closed suffix list keeps real words out:
//    yerba/garbo/jerbo/hervir/gervasio/yarda/jardín/jerez/jeringa/herida.
// 2. AMBIGUOUS (head only, JARVIS_HEAD_RE) — real Spanish strings Whisper snaps
//    to: "ya (lo) ves/veis/viste/oíste", "y ahora veis", "javier", "jared",
//    "jackie". Mid-sentence they are ordinary speech ("…que ya lo oíste" is not
//    an address), so they only count at the START of the utterance, after
//    optional fillers. Strictly MORE precise than the previous version, which
//    accepted "ya lo ves" anywhere.
//
// Todo se matchea sobre la forma SIN TILDES en minúsculas: `\b` solo entiende
// caracteres ASCII, así que sobre texto crudo "jardín" tenía frontera de palabra
// tras "jard" y entraba en la familia fuerte.
const WAKE_CONS = '(?:[jygh]|ch|ll)'
const WAKE_CORE = `${WAKE_CONS}[ae]r(?:[vbd](?:i(?:s|z|sh|st)?|es|s|e)?|i(?:s|z|sh|st)|es)`
const WAKE_AMBIG =
  'ya ?(?:lo )?(?:ve(?:is|s|z)|viste|oiste)|y ahora ve(?:is|s)|ja ?vier|jared|jackie'
const WAKE_FILLER =
  '(?:hola|oye|oiga|ok|okey|okay|hey|ey|eh|no|bueno|pues|mira|si|a ver|por cierto|perdon|disculpa)'

export const JARVIS_STRONG_RE = new RegExp(`\\b(?:${WAKE_CORE}|javis|arvis)\\b`, 'i')
export const JARVIS_HEAD_RE = new RegExp(
  `^[^a-z0-9]*(?:${WAKE_FILLER}[\\s,]+)*(?:${WAKE_CORE}|javis|arvis|${WAKE_AMBIG})\\b`,
  'i',
)
// `despi?ert\w*` (no trailing \b) porque la forma anclada `desp[ie]ert\b` era
// una rama MUERTA: ninguna conjugación real ("despierta", "despiértate",
// "despertar") termina en "despiert", así que nunca disparó.
const DESPIERTA_RE = /\bdespi?ert\w*/i

export function normalizeForWake(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

// Explicit wake phrase. In wake-word mode, naming Jarvis must always engage,
// even from PASSIVE — this overrides the score threshold entirely.
export function hasWakePhrase(text) {
  if (!text) return false
  const norm = normalizeForWake(text)
  return JARVIS_STRONG_RE.test(norm) || DESPIERTA_RE.test(norm) || JARVIS_HEAD_RE.test(norm)
}

const DIRECT_ADDRESS_RE = new RegExp(
  `^(?:dime|hazme|ponme|ayudame|muestrame|pon|apaga|enciende|abre|cierra)`,
  'i',
)
const QUESTION_RE = /\?$/
const SLEEP_COMMANDS = /\b(descansa|duerme|silencio|callate|no molestes)\b/i

// Self-modification of Jarvis's OWN source → delegated to a full Claude Code
// agent (devAgent.js), NOT to self_build (which only generates brand-new skill
// modules) and NOT to file_delicate (which is just a model bump for a chat turn).
// Mutating verbs only: "revisa/analiza tu código" stays a read-only chat turn.
const SELF_CODE_RE = /\b(modifica|cambia|edita|arregla|corrige|mejora|refactoriza|reescribe|actualiza|implementa|a[ñn]ade|agrega|quita|elimina|optimiza|ajusta|programa|desarrolla|escribe)\w*\b.{0,45}?\b(tu|su|el)\s+(propio\s+)?(c[oó]digo|backend|frontend|repositorio|repo)\b|\ben\s+tu\s+(propio\s+)?c[oó]digo\b|\b(modif[ií]cate|ed[ií]tate|reprogr[aá]mate|autodesarrollo)\b/i

const SELF_BUILD_RE = /\b(no\s+puedes|aprende\s+a\s+hacer|conf[ií]g[uú]rate\s+para|act[íi]vate\s+para|necesito\s+que\s+puedas|no\s+sabes\s+c[oó]mo|implementa\s+(la\s+)?capacidad|t[oó]ma(me)?\s+una\s+foto|saca(me)?\s+una\s+foto|haz(me)?\s+una\s+foto|con[eé]ctate\s+a\s+(mi\s+|la\s+)?c[aá]mara|usa\s+(mi\s+|la\s+)?c[aá]mara)\b/i
const ACTIVATE_SKILL_RE = /\b(activa\s+(la?\s+)?habilidad|activa\s+(el?\s+)?skill|habilita\s+(la?\s+)?funci[oó]n|enciende\s+(la?\s+)?habilidad)\b/i
const TOGGLE_GESTURES_RE = /\b(activa|desactiva|enciende|apaga)\s+(los?\s+)?gestos\b/i
const VOICE_MUTED_RE = /\b(no\s+escuches|ign[oó]ra(me)?|modo\s+silencio|silencio\s+de\s+voz)\b/i
const SET_VOICE_MODE_RE = /\b(modo\s+(siempre\s+activ[ao]|continuo|wake\s*word|palabra\s+de\s+activaci[oó]n|ptt|push\s+to\s+talk|empujar\s+para\s+hablar|apagado\s+de\s+voz|voz\s+apagada|desactiva\s+voz|apaga\s+(el\s+)?micr[oó]fono)|cambia\s+(el\s+)?modo\s+de\s+(voz|escucha)|pon\s+(te\s+en\s+modo|el\s+modo)\s+(siempre|wake|ptt|silencio|continuo))\b/i

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
  if (SELF_CODE_RE.test(text))      { console.log('[intent] -> self_code:', text);     return 'self_code' }
  if (SELF_BUILD_RE.test(text))     { console.log('[intent] -> self_build:', text);    return 'self_build' }
  if (ACTIVATE_SKILL_RE.test(text)) { console.log('[intent] -> activate_skill:', text); return 'activate_skill' }
  if (FILE_DELICATE_RE.test(text))  { console.log('[intent] -> file_delicate:', text);  return 'file_delicate' }
  if (COMPLEX_TASK_RE.test(text))   { console.log('[intent] -> complex_task:', text);   return 'complex_task' }
  if (TOGGLE_GESTURES_RE.test(text))  { console.log('[intent] -> toggle_gestures:', text);  return 'toggle_gestures' }
  if (SET_VOICE_MODE_RE.test(text))   { console.log('[intent] -> set_voice_mode:', text);   return 'set_voice_mode' }
  if (VOICE_MUTED_RE.test(text))      { console.log('[intent] -> voice_muted:', text);      return 'voice_muted' }
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
  if (DIRECT_ADDRESS_RE.test(norm) || JARVIS_HEAD_RE.test(norm)) score += 0.4

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

  // Explicit "jarvis" mention always boosts — including phonetic homophones
  // the STT mishears (javier, ya ves, jarbis...).
  if (hasWakePhrase(norm)) score += 0.3

  score = Math.min(Math.max(score, 0), 1.0)

  const threshold = THRESHOLDS[state] ?? THRESHOLDS.PASSIVE
  const intentTag = detectIntentTag(text)
  // Intent-tagged sentences should always trigger a response (override
  // threshold) — the user clearly addressed Jarvis with a task/note/query.
  const intentForce = intentTag !== 'chat'
  // Wake-word model: naming Jarvis always engages, even from PASSIVE.
  const isWake = hasWakePhrase(norm)
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
