/**
 * Barge-in: is this utterance ONLY an order to stop?
 *
 * Talking over Jarvis already cuts him off (AwakeApp aborts the in-flight turn).
 * But the interrupting phrase then became a brand-new turn, so "para" or
 * "cállate" was sent to the brain, which answered it — Jarvis stopped talking
 * just to start talking again ("De acuerdo, me detengo."). A bare stop command
 * must stop and stay quiet; anything with real content ("para, mejor pon un
 * temporizador") is still a new turn.
 *
 * Matched on the accent-less lowercase form, same trap as the wake phrase:
 * `\b` only understands ASCII.
 */

const STOP_WORD =
  '(?:para(?:le)?|parate|detente|deten(?:lo|te)?|espera|stop|callate|silencio|basta|ya\\s+basta|' +
  'cancela(?:lo)?|deja(?:lo)?|suficiente|ya\\s+esta|ya|no|alto|shh+|chito)'
const FILLER = '(?:jarvis|oye|ok|okay|bueno|vale|eh|ey|hey|porfa|por\\s+favor|ya|eso|ahi|ahora|gracias)'

const STOP_ONLY_RE = new RegExp(`^(?:${FILLER}\\s+)*${STOP_WORD}(?:\\s+(?:${STOP_WORD}|${FILLER}))*$`)

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the whole utterance is a stop order (with optional fillers). */
export function isStopOnly(text: string): boolean {
  const norm = normalizeUtterance(text)
  if (!norm) return false
  // A lone "no" / "ya" mid-conversation is usually an ANSWER, not a stop. Only
  // count those when they come with another stop word or a filler ("ya, Jarvis").
  if (norm === 'no' || norm === 'ya') return false
  return STOP_ONLY_RE.test(norm)
}
