/**
 * Local STT audio capture and WebSocket streaming.
 *
 * Captures 16kHz mono PCM from the microphone via AudioWorklet,
 * streams binary frames over WebSocket to the backend STT service,
 * and receives JSON transcript messages.
 */

import { getApiBase } from '../api/client'

export interface SttTranscript {
  text: string
  isFinal: boolean
  speakerConfidence: number
}

export type OnTranscript = (t: SttTranscript) => void

export interface LocalSttSession {
  stop: () => void
  isActive: () => boolean
}

const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage(input[0])
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
`

// Track registration per-AudioContext, NOT globally. Each startLocalStt()
// creates a fresh AudioContext (and closes it on stop), so the worklet module
// must be added to every new context. A global flag caused the 2nd+ session to
// skip addModule() on its new context, throwing "AudioWorklet does not have a
// valid AudioWorkletGlobalScope".
const registeredContexts = new WeakSet<AudioContext>()

async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return
  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  registeredContexts.add(ctx)
}

/**
 * Start a local STT streaming session.
 * Returns a session handle with stop() to end capture.
 */
export async function startLocalStt(onTranscript: OnTranscript): Promise<LocalSttSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })

  const ctx = new AudioContext({ sampleRate: 16000 })
  await ensureWorklet(ctx)

  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'pcm-capture')

  // WebSocket to backend — auto-reconnecting. The Python STT service can take
  // several seconds to come up (model load, or a ~1.6 GB first-boot model
  // download), so the first connection often closes with 1011 upstream_error.
  // Instead of dying silently, retry with backoff while the session is active.
  const base = getApiBase().replace(/^http/, 'ws')
  const wsUrl = `${base}/api/jarvis/stt/stream`
  let active = true
  let ws: WebSocket | null = null
  let wsOpen = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoffMs = 500
  const pendingFrames: Float32Array[] = []

  function connectWs() {
    if (!active) return
    wsOpen = false
    const sock = new WebSocket(wsUrl)
    sock.binaryType = 'arraybuffer'
    ws = sock

    sock.onopen = () => {
      console.log('[stt] ws open ->', wsUrl)
      wsOpen = true
      backoffMs = 500 // reset backoff once a healthy connection lands
      for (const frame of pendingFrames) sock.send(frame.buffer)
      pendingFrames.length = 0
    }

    sock.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as SttTranscript
        console.log(`[stt] ${msg.isFinal ? 'FINAL' : 'interim'} "${msg.text}" conf=${msg.speakerConfidence?.toFixed?.(2) ?? msg.speakerConfidence}`)
        onTranscript(msg)
      } catch {}
    }

    sock.onerror = (e) => console.warn('[stt] ws error', e)

    sock.onclose = (e) => {
      wsOpen = false
      if (!active) { console.log('[stt] ws closed (stopped)'); return }
      console.log(`[stt] ws close ${e.code} ${e.reason} — reconnect in ${backoffMs}ms`)
      reconnectTimer = setTimeout(connectWs, backoffMs)
      backoffMs = Math.min(backoffMs * 2, 3000)
    }
  }

  connectWs()

  worklet.port.onmessage = (evt: MessageEvent<Float32Array>) => {
    if (!active) return
    const pcm = evt.data
    if (wsOpen && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(pcm.buffer)
    } else {
      // Buffer recent audio while (re)connecting; cap to ~5 s so a long outage
      // doesn't grow this unbounded (each frame is 128 samples ≈ 8 ms @16kHz).
      pendingFrames.push(pcm)
      if (pendingFrames.length > 640) pendingFrames.shift()
    }
  }

  source.connect(worklet)
  worklet.connect(ctx.destination) // required to keep worklet alive (output is silent)

  function stop() {
    if (!active) return
    active = false
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    try { worklet.disconnect() } catch {}
    try { source.disconnect() } catch {}
    try { ctx.close() } catch {}
    try { ws?.close() } catch {}
    stream.getTracks().forEach((t) => t.stop())
  }

  return {
    stop,
    isActive: () => active,
  }
}
