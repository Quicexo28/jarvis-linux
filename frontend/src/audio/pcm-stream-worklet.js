// AudioWorklet that plays Float32 PCM pushed in via postMessage.
//
// Maintains a flat Float32 ring buffer. process() pulls from it at the
// device sample rate. On underrun it outputs silence (so the audio clock
// keeps running instead of glitching) and counts the event so the host can
// log/react.
//
// Optional adaptive playback rate (0.97x–1.02x via linear interpolation)
// keeps the buffer in a healthy range: slow down slightly when buffer is
// low, speed up slightly when buffer is overfilling. ±2% rate change is
// inaudible (pitch shift < quarter-tone, masked by speech formants).

// TTS arrives ~5x faster than real time (edge RTF ~0.18) but plays at 1x, so
// the buffer must hold the WHOLE reply. A 4 s ring overflowed on long answers
// and dropped unplayed audio, cramming words together ("dice todo a la vez").
const RING_SECONDS = 60
const STATS_EVERY = 8 // post stats every N render quanta (~21 ms at 48 kHz with 128-sample quanta)
const TARGET_BUFFER_MS = 150
const LOW_BUFFER_MS = 60
const HIGH_BUFFER_MS = 300
const MIN_RATE = 0.97
const MAX_RATE = 1.00 // one-sided: only slow down on underrun, never speed up (avoids shaving start-of-phrase audio when buffer is full)
const RATE_SMOOTH = 0.05 // exponential smoothing toward target rate

class PcmStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    const cap = Math.ceil(sampleRate * RING_SECONDS)
    this.buf = new Float32Array(cap)
    this.cap = cap
    this.write = 0
    this.read = 0
    this.available = 0
    this.readFrac = 0
    this.rate = 1.0
    this.ended = false
    // Playback gate. The node is connected to the output immediately so the
    // processor runs and buffers incoming frames, but it emits silence until it
    // receives '__play__'. This lets us pipeline sentences: synthesize N+1 into
    // its buffer while N plays, then release it the instant N ends — gapless,
    // without relying on an unconnected node (which Chromium won't service).
    this.playing = false
    this.underrunCount = 0
    this.totalWritten = 0
    this.totalRead = 0
    this.tick = 0
    this.port.onmessage = (e) => {
      const msg = e.data
      if (msg === '__end__') {
        this.ended = true
        return
      }
      if (msg === '__play__') {
        this.playing = true
        return
      }
      if (msg instanceof Float32Array) {
        this.push(msg)
      }
    }
  }

  push(samples) {
    const n = samples.length
    if (n === 0) return
    if (this.available + n > this.cap) {
      // overflow guard — drop oldest samples to fit (should never happen in
      // practice with 4s ring and worst-case XTTS bursts).
      const drop = this.available + n - this.cap
      this.read = (this.read + drop) % this.cap
      this.available -= drop
    }
    const tail = this.cap - this.write
    if (n <= tail) {
      this.buf.set(samples, this.write)
    } else {
      this.buf.set(samples.subarray(0, tail), this.write)
      this.buf.set(samples.subarray(tail), 0)
    }
    this.write = (this.write + n) % this.cap
    this.available += n
    this.totalWritten += n
  }

  sampleAt(offset) {
    const idx = (this.read + offset) % this.cap
    return this.buf[idx]
  }

  pickRate() {
    const bufMs = (this.available / sampleRate) * 1000
    let target
    if (bufMs < LOW_BUFFER_MS) target = MIN_RATE
    else if (bufMs > HIGH_BUFFER_MS) target = MAX_RATE
    else {
      // linear blend from MIN_RATE at LOW to MAX_RATE at HIGH; nominal 1.0 at TARGET
      if (bufMs < TARGET_BUFFER_MS) {
        const t = (bufMs - LOW_BUFFER_MS) / (TARGET_BUFFER_MS - LOW_BUFFER_MS)
        target = MIN_RATE + (1.0 - MIN_RATE) * t
      } else {
        const t = (bufMs - TARGET_BUFFER_MS) / (HIGH_BUFFER_MS - TARGET_BUFFER_MS)
        target = 1.0 + (MAX_RATE - 1.0) * t
      }
    }
    this.rate = this.rate + (target - this.rate) * RATE_SMOOTH
    return this.rate
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]
    const N = out.length

    // Held (gated): keep the processor alive and the buffer intact, emit silence.
    if (!this.playing) {
      for (let i = 0; i < N; i++) out[i] = 0
      return true
    }

    const rate = this.pickRate()

    let i = 0
    while (i < N) {
      if (this.available < 2) {
        // need at least 2 samples for interpolation; emit silence
        out[i++] = 0
        this.underrunCount++
        continue
      }
      const a = this.sampleAt(0)
      const b = this.sampleAt(1)
      out[i++] = a + (b - a) * this.readFrac
      this.readFrac += rate
      while (this.readFrac >= 1.0 && this.available > 0) {
        this.readFrac -= 1.0
        this.read = (this.read + 1) % this.cap
        this.available--
        this.totalRead++
      }
    }

    this.tick++
    if (this.tick % STATS_EVERY === 0) {
      this.port.postMessage({
        type: 'stats',
        bufferedMs: (this.available / sampleRate) * 1000,
        rate: this.rate,
        underruns: this.underrunCount,
        totalReadMs: (this.totalRead / sampleRate) * 1000,
      })
    }

    if (this.ended && this.available < 2) {
      this.port.postMessage('__drained__')
      return false
    }
    return true
  }
}

registerProcessor('pcm-stream', PcmStreamProcessor)
