// Bridge fillers ("dame un segundo", "estoy buscando") pre-rendered by the
// TTS service at install time and cached as decoded AudioBuffers in the
// browser. Playing one is instant — no synth latency — so we can mask the
// user-perceived wait while Claude + TTS work on the real reply.
//
// Classification is intentionally lightweight: regex on the recognized
// utterance, plus a length fallback. The aim is to fire a filler only when
// the user expects the assistant to "think" for a beat. Short commands
// ("apaga la luz") never trigger a filler because there's no perceived
// wait worth covering.

import { getSharedAudioContext } from './streamingTts'

const FILLER_NAMES = ['filler-think', 'filler-search', 'filler-second', 'filler-noted'] as const
export type FillerName = typeof FILLER_NAMES[number]

const cache = new Map<FillerName, AudioBuffer>()
let prewarmInflight: Promise<void> | null = null

export async function prewarmFillers(apiBase: string): Promise<void> {
  if (prewarmInflight) return prewarmInflight
  prewarmInflight = (async () => {
    const ctx = await getSharedAudioContext()
    await Promise.all(FILLER_NAMES.map(async (name) => {
      try {
        const res = await fetch(`${apiBase}/api/jarvis/filler?name=${encodeURIComponent(name)}`)
        if (!res.ok) return
        const ab = await res.arrayBuffer()
        const buf = await ctx.decodeAudioData(ab)
        cache.set(name, buf)
      } catch {
        // backend may not yet have rendered fillers — silently skip
      }
    }))
  })()
  return prewarmInflight
}

export interface FillerHandle {
  stop: () => void
}

export async function playFiller(name: FillerName): Promise<FillerHandle> {
  const ctx = await getSharedAudioContext()
  const buf = cache.get(name)
  if (!buf) return { stop: () => {} }
  const src = ctx.createBufferSource()
  src.buffer = buf
  const gain = ctx.createGain()
  gain.gain.value = 1.0
  src.connect(gain).connect(ctx.destination)
  src.start()
  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      const now = ctx.currentTime
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      // 80 ms fade-out so the handoff to the real reply isn't abrupt
      gain.gain.linearRampToValueAtTime(0.0001, now + 0.08)
      setTimeout(() => { try { src.stop() } catch {} }, 120)
    },
  }
}

const COMPLEX_PATTERNS: ReadonlyArray<{ re: RegExp; filler: FillerName }> = [
  { re: /\b(busca|investiga|encuentra|consulta|averigua|busca info|googlea)\b/i, filler: 'filler-search' },
  { re: /\b(qu[eé] piensas|qu[eé] opinas|explica|c[oó]mo funciona|por qu[eé]|qu[eé] es)\b/i, filler: 'filler-think' },
  { re: /\b(anota|guarda|crea (una )?tarea|recu[eé]rdame|recuerda esto|toma nota)\b/i, filler: 'filler-noted' },
]

export function classifyComplexity(text: string): FillerName | null {
  if (!text) return null
  const t = text.trim()
  if (t.length < 5) return null
  for (const { re, filler } of COMPLEX_PATTERNS) {
    if (re.test(t)) return filler
  }
  if (t.length > 80) return 'filler-second'
  return null
}
