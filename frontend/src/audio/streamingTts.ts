// WebSocket-based streaming TTS client.
//
// Protocol:
//   1. Client opens WS, sends {text, lang, fx?, speed?} as JSON.
//   2. Server sends {type:"start", sr, channels, encoding} as JSON.
//   3. Server streams binary Float32LE frames.
//   4. Server sends {type:"end"} (or {type:"error", error}) and closes.
//   5. Client may send {type:"abort"} at any time to stop generation early.
//
// On the playback side, samples flow into an AudioWorklet ring buffer that
// adapts playback rate ±3% to absorb XTTS generation jitter without audible
// gaps. Dynamic preroll: connect to output once we either have 200 ms
// buffered OR 600 ms have elapsed since the first chunk (whichever first),
// so short replies still start fast.

import workletUrl from './pcm-stream-worklet.js?url'

const XTTS_SAMPLE_RATE = 24000
const PREROLL_BUFFERED_MS = 100
const PREROLL_TIMEOUT_MS = 400

let sharedCtx: AudioContext | null = null
let workletReady: Promise<void> | null = null
// Master gain node — all TTS worklet nodes route through this so we can duck
// the volume while the user is speaking without touching individual sentences.
let masterGain: GainNode | null = null

/**
 * Public accessor for the single shared AudioContext + worklet so other
 * audio sources (e.g. pre-rendered filler WAVs) can play through the same
 * output device at the same sample rate without instantiating a second
 * context.
 */
export async function getSharedAudioContext(): Promise<AudioContext> {
  return getCtx()
}

/**
 * Duck (fade-out) or restore (fade-in) TTS playback volume.
 * Used for barge-in: call setTtsDucking(true) when user starts speaking
 * and setTtsDucking(false) when they stop or a final transcript arrives.
 * fast=true uses a 50ms ramp instead of the default smooth ramp — use when
 * immediately starting a new reply so it plays at full volume from the start.
 */
export function setTtsDucking(duck: boolean, fast = false): void {
  if (!masterGain || !sharedCtx || sharedCtx.state === 'closed') return
  const now = sharedCtx.currentTime
  // Cancel any in-progress ramp and anchor the current value so the new ramp
  // starts from wherever the gain happens to be (avoids jumps).
  masterGain.gain.cancelScheduledValues(now)
  masterGain.gain.setValueAtTime(masterGain.gain.value, now)
  if (duck) {
    // Fade down to 10% over 250ms — audible but Jarvis stays intelligible if
    // the user decides to stop talking (gain is restored on final transcript).
    masterGain.gain.linearRampToValueAtTime(0.1, now + 0.25)
  } else {
    // Restore. fast=true: 50ms (use before starting a new TTS reply).
    // Normal: 350ms smooth fade-in (less jarring if user abandoned the utterance).
    masterGain.gain.linearRampToValueAtTime(1.0, now + (fast ? 0.05 : 0.35))
  }
}

async function getCtx(): Promise<AudioContext> {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext
    try {
      sharedCtx = new Ctor({ sampleRate: XTTS_SAMPLE_RATE, latencyHint: 'interactive' }) as AudioContext
    } catch {
      sharedCtx = new Ctor() as AudioContext
    }
    workletReady = sharedCtx.audioWorklet.addModule(workletUrl)
    // Create master gain routed to destination — recreated with ctx.
    masterGain = sharedCtx.createGain()
    masterGain.gain.value = 1.0
    masterGain.connect(sharedCtx.destination)
  }
  if (sharedCtx.state === 'suspended') {
    try { await sharedCtx.resume() } catch {}
  }
  if (workletReady) await workletReady
  return sharedCtx
}

interface StreamOptions {
  url: string
  text: string
  lang?: string
  fx?: boolean
  speed?: number
  signal?: AbortSignal
  onStats?: (stats: { bufferedMs: number; rate: number; underruns: number }) => void
  // Gate playback (not synthesis): synthesis starts immediately and fills the
  // worklet ring buffer, but the node only connects to the output once this
  // resolves. Used to pipeline sentences — synthesize N+1 while N plays, then
  // start N+1 the instant N finishes, with no audible gap.
  gate?: Promise<void>
}

function toWsUrl(httpOrWs: string): string {
  if (httpOrWs.startsWith('ws://') || httpOrWs.startsWith('wss://')) return httpOrWs
  return httpOrWs.replace(/^http/, 'ws')
}

