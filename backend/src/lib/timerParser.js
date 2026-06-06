/**
 * Natural-language parser for timer / chrono voice commands.
 *
 * Two paths: a fast regex-only parser for the common cases (covers
 * "pon temporizador de 10 minutos", "pausa el timer", "agrega 5 minutos",
 * "cancela el cronómetro"), and a Claude haiku fallback for anything weird.
 * The regex path is preferred because it's instant — voice latency matters.
 */

import { runClaude } from './claudeCli.js'

const NUM_WORDS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, noventa: 90,
}

function parseNumber(token) {
  if (!token) return null
  const n = Number(token)
  if (!isNaN(n)) return n
  const norm = token.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  return NUM_WORDS[norm] ?? null
}

// Extract a duration in milliseconds from a phrase like "10 minutos", "media hora",
// "una hora y veinte", "2 horas 30", "45 segundos", "1.5 horas".
export function extractDurationMs(text) {
  const norm = text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
  if (/\bmedia\s+hora\b/.test(norm)) return 30 * 60_000
  if (/\bun\s+cuarto\s+de\s+hora\b/.test(norm)) return 15 * 60_000
  if (/\bhora\s+y\s+media\b/.test(norm)) return 90 * 60_000

  let totalMs = 0
  let matched = false

  // "1 hora 20 minutos", "dos horas y treinta minutos", "1.5 horas".
  const hourMatches = [...norm.matchAll(/(\d+(?:[.,]\d+)?|\b[a-z]+\b)\s*horas?/g)]
  for (const m of hourMatches) {
    const n = parseNumber(m[1].replace(',', '.'))
    if (n != null) { totalMs += Math.round(n * 3_600_000); matched = true }
  }
  const minMatches = [...norm.matchAll(/(\d+|\b[a-z]+\b)\s*minutos?/g)]
  for (const m of minMatches) {
    const n = parseNumber(m[1])
    if (n != null) { totalMs += n * 60_000; matched = true }
  }
  const secMatches = [...norm.matchAll(/(\d+|\b[a-z]+\b)\s*(segundos?|seg)\b/g)]
  for (const m of secMatches) {
    const n = parseNumber(m[1])
    if (n != null) { totalMs += n * 1_000; matched = true }
  }
  return matched ? totalMs : null
}

