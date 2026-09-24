import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { json, readBody } from '../lib/http.js'
import { appendDeviceAction } from '../lib/obsidian.js'
import { getAgentStatus } from '../agent/bridge.js'
import { runClaude, sessionAsk } from '../lib/claudeCli.js'
import { addUserMessage, addAssistantMessage, getConversationContext } from '../lib/conversationMemory.js'
import { markInteraction } from '../lib/attentionState.js'

const FILLER_DIR = join(import.meta.dirname, '..', '..', 'voice', 'cache', 'fillers')
const FILLER_NAME_RE = /^filler-[a-z0-9-]{1,32}$/

export async function handleFillerWav(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const name = url.searchParams.get('name') ?? ''
  if (!FILLER_NAME_RE.test(name)) {
    return json(res, 400, { ok: false, error: 'invalid_name' })
  }
  const filePath = join(FILLER_DIR, `${name}.wav`)
  try {
    const info = await stat(filePath)
    res.statusCode = 200
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Content-Length', String(info.size))
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Access-Control-Allow-Origin', '*')
    createReadStream(filePath).pipe(res)
  } catch {
    return json(res, 404, { ok: false, error: 'not_rendered' })
  }
}

const WAKE_PROMPT = 'Eres Jarvis, asistente personal de Santiago, al estilo del Jarvis de Iron Man. Tratas al usuario de "señor". Responde SOLO con 2 a 5 palabras confirmando que estas atento ("A sus ordenes, señor", "Aqui estoy, señor"). Sin preguntas, sin saludos largos, sin emojis.'

function runClaudeWake() {
  return runClaude('El usuario te llamo.', {
    systemPromptText: WAKE_PROMPT,
    timeoutMs: 15000,
    model: 'haiku',
    fallbackReply: 'Aqui estoy',
    namespace: 'jarvis-wake',
  })
}

export async function handleJarvisWake(_req, res) {
  // Engage the attention state the moment the wake word fires, so the AWAKE
  // session opens with the full natural-conversation window. Without this the
  // backend stays PASSIVE (threshold 0.7) and every follow-up utterance after
  // the wake is silently ignored until the user repeats "Jarvis ...".
  markInteraction()
  const reply = await runClaudeWake()
  return json(res, 200, { ok: true, reply, model: 'haiku', via: 'cli' })
}

const XTTS_URL = process['env'].XTTS_URL ?? 'http://127.0.0.1:8789'

