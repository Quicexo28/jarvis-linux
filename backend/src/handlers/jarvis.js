import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { json, readBody } from '../lib/http.js'
import { appendDeviceAction } from '../lib/obsidian.js'
import { getAgentStatus } from '../agent/bridge.js'
import { runClaude, sessionAsk } from '../lib/claudeCli.js'
import { addUserMessage, addAssistantMessage, getConversationContext } from '../lib/conversationMemory.js'
import { markInteraction } from '../lib/attentionState.js'
import { splitForTts } from '../lib/ttsChunks.js'
import { killProcessGroup } from '../lib/ttsPlayer.js'
import { consumeTicket, elevationStatus, enrollDevice, issueChallenge, elevate } from '../lib/riskAuth.js'
import { riskDeniedSince } from '../lib/toolRisk.js'

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

/**
 * Tell the TTS service a reply is coming so it opens its upstream socket now.
 * With edge-tts the handshake is ~0.65 s of the ~0.9 s before the first
 * syllable; done while the LLM is still thinking, the first sentence starts in
 * ~0.2 s. Fire-and-forget: an engine without /prewarm just answers 404.
 */
export function prewarmTts() {
  fetch(`${XTTS_URL}/prewarm`, { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(() => {})
}

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

// Corte de la voz en curso. Invariante: una sola voz por máquina, sea cual sea
// el cliente; una sesión nueva silencia la anterior antes de arrancar su player.
let stopActiveTts = null

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
 *
 * El player va en grupo propio y se corta con SIGKILL al grupo (ttsPlayer.js);
 * stopActiveTts garantiza una sola voz a la vez.
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
    // detached: grupo de procesos propio, para matar sh+ffmpeg+paplay de golpe.
    stopActiveTts?.()
    const player = spawn('sh', ['-c',
      `ffmpeg -loglevel quiet -f f32le -ar 24000 -ac 1 -i pipe:0 -f s16le -ar 48000 -ac 2 - | paplay --raw --rate=48000 --channels=2 --format=s16le${deviceFlag}`,
    ], { stdio: ['pipe', 'ignore', 'ignore'], detached: true })
    player.stdin.on('error', () => {})

    let aborted = false
    let playerClosed = false // evita SIGKILL a un pgid ya reciclado
    const upstreams = new Set()

    // Corta todo: player (grupo entero) y upstreams abiertos. Terminar un
    // upstream dispara su 'close' → fail → cleanup, que con aborted no reintenta.
    const stop = () => {
      if (aborted) return
      aborted = true
      if (!playerClosed) killProcessGroup(player)
      for (const u of upstreams) { try { u.terminate() } catch {} }
    }
    stopActiveTts = stop
    let sentStart = false
    let ended = false       // client signalled no more sentences

    // Prefetch pipeline: synthesize up to PREFETCH sentences ahead on concurrent
    // upstream connections, buffering each job's PCM in memory. A single writer
    // (pump) drains those buffers into the paplay pipe strictly in order. The
    // instant sentence N finishes draining, N+1's audio is already synthesized
    // and sitting in RAM, so XTTS connection + first-token latency is hidden
    // behind N's playback instead of opening a fresh WS at each boundary (the
    // old serial model starved the pipe → audible gap between sentences).
    const PREFETCH = 3
    // Two budgets: edge-tts time-to-first-audio on a cold connection reaches
    // ~4-5 s (measured), so the first wait is generous; once audio flows, a
    // gap that long means the stream really stalled.
    const FIRST_AUDIO_MS = Number(process.env.JARVIS_TTS_FIRST_AUDIO_MS) || 10000
    const STALL_MS = Number(process.env.JARVIS_TTS_STALL_MS) || 5000
    const MAX_ATTEMPTS = 2
    const SILENCE_ONLY_BYTES = 16000 // > pre-roll (80 ms f32 @24k = 7680 B)
    const jobs = []         // ordered: { text,lang,fx,speed, chunks:[], done, started, attempts, audioBytes }
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
      playerClosed = true
      if (stopActiveTts === stop) stopActiveTts = null
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
    //
    // edge-tts hits the MS cloud and a single sentence sometimes stalls (no
    // audio, or audio that stops mid-way). That failure must stay LOCAL to the
    // sentence: forwarding the upstream {type:"error"} made the client reject
    // and close the session, and closing kills the player — every sentence
    // still buffered behind the stalled one was lost ("se corta", reply cut
    // short). Now a per-attempt watchdog abandons a silent upstream after
    // STALL_MS; a sentence that produced no real audio is retried once, one
    // that stalled mid-way is dropped and the pump moves on to the next.
    const attemptSynth = (job) => {
      job.attempts++
      synthActive++
      const attempt = job.attempts
      const upstream = new WsClient(upstreamUrl)
      upstreams.add(upstream)
      let finished = false
      let watchdog = null
      const armWatchdog = () => {
        clearTimeout(watchdog)
        const budget = job.audioBytes < SILENCE_ONLY_BYTES ? FIRST_AUDIO_MS : STALL_MS
        watchdog = setTimeout(() => fail('stall'), budget)
      }
      const cleanup = () => {
        finished = true
        clearTimeout(watchdog)
        synthActive--
        upstreams.delete(upstream)
        try { upstream.terminate() } catch {}
      }
      const succeed = () => {
        if (finished) return
        cleanup()
        job.done = true
        if (aborted) return
        pump()
        schedule()
      }
      const fail = (why) => {
        if (finished) return
        cleanup()
        if (aborted) return
        // Python always sends ~80 ms of pre-roll silence first, so "no audio"
        // means nothing beyond that — safe to retry without a duplicate.
        const retry = job.audioBytes < SILENCE_ONLY_BYTES && attempt < MAX_ATTEMPTS
        console.warn(`[tts] sentence ${why} (attempt ${attempt}, ${job.audioBytes}B) → ${retry ? 'retry' : 'skip'}: "${job.text.slice(0, 40)}"`)
        if (!retry) job.done = true
        pump()
        if (retry) attemptSynth(job)
        else schedule()
      }
      armWatchdog()
      upstream.on('open', () => {
        try {
          upstream.send(JSON.stringify({
            text: job.text, lang: job.lang, fx: job.fx,
            ...(job.speed !== undefined ? { speed: job.speed } : {}),
          }))
        } catch {}
      })
      upstream.on('message', (data, isBinary) => {
        if (aborted || finished) return
        if (isBinary) {
          job.audioBytes += data.length
          job.chunks.push(data)
          armWatchdog()
          pump()
          return
        }
        let msg
        try { msg = JSON.parse(data.toString()) } catch { return }
        if (msg.type === 'start') ensureStart()
        else if (msg.type === 'end') succeed()
        else if (msg.type === 'error') fail(msg.error || 'error')
      })
      // Closed without {type:"end"} = the synthesis did not complete.
      upstream.on('close', () => fail('closed'))
      upstream.on('error', () => fail('ws_error'))
    }

    const schedule = () => {
      if (aborted) return
      for (const job of jobs) {
        if (synthActive >= PREFETCH) break
        if (job.started) continue
        job.started = true
        attemptSynth(job)
      }
    }

    clientWs.on('message', (data, isBinary) => {
      if (isBinary) return
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.type === 'abort') {
        stop()
        try { clientWs.close(1000) } catch {}
        return
      }
      if (msg.type === 'end') {
        ended = true
        maybeEndPlayer()
        return
      }
      if (msg.text) {
        for (const text of splitForTts(msg.text)) {
          jobs.push({ text, lang: msg.lang ?? 'es', fx: msg.fx ?? false, speed: msg.speed, chunks: [], done: false, started: false, attempts: 0, audioBytes: 0 })
        }
        schedule()
      }
    })

    clientWs.on('close', () => {
      stop()
    })
    clientWs.on('error', () => {
      stop()
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

    // Step-up: a ticket minted by /api/jarvis/elevate (tablet Keystore signature
    // after fingerprint/PIN + the special password) authorises THIS turn only.
    // An invalid or spent ticket is refused outright rather than silently
    // running the turn unauthorised — the user believes they authorised it.
    let elevated = false
    if (body.elevation) {
      elevated = consumeTicket(String(body.elevation))
      if (!elevated) {
        return json(res, 401, { ok: false, error: 'elevation_invalid', reply: 'La autorización caducó o ya se usó. Vuelve a autorizar.' })
      }
    }

    addUserMessage(message)
    const conversationContext = getConversationContext()

    // The chat runs the SAME brain as voice (persistent session, MCP tools
    // loaded). With the old one-shot runClaude the model had no tools at all,
    // so typed orders like "cambia el color de mi setup" got a friendly reply
    // and nothing happened. The session is already warm from boot.
    const { SPEECH_SYSTEM_PROMPT } = await import('./speech.js')
    const turnStart = Date.now()
    const reply = await sessionAsk(userPrompt, {
      systemPromptText: SPEECH_SYSTEM_PROMPT,
      timeoutMs: 60000,
      extraContext: [
        elevated ? '[Turno AUTORIZADO por el señor desde su tablet con huella y contraseña: puedes ejecutar acciones de riesgo pedidas en este mensaje.]' : null,
        conversationContext ? `Contexto reciente:\n${conversationContext}` : null,
      ].filter(Boolean).join('\n') || null,
      model: 'haiku',
      fallbackReply: 'No tengo respuesta en este momento.',
      tag: elevated ? 'elevated' : null,
    })

    addAssistantMessage(reply)
    // The risk gate refused a tool in this turn → tell the app, so it can offer
    // fingerprint + password and resend instead of leaving a polite refusal.
    const denial = elevated ? null : riskDeniedSince(turnStart)

    const actions = focused && inferredAction
      ? [{ type: 'device_action', targetId: focused.id, skillName: focused.skillName ?? null, action: inferredAction, status: 'proposed' }]
      : []

    return json(res, 200, {
      ok: true,
      reply,
      actions,
      authRequired: denial ? { risk: denial.risk, reason: denial.reason } : null,
      elevated,
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

// --- Step-up authorization for risky chat turns (lib/riskAuth.js) ------------
// Token-authenticated like the chat itself (the tablet must reach them). They
// are not DANGEROUS_PATHS: each one proves its own factor — enroll and elevate
// need the special password, elevate also a fresh Keystore signature — and
// riskAuth locks everything after repeated failures.

const ELEVATE_ERRORS = {
  no_password_set: 'Falta fijar la contraseña especial en el PC.',
  locked: 'Demasiados intentos fallidos. Espera unos minutos.',
  bad_public_key: 'Clave del dispositivo no válida.',
  wrong_password: 'Contraseña incorrecta.',
  bad_challenge: 'El reto caducó. Inténtalo otra vez.',
  not_enrolled: 'Este dispositivo no está inscrito.',
  bad_signature: 'La firma de la huella o el PIN no es válida.',
}

function elevateReply(res, result) {
  if (result.ok) return json(res, 200, result)
  const code = result.error === 'locked' ? 429 : result.error === 'no_password_set' ? 409 : 401
  return json(res, code, { ...result, message: ELEVATE_ERRORS[result.error] ?? result.error })
}

export async function handleElevateStatus(req, res) {
  const body = await readBody(req).catch(() => ({}))
  return json(res, 200, elevationStatus(body?.publicKey))
}

export async function handleElevateEnroll(req, res) {
  const body = await readBody(req).catch(() => ({}))
  return elevateReply(res, enrollDevice({ publicKey: body?.publicKey, password: body?.password, label: body?.label }))
}

export async function handleElevateChallenge(req, res) {
  return json(res, 200, issueChallenge())
}

export async function handleElevate(req, res) {
  const body = await readBody(req).catch(() => ({}))
  return elevateReply(res, elevate({
    publicKey: body?.publicKey, challenge: body?.challenge,
    signature: body?.signature, password: body?.password,
  }))
}
