import { describe, it, expect } from 'vitest'
import { ClapEngine, CLAP_DEFAULTS, lowBandShare, highBandShare, cosineSimilarity } from './clapEngine'

const BINS = 256
const LOW_BINS = 12  // ≈1 kHz con fftSize 512 @ 44.1 kHz
const HIGH_BINS = 31 // ≈2.7 kHz

// Espectros calcados de las medidas reales del webview (ver cabecera de
// clapEngine.ts): por octavos, aplauso ≈ 236,210,139,0.. y voz ≈ 104,15,1,0..
function specFromOctaves(oct: number[]): Uint8Array {
  const s = new Uint8Array(BINS)
  for (let i = 0; i < BINS; i++) s[i] = oct[Math.floor(i / 32)] ?? 0
  return s
}

/** Aplauso: energía repartida hasta ~8 kHz. */
function clapSpec(gain = 1): Uint8Array {
  return specFromOctaves([236, 210, 139, 0, 0, 0, 0, 0].map((v) => Math.round(v * gain)))
}

/** Voz: casi todo bajo 1 kHz, con cola hasta ~4 kHz (low≈0.58, high≈0.14). */
function voiceSpec(): Uint8Array {
  const s = new Uint8Array(BINS)
  for (let i = 0; i < BINS; i++) {
    s[i] = i < LOW_BINS ? 200 : i < 32 ? 60 : i < 64 ? 15 : i < 96 ? 1 : 0
  }
  return s
}

const SILENCE = new Uint8Array(BINS)

interface Frame { rms: number; freq: Uint8Array }

/** Bombea frames de 10 ms y devuelve todos los eventos con su instante. */
function feed(engine: ClapEngine, frames: Frame[], startMs = 0) {
  const events: { t: number; ev: ReturnType<ClapEngine['push']> }[] = []
  frames.forEach((f, i) => {
    const now = startMs + i * 10
    const ev = engine.push({ rms: f.rms, freq: f.freq, now })
    if (ev.type !== 'none') events.push({ t: now, ev })
  })
  return events
}

const quiet = (n: number): Frame[] =>
  Array.from({ length: n }, () => ({ rms: 0.004, freq: SILENCE }))

/** Un aplauso: pico agudo + cola que decae en ~80 ms. */
const clap = (peak = 0.55): Frame[] => [
  { rms: peak, freq: clapSpec() },
  { rms: peak * 0.5, freq: clapSpec(0.8) },
  { rms: peak * 0.2, freq: clapSpec(0.6) },
  { rms: peak * 0.08, freq: clapSpec(0.35) },
  ...quiet(4),
]

describe('features', () => {
  it('la banda 2.7-8 kHz separa aplauso de voz', () => {
    expect(highBandShare(clapSpec(), HIGH_BINS)).toBeGreaterThan(0.5)
    expect(highBandShare(voiceSpec(), HIGH_BINS)).toBeLessThan(0.2)
  })

  it('el reparto grave separa voz de aplauso', () => {
    expect(lowBandShare(voiceSpec(), LOW_BINS)).toBeGreaterThan(0.5)
    expect(lowBandShare(clapSpec(), LOW_BINS)).toBeLessThan(0.2)
  })

  it('el coseno ignora la escala pero no la forma', () => {
    // Dos aplausos (mismo espectro, distinto nivel) ≈ 1; aplauso vs voz cae por
    // debajo del umbral de emparejado (0.80), aunque no a cero: ambos comparten
    // los bins graves.
    expect(cosineSimilarity(clapSpec(1), clapSpec(0.4))).toBeCloseTo(1, 3)
    expect(cosineSimilarity(clapSpec(), voiceSpec())).toBeLessThan(CLAP_DEFAULTS.similarityMin)
  })
})

