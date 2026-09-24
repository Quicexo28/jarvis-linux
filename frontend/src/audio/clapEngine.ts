/**
 * Motor puro de detección de doble aplauso — sin WebAudio, sin React.
 *
 * Vive aparte del hook para poder testearlo en Node (mismo patrón que
 * `gestures/engine.ts`). El hook sólo aporta el AnalyserNode y el reloj.
 *
 * FIRMAS MEDIDAS DENTRO DEL WEBVIEW (watchdog `[clap-wd]`, 2026-08-04, micro
 * jarvis_aec_source a 44.1 kHz — son los números que ve ESTE código, no los de
 * un análisis offline):
 *
 *              rms        <1 kHz    2.7-8.3 kHz   espectro por octavos (media byte)
 *   aplauso:   0.43-0.68  0.14      0.60          236,210,139,0,0,0,0,0
 *   ruido/voz: 0.01-0.15  0.45-0.61 0.13          104,15,1,0,0,0,0,0
 *
 * OJO: el AEC de PipeWire (webrtc) procesa a 16 kHz, así que TODO lo que pasa
 * de ~8 kHz llega al webview en cero — los cuatro últimos octavos son siempre 0.
 * Por eso la planitud espectral NO sirve como gate aquí: en el dominio byte da
 * 0.09 para el aplauso y 0.18 en reposo, o sea al REVÉS de lo que predice la
 * teoría (un análisis offline del MISMO audio daba 0.98 vs 0.86). Si vuelves a
 * tocar esto, calibra con el watchdog dentro del webview, no con un script.
 *
 * GATES por frame (todos deben pasar para contar como onset):
 *   1. LOUD      — rms sobre el suelo de ruido Y sobre un piso absoluto.
 *   2. SHARP     — ataque casi instantáneo (frame actual >> anterior).
 *   3. AGUDOS    — la banda 2.7-8.3 kHz aporta >35% (el chasquido); la voz
 *                  apenas llega al 13%.
 *   4. NO GRAVE  — poca energía bajo 1 kHz (ahí vive la voz).
 * Y para el par:
 *   5. DECAY     — el PRIMER aplauso debe caer al 25% de su pico en <=200 ms.
 *                  Se valida mientras se espera al segundo → gratis en latencia.
 *   6. SIMILITUD — coseno entre ambos espectros >= 0.80 (dos palmas de la misma
 *                  persona, no un golpe seguido de un ruido cualquiera).
 *
 * El disparo ocurre en el SEGUNDO onset (no tras su cola) → baja latencia e
 * inmune a la reverberación. Un refractario tras cada onset evita que la cola
 * del propio aplauso cuente como el siguiente.
 *
 * NO hay gate de CREST FACTOR: un aplauso cercano SATURA el micro (peak = 1.0,
 * 8-24% de muestras clippeadas) y su crest cae a 1.5-2.2, por debajo del 2.5 que
 * exigía la v1 — cuanto MÁS fuerte el aplauso, más seguro lo rechazaba. Con la
 * v1 medida sobre esa misma captura: 1 de 3 dobles detectados en el micro crudo,
 * y 2 dobles FALSOS con sólo voz en la fuente AEC. No lo re-introduzcas.
 */

export interface ClapConfig {
  noiseAlpha: number
  transientRatio: number
  absMinRms: number
  riseRatio: number
  lowBandHz: number
  lowBandMax: number
  highBandHz: number
  highBandMin: number
  decayMs: number
  decayRatio: number
  similarityMin: number
  refractoryMs: number
  minGapMs: number
  maxGapMs: number
  cooldownMs: number
}

export const CLAP_DEFAULTS: ClapConfig = {
  noiseAlpha: 0.01,      // EMA del suelo de ruido — se adapta a la sala en ~1 s
  transientRatio: 6,     // LOUD: rms > 6× suelo
  absMinRms: 0.25,       // LOUD: piso absoluto — la fuente AEC deja el suelo en
                         // ~0.001 y sin esto cualquier ruidito supera el ratio.
                         // Aplauso medido 0.37-0.68; ruido/voz de sala ≤ 0.15.
  riseRatio: 2.5,        // SHARP: rms[t] / rms[t-1]
  lowBandHz: 1000,
  lowBandMax: 0.35,      // NO GRAVE: <1 kHz aporta 0.14 en aplauso, 0.45+ en voz
  highBandHz: 2700,
  highBandMin: 0.35,     // AGUDOS: 2.7-8.3 kHz aporta ~0.60 en aplauso, ~0.13 en voz
  decayMs: 200,
  decayRatio: 0.25,
  similarityMin: 0.8,
  refractoryMs: 150,
  minGapMs: 200,
  maxGapMs: 1000,
  cooldownMs: 1500,
}

export interface ClapFrame {
  /** RMS del frame en el dominio del tiempo, 0..1. */
  rms: number
  /** Espectro tal cual lo entrega `AnalyserNode.getByteFrequencyData`. */
  freq: Uint8Array
  /** Reloj monótono en ms (`performance.now()`). */
  now: number
}

export type ClapEvent =
  | { type: 'none' }
  | { type: 'onset'; highShare: number; lowShare: number; rms: number }
  | { type: 'double'; gapMs: number; similarity: number }
  | { type: 'rejected'; reason: 'sustained' | 'gap' | 'similarity'; detail: number }

