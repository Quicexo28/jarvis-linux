// Split a long TTS sentence into clause-sized pieces.
//
// edge-tts time-to-first-byte grows with the text length, and on a cold
// connection a 180-char sentence took >4 s before ANY audio (measured
// 2026-09-24) — long enough to leave dead air or trip the stall watchdog.
// Short clauses come back in ~1 s, the prefetch pipeline keeps the next one
// synthesized while the current one plays, and a stalled clause loses a few
// words instead of a whole sentence.
//
// Splits only at clause punctuation FOLLOWED BY A SPACE, so decimal commas
// ("1,5") and times ("9:30") stay intact. Pieces shorter than MIN_CHARS are
// merged with their neighbour so the prosody doesn't turn choppy.

const MAX_CHARS = 90
const MIN_CHARS = 30
const CLAUSE_RE = /(?<=[,;:—–])\s+/

export function splitForTts(text, { max = MAX_CHARS, min = MIN_CHARS } = {}) {
  const t = String(text ?? '').trim()
  if (t.length <= max) return t ? [t] : []
  const parts = t.split(CLAUSE_RE).map(s => s.trim()).filter(Boolean)
  const out = []
  let cur = ''
  for (const p of parts) {
    if (!cur) { cur = p; continue }
    if (cur.length < min || (cur.length + 1 + p.length <= max && p.length < min)) {
      cur = `${cur} ${p}`
    } else {
      out.push(cur)
      cur = p
    }
  }
  if (cur) {
    // A short tail reads better attached to the previous clause.
    if (out.length && cur.length < min) out[out.length - 1] = `${out[out.length - 1]} ${cur}`
    else out.push(cur)
  }
  return out
}