describe('ClapEngine', () => {
  it('detecta un doble aplauso con separación humana', () => {
    const e = new ClapEngine(LOW_BINS, HIGH_BINS)
    const events = feed(e, [
      ...quiet(120),          // deja que el suelo de ruido se asiente
      ...clap(),              // primer aplauso
      ...quiet(32),           // ~400 ms de hueco
      ...clap(),              // segundo aplauso
      ...quiet(20),
    ])
    const doubles = events.filter((x) => x.ev.type === 'double')
    expect(doubles).toHaveLength(1)
    const ev = doubles[0].ev as { gapMs: number; similarity: number }
    expect(ev.gapMs).toBeGreaterThanOrEqual(200)
    expect(ev.gapMs).toBeLessThanOrEqual(1000)
    expect(ev.similarity).toBeGreaterThan(0.9)
  })

  it('ignora la voz por fuerte que sea', () => {
    const e = new ClapEngine(LOW_BINS, HIGH_BINS)
    const speech: Frame[] = Array.from({ length: 200 }, (_, i) => ({
      rms: 0.2 + 0.4 * Math.abs(Math.sin(i / 3)), // sílabas, más fuerte que el aplauso
      freq: voiceSpec(),
    }))
    const events = feed(e, [...quiet(120), ...speech])
    expect(events.filter((x) => x.ev.type === 'double')).toHaveLength(0)
    expect(events.filter((x) => x.ev.type === 'onset')).toHaveLength(0)
  })

  it('descarta un ruido de banda ancha SOSTENIDO (no cae)', () => {
    const e = new ClapEngine(LOW_BINS, HIGH_BINS)
    const sustained: Frame[] = Array.from({ length: 60 }, () => ({ rms: 0.55, freq: clapSpec() }))
    const events = feed(e, [...quiet(120), ...sustained, ...quiet(10), ...clap()])
    expect(events.filter((x) => x.ev.type === 'double')).toHaveLength(0)
    expect(events.some((x) => x.ev.type === 'rejected' && x.ev.reason === 'sustained')).toBe(true)
  })

  it('no empareja aplausos demasiado separados', () => {
    const e = new ClapEngine(LOW_BINS, HIGH_BINS)
    const events = feed(e, [...quiet(120), ...clap(), ...quiet(150), ...clap(), ...quiet(10)])
    expect(events.filter((x) => x.ev.type === 'double')).toHaveLength(0)
  })

  it('no empareja dos golpes con espectros distintos', () => {
    const e = new ClapEngine(LOW_BINS, HIGH_BINS)
    // Golpe con espectro muy distinto (todo en 2.7-5.5 kHz) que aun así pasa los
    // gates de banda: sólo la similitud puede rechazarlo.
    const treble = specFromOctaves([30, 250, 20, 0, 0, 0, 0, 0])
    const other: Frame[] = [
      { rms: 0.55, freq: treble },
      { rms: 0.05, freq: treble },
      ...quiet(6),
    ]
    const events = feed(e, [...quiet(120), ...clap(), ...quiet(32), ...other])
    expect(events.filter((x) => x.ev.type === 'double')).toHaveLength(0)
    expect(events.some((x) => x.ev.type === 'rejected' && x.ev.reason === 'similarity')).toBe(true)
  })

  it('respeta el cooldown tras disparar', () => {
    const e = new ClapEngine(LOW_BINS, HIGH_BINS)
    const events = feed(e, [
      ...quiet(120),
      ...clap(), ...quiet(32), ...clap(),   // dispara
      ...quiet(20),
      ...clap(), ...quiet(32), ...clap(),   // dentro del cooldown de 1.5 s
      ...quiet(10),
    ])
    expect(events.filter((x) => x.ev.type === 'double')).toHaveLength(1)
  })

  it('suppressUntil silencia la detección mientras habla Jarvis', () => {
    const e = new ClapEngine(LOW_BINS, HIGH_BINS)
    feed(e, quiet(120))
    e.suppressUntil(120 * 10 + 2000)
    const events = feed(e, [...clap(), ...quiet(32), ...clap(), ...quiet(10)], 1200)
    expect(events.filter((x) => x.ev.type === 'double')).toHaveLength(0)
  })
})