// Extract a label after "para", "de la|el", "llamado", "etiqueta". Strips
// surrounding articles / fillers so "para la pasta" -> "pasta".
export function extractLabel(text, kind /* 'timer'|'chrono' */) {
  const norm = text.toLowerCase()
  // Non-capturing subject group so the only capture is the label itself —
  // otherwise m[1] is the subject word and the label slot becomes m[2].
  const subject = kind === 'chrono' ? '(?:cron[oó]metro)' : '(?:temporizador|timer|alarma|cuenta\\s+regresiva)'
  const candidates = [
    new RegExp(`para\\s+(?:la|el|los|las)\\s+([a-zñáéíóú][a-zñáéíóú0-9\\s]{1,30})`, 'i'),
    new RegExp(`(?:llamad[oa]|etiquetad[oa])\\s+(?:la|el|los|las)?\\s*([a-zñáéíóú][a-zñáéíóú0-9\\s]{1,30})`, 'i'),
    new RegExp(`${subject}\\s+(?:de\\s+)?(?:la|el|los|las)\\s+([a-zñáéíóú][a-zñáéíóú0-9\\s]{1,30})`, 'i'),
  ]
  for (const re of candidates) {
    const m = norm.match(re)
    if (m && m[1]) {
      const clean = m[1]
        // Strip filler words and any leading duration ("5 minutos para la pasta").
        .replace(/\b(de|del|en|por|y|con|para|el|la|los|las|un|una|unos|unas)\b/g, ' ')
        .replace(/\d+\s*(minutos?|horas?|segundos?|seg)?/g, ' ')
        .replace(/\b(minutos?|horas?|segundos?|seg)\b/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
      if (clean && clean.length >= 2 && clean.length <= 32) return clean
    }
  }
  return null
}

// Map verb keywords to canonical actions. Note we deliberately omit bare
// "para" / "paralo" — the Spanish preposition "para" collides with phrases
// like "para la pasta", flipping starts into pauses. We rely on "pausa",
// "pausalo", "detente", "stop" for unambiguous pause intent.
const ACTION_MAP = [
  { re: /\b(pausa(r|lo|la|me)?|p[aá]usa(lo|la|me)?|det[eé]n(lo|la|te|me)?|stop)\b/i, action: 'pause' },
  { re: /\b(reanud(a|ar)|continu(a|ar)|resume|sigue)\b/i, action: 'resume' },
  { re: /\b(agrega|a[ñn]ade|suma|aumenta|extiende|al[aá]rga(lo|la|me)?)\b/i, action: 'add' },
  { re: /\b(cancela(r)?|elimina(r)?|borra(r)?|quita(r)?|qu[ií]tame)\b/i, action: 'cancel' },
  { re: /\b(reinici(a|ar)|resetea(r)?|reset)\b/i, action: 'reset' },
  { re: /\b(marca\s+vuelta|lap|vuelta\s+nueva)\b/i, action: 'lap' },
  { re: /\b(pon(me|le)?|inicia(r)?|empieza(r)?|arranca(r)?|comienza(r)?|crea(r)?|nuevo|nueva|activa(r)?|abre|prende|echa\s+a\s+andar)\b/i, action: 'start' },
]

function detectAction(text) {
  for (const { re, action } of ACTION_MAP) {
    if (re.test(text)) return action
  }
  return 'start' // default — most utterances are starts
}

/**
 * Parse a timer voice command.
 * Returns { action, label, durationMs?, deltaMs? } or null if unparseable.
 *
 * action ∈ 'start' | 'pause' | 'resume' | 'add' | 'cancel' | 'reset'
 */
export async function parseTimerCommand(text) {
  const action = detectAction(text)
  const label = extractLabel(text, 'timer')
  const duration = extractDurationMs(text)

  if (action === 'start') {
    if (duration && duration >= 1000) return { action, label, durationMs: duration }
    // Try Claude haiku as fallback when no number found.
    const ai = await aiParseTimer(text).catch(() => null)
    if (ai && ai.durationMs && ai.durationMs >= 1000) {
      return { action: 'start', label: ai.label ?? label, durationMs: ai.durationMs }
    }
    return null
  }

  if (action === 'add') {
    if (duration && duration >= 1000) return { action, label, deltaMs: duration }
    return null
  }

  // pause/resume/cancel/reset don't need a duration.
  return { action, label }
}

/**
 * Parse a chronometer voice command.
 * Returns { action, label } — chrono never has a duration.
 *
 * action ∈ 'start' | 'pause' | 'resume' | 'reset' | 'lap' | 'cancel'
 */
export function parseChronoCommand(text) {
  const action = detectAction(text)
  const label = extractLabel(text, 'chrono')
  return { action, label }
}

const AI_SYSTEM = `Eres un parser de comandos de temporizador. Recibes una frase en español
y devuelves SOLO JSON con esta forma: {"durationMs": number, "label": string|null}.
- "durationMs": duración total en milisegundos. Si dice "media hora" → 1800000.
- "label": breve etiqueta (objeto/actividad), o null si no se menciona.
Si no encuentras una duración, devuelve {"error":"no_duration"}.`

async function aiParseTimer(text) {
  const raw = await runClaude(`Frase: "${text}"`, {
    systemPromptText: AI_SYSTEM,
    timeoutMs: 8000,
    model: 'haiku',
    fallbackReply: '',
    namespace: 'jarvis-timer-parser',
  })
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  let obj
  try { obj = JSON.parse(m[0]) } catch { return null }
  if (obj.error) return null
  const ms = Number(obj.durationMs)
  if (!ms || ms < 1000) return null
  return { durationMs: ms, label: obj.label && typeof obj.label === 'string' ? obj.label : null }
}