/**
 * Planitud espectral = media geométrica / media aritmética. Sólo se usa para
 * telemetría de calibración: como gate NO sirve con el audio del AEC (ver nota
 * de cabecera).
 */
export function spectralFlatness(freq: Uint8Array): number {
  let logSum = 0, linSum = 0
  const n = freq.length
  if (n === 0) return 0
  for (let i = 0; i < n; i++) {
    const v = freq[i] + 1 // +1 evita log(0)
    logSum += Math.log(v)
    linSum += v
  }
  return Math.exp(logSum / n) / (linSum / n)
}

/** Fracción del espectro que cae por debajo de `lowBins`. */
export function lowBandShare(freq: Uint8Array, lowBins: number): number {
  let low = 0, total = 0
  for (let i = 0; i < freq.length; i++) {
    total += freq[i]
    if (i < lowBins) low += freq[i]
  }
  return total > 0 ? low / total : 0
}

/** Fracción del espectro por encima de `highBins` — el chasquido del aplauso. */
export function highBandShare(freq: Uint8Array, highBins: number): number {
  let high = 0, total = 0
  for (let i = 0; i < freq.length; i++) {
    total += freq[i]
    if (i >= highBins) high += freq[i]
  }
  return total > 0 ? high / total : 0
}

/** Coseno entre dos espectros — 1 = misma forma espectral. */
export function cosineSimilarity(a: Uint8Array, b: Uint8Array): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na  += a[i] * a[i]
    nb  += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

export class ClapEngine {
  private cfg: ClapConfig
  private lowBins: number
  private highBins: number
  private noiseFloor = 0.01
  private prevRms = 0
  private pending: { at: number; rms: number; spec: Uint8Array; decayed: boolean } | null = null
  private refractoryUntil = 0
  private cooldownUntil = 0

  /**
   * `lowBins`/`highBins` = índice del bin que corresponde a `lowBandHz` y
   * `highBandHz`; el hook los deriva del sampleRate real del AudioContext.
   */
  constructor(lowBins: number, highBins: number, cfg: Partial<ClapConfig> = {}) {
    this.cfg = { ...CLAP_DEFAULTS, ...cfg }
    this.lowBins = Math.max(1, lowBins)
    this.highBins = Math.max(this.lowBins + 1, highBins)
  }

  /** Suspende la detección hasta `now + ms` (p.ej. mientras Jarvis habla). */
  suppressUntil(nowPlusMs: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, nowPlusMs)
  }

  push({ rms, freq, now }: ClapFrame): ClapEvent {
    const cfg = this.cfg

    // El suelo de ruido sólo se adapta en frames tranquilos: así un aplauso
    // nunca lo envenena hacia arriba.
    if (rms < this.noiseFloor * 2.5) {
      this.noiseFloor = this.noiseFloor * (1 - cfg.noiseAlpha) + rms * cfg.noiseAlpha
    }
    this.noiseFloor = Math.max(this.noiseFloor, 0.001)

    let event: ClapEvent = { type: 'none' }

    // La caída del primer aplauso se vigila SIEMPRE, también dentro del
    // refractario: es justo cuando ocurre (80-120 ms tras el pico).
    if (this.pending && !this.pending.decayed) {
      if (rms < this.pending.rms * cfg.decayRatio) {
        this.pending.decayed = true
      } else if (now - this.pending.at > cfg.decayMs) {
        event = { type: 'rejected', reason: 'sustained', detail: rms / this.pending.rms }
        this.pending = null
      }
    }
    if (this.pending && now - this.pending.at > cfg.maxGapMs) this.pending = null

    if (now < this.cooldownUntil || now < this.refractoryUntil) {
      this.prevRms = rms
      return event
    }

    const isLoud = rms > Math.max(this.noiseFloor * cfg.transientRatio, cfg.absMinRms)
    // Salir de un silencio casi total cuenta como ataque aunque el ratio quede
    // enturbiado por un frame anterior a medio llenar.
    const isSharp = this.prevRms < this.noiseFloor * 2 ||
                    rms / Math.max(this.prevRms, 1e-6) > cfg.riseRatio
    const lowShare = lowBandShare(freq, this.lowBins)
    const highShare = highBandShare(freq, this.highBins)

    if (!(isLoud && isSharp && lowShare < cfg.lowBandMax && highShare > cfg.highBandMin)) {
      this.prevRms = rms
      return event
    }

    if (this.pending && this.pending.decayed) {
      const gap = now - this.pending.at
      const sim = cosineSimilarity(this.pending.spec, freq)
      if (gap < cfg.minGapMs || gap > cfg.maxGapMs) {
        event = { type: 'rejected', reason: 'gap', detail: gap }
      } else if (sim < cfg.similarityMin) {
        event = { type: 'rejected', reason: 'similarity', detail: sim }
      } else {
        this.pending = null
        this.cooldownUntil = now + cfg.cooldownMs
        this.refractoryUntil = now + cfg.refractoryMs
        this.prevRms = rms
        return { type: 'double', gapMs: gap, similarity: sim }
      }
    }

    // Primer aplauso de un par (posiblemente nuevo). El espectro se copia:
    // el buffer del analyser se reescribe en cada frame.
    this.pending = { at: now, rms, spec: new Uint8Array(freq), decayed: false }
    this.refractoryUntil = now + cfg.refractoryMs
    this.prevRms = rms
    return event.type === 'none' ? { type: 'onset', highShare, lowShare, rms } : event
  }
}
