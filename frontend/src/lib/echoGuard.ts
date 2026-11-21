// Detección de auto-eco por CONTENIDO.
//
// La confianza del hablante no separa el eco de Jarvis del dueño (la voz está
// clonada). Se miran las palabras NOVEDOSAS: las que el micro oyó y Jarvis no
// acaba de decir. Eco puro = cero novedosas. Si el dueño habla encima, el
// transcrito es una mezcla, pero sus palabras siguen siendo novedosas; por eso
// se cuentan en absoluto y no como proporción.

export function normalizeForEcho(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Una sola palabra de estas cuenta como interrupción real aunque quede por
// debajo del mínimo de palabras novedosas.
const INTERRUPT_WORDS = new Set([
  'para', 'parate', 'detente', 'espera', 'stop', 'callate', 'silencio',
  'jarvis', 'oye', 'no', 'cancela',
])

/** true = es habla real (interrupción válida), false = eco puro de Jarvis. */
export function hasRealSpeech(transcript: string, spokenNormalized: string): boolean {
  const words = normalizeForEcho(transcript).split(' ').filter(Boolean)
  if (words.length === 0) return false
  // Nada dicho ⇒ nada de lo que ser eco.
  if (!spokenNormalized) return true
  const spoken = new Set(spokenNormalized.split(' '))
  let novel = 0
  let hasCommand = false
  for (const w of words) {
    if (!spoken.has(w)) {
      novel++
      if (INTERRUPT_WORDS.has(w)) hasCommand = true
    }
  }
  return novel >= 2 || hasCommand
}