// Streams Float32 PCM from the Python XTTS service to the browser as it
// generates, so the user hears the cloned voice with low latency instead of
// waiting for the full sentence. Pass-through of upstream chunks; no buffering.
export async function handleJarvisTts(req, res) {
  try {
    const body = await readBody(req)
    const text = String(body.text ?? '').trim()
    const lang = String(body.lang ?? 'es')
    if (!text) return json(res, 400, { ok: false, error: 'empty_text' })

    const upstream = await fetch(`${XTTS_URL}/synthesize/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang, fx: false }),
    })
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '')
      return json(res, 502, { ok: false, error: 'xtts_upstream', status: upstream.status, detail })
    }

    res.statusCode = 200
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/pcm-f32le')
    res.setHeader('X-Sample-Rate', upstream.headers.get('x-sample-rate') ?? '24000')
    res.setHeader('X-Channels', '1')
    res.setHeader('X-Encoding', 'float32-le')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Expose-Headers', 'X-Sample-Rate,X-Channels,X-Encoding')
    // Disable Nagle so small PCM chunks flush immediately instead of coalescing.
    try { res.socket?.setNoDelay(true) } catch {}
    try { res.flushHeaders?.() } catch {}

    const reader = upstream.body.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value && value.byteLength) res.write(Buffer.from(value))
    }
    res.end()
  } catch (e) {
    if (!res.headersSent) {
      return json(res, 502, { ok: false, error: 'xtts_unreachable', detail: String(e) })
    }
    try { res.end() } catch {}
  }
}

/**
 * WebSocket upgrade handler for /api/jarvis/tts/ws.
 *
 * Plays TTS audio through the system PipeWire sink (paplay) so it follows
 * the same output device as all other system audio — bypassing WebKit's
 * AudioContext which doesn't reliably follow PipeWire's default sink.
 *
 * Protocol to client is kept minimal: {type:"start"} + one silent PCM frame
 * (to satisfy the frontend watchdog timer), then {type:"end"} once paplay
 * finishes. The frontend AudioWorklet drains the silent frame instantly and
 * resolves — UI state stays correct without the client handling real audio.
 */
export async function handleJarvisTtsStreamUpgrade(req, socket, head) {
  let WsModule
  try {
    const { createRequire } = await import('module')
    const require = createRequire(import.meta.url)
    WsModule = require('ws')
  } catch {
    socket.destroy()
    return
  }
  const { WebSocket: WsClient, WebSocketServer } = WsModule
  const { spawn } = await import('child_process')

  const wss = new WebSocketServer({ noServer: true })
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstreamUrl = XTTS_URL.replace(/^http/, 'ws') + '/synthesize/ws'

    // ONE persistent player for the whole turn. paplay routes into the echo-cancel
    // sink (JARVIS_AEC_SINK, default "jarvis_aec_sink"), which forwards to the
    // system default sink (Bluetooth) AND gives PipeWire's module-echo-cancel the
    // reference signal needed to strip Jarvis's own voice from the mic. Set
    // JARVIS_AEC_SINK="" to bypass AEC and play straight to the default sink.
    // Sentences are synthesized serially and piped into this SAME process
    // back-to-back: no respawn gap, serial order means no overlap.
    // xtts streams ~5x faster than realtime, so sentence N+1 is written into
    // the still-buffered pipe while N is playing → gapless playback.
    const aecSink = process.env.JARVIS_AEC_SINK ?? 'jarvis_aec_sink'
    const deviceFlag = aecSink ? ` --device=${aecSink}` : ''
    const player = spawn('sh', ['-c',
      `ffmpeg -loglevel quiet -f f32le -ar 24000 -ac 1 -i pipe:0 -f s16le -ar 48000 -ac 2 - | paplay --raw --rate=48000 --channels=2 --format=s16le${deviceFlag}`,
    ], { stdio: ['pipe', 'ignore', 'ignore'] })
    player.stdin.on('error', () => {})

    let aborted = false
    let sentStart = false
    let ended = false       // client signalled no more sentences

    // Prefetch pipeline: synthesize up to PREFETCH sentences ahead on concurrent
    // upstream connections, buffering each job's PCM in memory. A single writer
    // (pump) drains those buffers into the paplay pipe strictly in order. The
    // instant sentence N finishes draining, N+1's audio is already synthesized
    // and sitting in RAM, so XTTS connection + first-token latency is hidden
    // behind N's playback instead of opening a fresh WS at each boundary (the
    // old serial model starved the pipe → audible gap between sentences).
    const PREFETCH = 2
    const jobs = []         // ordered: { text,lang,fx,speed, chunks:[], done, started, settled }
    let writeIdx = 0        // index of the job currently draining into the pipe
    let synthActive = 0     // open upstream connections

    const sendJson = (obj) => {
      if (clientWs.readyState === WsClient.OPEN) {
        try { clientWs.send(JSON.stringify(obj)) } catch {}
      }
    }

    // Voice-level envelope for the UI hologram: audio plays server-side, so the
    // client gets {type:"levels", t0, dt, v:[...]} — RMS per 100ms block, with
    // t0 = seconds into the reply's audio timeline (cumulative samples, NOT
    // wall time: the pipe fills faster than realtime). Computed here in pump
    // order because drain order IS playback order (prefetch synthesizes out of
    // order). The client re-anchors t0 to its own clock plus output latency.
    const LEVEL_BLOCK = 2400 // samples @24k = 100ms
    let levelBlockIdx = 0
    let levelAcc = 0
    let levelAccN = 0
    const emitLevels = (buf) => {
      let f
      try {
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.byteLength & ~3))
        f = new Float32Array(ab)
      } catch { return }
      const vals = []
      let firstBlock = null
      for (let i = 0; i < f.length; i++) {
        const s = f[i]
        levelAcc += s * s
        if (++levelAccN >= LEVEL_BLOCK) {
          if (firstBlock === null) firstBlock = levelBlockIdx
          // ~3.5x gain maps typical speech RMS (~0.05-0.25) onto 0..1.
          vals.push(Math.min(1, Math.round(Math.sqrt(levelAcc / levelAccN) * 350) / 100))
          levelBlockIdx++
          levelAcc = 0
          levelAccN = 0
        }
      }
      if (vals.length) sendJson({ type: 'levels', t0: +(firstBlock * 0.1).toFixed(2), dt: 0.1, v: vals })
    }

    player.on('close', () => {
      sendJson({ type: 'end' })
      try { clientWs.close(1000) } catch {}
    })

    const ensureStart = () => {
      if (sentStart) return
      sentStart = true
      sendJson({ type: 'start', sr: 24000, channels: 1, encoding: 'f32le' })
      // One silent frame so the frontend watchdog clears.
      const silent = Buffer.alloc(240 * 4)
      if (clientWs.readyState === WsClient.OPEN) {
        try { clientWs.send(silent, { binary: true }) } catch {}
      }
    }

    const maybeEndPlayer = () => {
      if (ended && writeIdx >= jobs.length && synthActive === 0) {
        try { player.stdin.end() } catch {}
      }
    }

    // Drain buffered audio into the pipe in order, advancing past finished jobs.
    const pump = () => {
      if (aborted) return
      while (writeIdx < jobs.length) {
        const job = jobs[writeIdx]
        while (job.chunks.length) {
          const buf = job.chunks.shift()
          emitLevels(buf)
          try { player.stdin.write(buf) } catch {}
        }
        if (job.done) { writeIdx++; continue } // drained + finished → next job
        break                                  // still producing → wait
      }
      maybeEndPlayer()
    }

    // Open upstreams for not-yet-started jobs, up to PREFETCH concurrent.
    const schedule = () => {
      if (aborted) return
      for (const job of jobs) {
        if (synthActive >= PREFETCH) break
        if (job.started) continue
        job.started = true
        synthActive++
        const upstream = new WsClient(upstreamUrl)
        const settle = () => {
          if (job.settled) return
          job.settled = true
          job.done = true
          synthActive--
          if (aborted) return
          pump()
          schedule()
        }
        upstream.on('open', () => {
          try {
            upstream.send(JSON.stringify({
              text: job.text, lang: job.lang, fx: job.fx,
              ...(job.speed !== undefined ? { speed: job.speed } : {}),
            }))
          } catch {}
        })
        upstream.on('message', (data, isBinary) => {
          if (aborted) return
          if (isBinary) { job.chunks.push(data); pump() }
          else {
            const msg = JSON.parse(data.toString())
            if (msg.type === 'start') ensureStart()
            if (msg.type === 'error') sendJson(msg)
          }
        })
        upstream.on('close', settle)
        upstream.on('error', settle)
      }
    }

    clientWs.on('message', (data, isBinary) => {
      if (isBinary) return
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.type === 'abort') {
        aborted = true
        try { player.kill() } catch {}
        try { clientWs.close(1000) } catch {}
        return
      }
      if (msg.type === 'end') {
        ended = true
        maybeEndPlayer()
        return
      }
      if (msg.text) {
        jobs.push({ text: msg.text, lang: msg.lang ?? 'es', fx: msg.fx ?? false, speed: msg.speed, chunks: [], done: false, started: false, settled: false })
        schedule()
      }
    })

    clientWs.on('close', () => {
      if (!aborted) { aborted = true; try { player.kill() } catch {} }
    })
    clientWs.on('error', () => {
      aborted = true; try { player.kill() } catch {}
    })
  })
}

export async function handleAgentHealth(_req, res) {
  return json(res, 200, getAgentStatus())
}

export async function handleDeviceAction(req, res) {
  try {
    const body = await readBody(req)
    const action = {
      entityId: body.entityId ?? null,
      label: body.label ?? 'Dispositivo',
      skillName: body.skillName ?? null,
      action: body.action ?? null,
      timestamp: new Date().toISOString(),
    }

    // Best-effort Obsidian log; never block the response.
    appendDeviceAction({
      speakerName: body.speakerName ?? null,
      deviceLabel: action.label,
      action: action.action ?? action.skillName ?? 'unknown',
    }).catch(() => {})

    return json(res, 200, {
      ok: true,
      status: 'queued',
      message: `Acción recibida para ${action.label}`,
      action,
    })
  } catch (error) {
    return json(res, 400, { ok: false, error: 'invalid_json', detail: String(error) })
  }
}

export async function handleJarvisTurn(req, res) {
  try {
    const body = await readBody(req)
    const message = String(body.message ?? '').trim()
    if (!message) return json(res, 400, { ok: false, error: 'empty_message' })

    const focused = body?.context?.focusedEntity ?? null
    const inferredAction = focused?.skillAction ?? (message.toLowerCase().includes('apaga') ? 'off' : null)

    // Build user prompt with device context if available
    let userPrompt = message
    if (focused) {
      userPrompt += `\n[Dispositivo en foco: ${focused.label}${focused.skillName ? `, skill: ${focused.skillName}` : ''}${inferredAction ? `, accion sugerida: ${inferredAction}` : ''}]`
    }

    addUserMessage(message)
    const conversationContext = getConversationContext()

    // The chat runs the SAME brain as voice (persistent session, MCP tools
    // loaded). With the old one-shot runClaude the model had no tools at all,
    // so typed orders like "cambia el color de mi setup" got a friendly reply
    // and nothing happened. The session is already warm from boot.
    const { SPEECH_SYSTEM_PROMPT } = await import('./speech.js')
    const reply = await sessionAsk(userPrompt, {
      systemPromptText: SPEECH_SYSTEM_PROMPT,
      timeoutMs: 60000,
      extraContext: conversationContext ? `Contexto reciente:\n${conversationContext}` : null,
      model: 'haiku',
      fallbackReply: 'No tengo respuesta en este momento.',
    })

    addAssistantMessage(reply)

    const actions = focused && inferredAction
      ? [{ type: 'device_action', targetId: focused.id, skillName: focused.skillName ?? null, action: inferredAction, status: 'proposed' }]
      : []

    return json(res, 200, {
      ok: true,
      reply,
      actions,
      uiHints: {
        highlightEntityId: focused?.id ?? null,
        toast: focused ? `Foco: ${focused.label}` : null,
      },
      meta: {
        sessionId: body.sessionId ?? 'jarvis-local',
        receivedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    return json(res, 400, { ok: false, error: 'invalid_json', detail: String(error) })
  }
}
