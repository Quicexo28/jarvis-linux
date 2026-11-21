/**
 * Natural-language parser for timer / chrono voice commands.
 *
 * Solo extracción por regex (instantánea: la latencia de voz importa):
 * duración ("10 minutos", "media hora") y etiqueta del temporizador/cronómetro.
 */

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