export async function streamTtsAndPlay(opts: StreamOptions): Promise<void> {
  const { url, text, lang = 'es', fx = false, speed, signal, onStats, gate } = opts
  const ctx = await getCtx()
  console.log(`[tts-stream] ctx.state=${ctx.state} sr=${ctx.sampleRate}`)

  const node = new AudioWorkletNode(ctx, 'pcm-stream', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })

  const wsUrl = toWsUrl(url)
  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  let connected = false
  let bufferedSamples = 0
  let frameCount = 0
  let firstChunkAt = 0
  let prerollTimer: ReturnType<typeof setTimeout> | null = null
  let resolveDone: (() => void) | undefined
  let rejectDone: ((err: Error) => void) | undefined
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  // Watchdog: edge-tts (MS cloud) occasionally stalls and never streams audio.
  // Without this the promise never settles and the next turn is blocked. If no
  // audio arrives in time, reject so the caller can recover.
  let noAudioTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (!firstChunkAt) {
      console.warn('[tts-stream] no audio within 9s — aborting')
      rejectDone?.(new Error('tts_no_audio_timeout'))
      try { ws.close() } catch {}
    }
  }, 9000)

  // Release the worklet to start draining its buffer (it's been emitting silence
  // while buffering). Gated on the previous sentence finishing so playback is
  // gapless without overlap.
  let played = false
  const startPlayback = () => {
    if (played) return
    played = true
    try { node.port.postMessage('__play__') } catch {}
  }
  // Connect the node immediately so the worklet runs and buffers frames; it stays
  // silent until startPlayback(). Playback begins now if ungated, else when gate
  // resolves (the prior sentence ended).
  const connectIfReady = () => {
    if (connected) return
    if (signal?.aborted) return
    connected = true
    // Route through master gain so setTtsDucking() applies to all sentences.
    node.connect(masterGain ?? ctx.destination)
    console.log(`[tts-stream] connected node->masterGain->destination (ctx.state=${ctx.state})`)
    if (ctx.state === 'suspended') { ctx.resume().then(() => console.log('[tts-stream] resumed late')).catch(() => {}) }
    if (prerollTimer) {
      clearTimeout(prerollTimer)
      prerollTimer = null
    }
    if (gate) gate.then(startPlayback, startPlayback)
    else startPlayback()
  }

  node.port.onmessage = (ev) => {
    const data = ev.data
    if (data === '__drained__') {
      console.log('[tts-stream] drained')
      try { node.disconnect() } catch {}
      resolveDone?.()
      return
    }
    if (data && typeof data === 'object' && data.type === 'stats') {
      onStats?.({
        bufferedMs: data.bufferedMs,
        rate: data.rate,
        underruns: data.underruns,
      })
    }
  }

  const onAbort = () => {
    try { ws.send(JSON.stringify({ type: 'abort' })) } catch {}
    try { ws.close() } catch {}
    // Disconnect immediately instead of posting '__end__': '__end__' lets the
    // worklet drain its remaining buffer (keeps playing), which overlaps with
    // the new reply's audio. Cutting the node now stops the old voice at once.
    try { node.disconnect() } catch {}
    if (noAudioTimer) { clearTimeout(noAudioTimer); noAudioTimer = null }
    if (prerollTimer) { clearTimeout(prerollTimer); prerollTimer = null }
    resolveDone?.()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  ws.onopen = () => {
    console.log('[tts-stream] ws open')
    try {
      ws.send(JSON.stringify({ text, lang, fx, ...(speed !== undefined ? { speed } : {}) }))
    } catch (e) {
      rejectDone?.(e as Error)
    }
  }

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'start') {
          // Could verify sr/channels here if needed.
          return
        }
        if (msg.type === 'end') {
          try { node.port.postMessage('__end__') } catch {}
          return
        }
        if (msg.type === 'error') {
          rejectDone?.(new Error(`tts ${msg.error || 'error'}`))
          try { ws.close() } catch {}
          return
        }
      } catch {
        // ignore malformed JSON
      }
      return
    }

    // Binary PCM frame
    const ab = ev.data as ArrayBuffer
    if (!ab || ab.byteLength === 0) return
    if (ab.byteLength % 4 !== 0) {
      // Should not happen — Python sends ndarray.tobytes() which is always 4-aligned.
      return
    }
    const samples = new Float32Array(ab)
    node.port.postMessage(samples, [samples.buffer])
    bufferedSamples += samples.length
    frameCount += 1

    if (!firstChunkAt) {
      firstChunkAt = performance.now()
      console.log('[tts-stream] first audio frame')
      if (noAudioTimer) { clearTimeout(noAudioTimer); noAudioTimer = null }
      prerollTimer = setTimeout(connectIfReady, PREROLL_TIMEOUT_MS)
    }
    if (!connected && (bufferedSamples / ctx.sampleRate) * 1000 >= PREROLL_BUFFERED_MS) {
      connectIfReady()
    }
  }

  ws.onerror = () => {
    rejectDone?.(new Error('tts ws_error'))
  }

  ws.onclose = (ev) => {
    console.log(`[tts-stream] ws close code=${ev.code} frames=${frameCount} samples=${bufferedSamples} (~${(bufferedSamples / ctx.sampleRate).toFixed(1)}s) connected=${connected}`)
    if (!firstChunkAt && !connected) {
      // closed before any audio
      rejectDone?.(new Error(`tts ws_closed_${ev.code}`))
      return
    }
    // ensure playback can drain even if server didn't send explicit end
    if (!connected) connectIfReady()
    try { node.port.postMessage('__end__') } catch {}
  }

  try {
    await done
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (prerollTimer) clearTimeout(prerollTimer)
    if (noAudioTimer) clearTimeout(noAudioTimer)
    try { ws.close() } catch {}
  }
}
