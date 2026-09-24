/**
 * Wake phrase matching for the renderer.
 *
 * MIRROR of the same block in backend/src/lib/intentClassifier.js (and of
 * `_WAKE_TEXT_RE` in backend/voice/python/stt_service.py). In voiceMode
 * 'wake_word' the renderer gates the transcript BEFORE it ever reaches the
 * backend, so a narrower regex here silently swallows turns the backend would
 * have accepted (that's how "Garbis, está conectado a Spotify" and "Ya lo
 * veis" were lost). Keep the three in sync.
 *
 * TWO TIERS, because the two failure modes pull in opposite directions:
 *
 * 1. STRONG (`JARVIS_STRONG_RE`, matches ANYWHERE) — the invented-word family.
 *    Whisper keeps the SHAPE of "jarvis" (consonante + a/e + r + oclusiva +
 *    cola) and swaps the initial consonant, the fricative and the tail:
 *    jarvis, garbis, garvis, jarbis, harvis, yarvis, charvis, jervis, yardis,
 *    yardish, yardist, yaris… Generated from the shape, never enumerated —
 *    enumerating always lagged reality. The suffix list is CLOSED and the
 *    whole thing is \b-anchored, so real Spanish words that share the prefix
 *    (yerba, garbo, jerbo, hervir, gervasio, yarda, jardín, jerez, jeringa,
 *    herida, gerente) do NOT match.
 *
 * 2. AMBIGUOUS (`JARVIS_HEAD_RE`, only at the START of the utterance) — the
 *    real Spanish strings Whisper snaps to: "ya (lo) ves/veis/viste/oíste",
 *    "y ahora veis", "javier", "jared", "jackie". These are ordinary phrases
 *    mid-sentence ("tal vez de su nombre que ya lo oíste" is NOT an address),
 *    so accepting them anywhere would wake Jarvis on normal speech. Anchoring
 *    them to the head (after optional fillers: hola, oye, ok, no, bueno…) is
 *    where a wake word actually lives, and it is STRICTLY more precise than
 *    the previous version, which matched "ya lo ves" anywhere.
 *
 * Matching runs on the ACCENT-STRIPPED lowercase form: `\b` only knows ASCII
 * word chars, so on raw text "jardín" ended at a word boundary after "jard"
 * and matched the strong family.
 */

const CONS = '(?:[jygh]|ch|ll)'
// consonante + a/e + r + (oclusiva sonora + cola) | (cola sola, p.ej. "yaris")
const CORE = `${CONS}[ae]r(?:[vbd](?:i(?:s|z|sh|st)?|es|s|e)?|i(?:s|z|sh|st)|es)`
const AMBIG =
  'ya ?(?:lo )?(?:ve(?:is|s|z)|viste|oiste)|y ahora ve(?:is|s)|ja ?vier|jared|jackie'
// Muletillas que preceden al nombre sin romper el anclaje a cabeza.
const FILLER =
  '(?:hola|oye|oiga|ok|okey|okay|hey|ey|eh|no|bueno|pues|mira|si|a ver|por cierto|perdon|disculpa)'

/** Familia inventada por Whisper: vale en cualquier posición del enunciado. */
export const JARVIS_STRONG_RE = new RegExp(`\\b(?:${CORE}|javis|arvis)\\b`, 'i')

/** Nombre (fuerte o ambiguo) al PRINCIPIO, tras muletillas y signos de apertura. */
export const JARVIS_HEAD_RE = new RegExp(
  `^[^a-z0-9]*(?:${FILLER}[\\s,]+)*(?:${CORE}|javis|arvis|${AMBIG})\\b`,
  'i',
)

// `despi?[eé]rt\w*` sin \b final: la forma anclada `desp[ie]ert\b` era una rama
// muerta (ninguna conjugación real termina en "despiert").
const DESPIERTA_RE = /\bdespi?ert\w*/i

/** Forma canónica para matchear: sin tildes, en minúsculas, misma longitud. */
export function normalizeForWake(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Tramo del enunciado ocupado por el nombre, o `null` si no hay wake. */
function matchWake(norm: string): RegExpExecArray | null {
  return JARVIS_HEAD_RE.exec(norm) ?? JARVIS_STRONG_RE.exec(norm) ?? DESPIERTA_RE.exec(norm)
}

export function hasWakePhrase(text: string): boolean {
  if (!text) return false
  return matchWake(normalizeForWake(text)) !== null
}

/**
 * Quita el nombre del enunciado dejando el comando. El tier ambiguo solo se
 * quita en cabeza (donde se aceptó), el fuerte en cualquier posición. El corte
 * se hace por índice sobre el texto ORIGINAL: quitar tildes preserva longitud
 * (NFC → base + marca → base), así que los offsets coinciden; si por lo que sea
 * no coinciden, se devuelve el texto intacto en vez de cortar por el sitio malo.
 */
export function stripWakePhrase(text: string): string {
  const norm = normalizeForWake(text)
  const m = matchWake(norm)
  if (!m || norm.length !== text.length) return text.trim()
  const out = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)
  return out.replace(/\s+/g, ' ').replace(/^[\s,.;:!?¡¿-]+/, '').trim()
}
