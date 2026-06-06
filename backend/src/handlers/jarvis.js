import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { json, readBody } from '../lib/http.js'
import { appendDeviceAction } from '../lib/obsidian.js'
import { getAgentStatus } from '../agent/bridge.js'
import { runClaude } from '../lib/claudeCli.js'
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

const TURN_PROMPT = `Eres Jarvis, asistente inteligente en espanol (Colombia).
Responde de forma concisa y natural (1-3 oraciones max).
Si hay un dispositivo en foco, confirma acciones sobre el.
Si es una pregunta general, responde directamente.
Nunca uses emojis. Nunca repitas la pregunta del usuario.
Reglas de voz: sin markdown, sin rutas de archivos (di "la carpeta de configuracion"), sin URLs (di "el sitio oficial"), sin numeracion Primero/Segundo (usa "y ademas", "luego"), numeros en palabras cuando sea natural.
Responde directo con la informacion o confirmacion. No uses frases de relleno ni anuncios ("dame un segundo", "dejame ver", "buena pregunta") — ve directo al contenido.`

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
 * Proxies a WS connection straight to the XTTS service's /synthesize/ws
 * endpoint. Bidirectional pass-through: client sends initial JSON params
 * + optional {type:"abort"}; upstream sends start/end JSON + binary PCM
 * frames. Lower per-chunk overhead than the HTTP streaming path.
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

  const wss = new WebSocketServer({ noServer: true })
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstreamUrl = XTTS_URL.replace(/^http/, 'ws') + '/synthesize/ws'
    const upstream = new WsClient(upstreamUrl)

    // Relay upstream -> client immediately. The TTS service streams {type:start}
    // and the first PCM frames within ~15 ms of connecting; registering this
    // listener inside the 'open' handler raced and dropped those early frames
    // (silent TTS). Attach it now so nothing is missed.
    upstream.on('message', (data, isBinary) => {
      if (clientWs.readyState === WsClient.OPEN) {
        clientWs.send(data, { binary: isBinary })
      }
    })

    // Buffer client -> upstream frames until the upstream socket is open.
    const pending = []
    let upstreamOpen = false
    upstream.on('open', () => {
      upstreamOpen = true
      for (const [d, b] of pending) {
        try { upstream.send(d, { binary: b }) } catch {}
      }
      pending.length = 0
    })
    clientWs.on('message', (data, isBinary) => {
      if (upstreamOpen && upstream.readyState === WsClient.OPEN) {
        upstream.send(data, { binary: isBinary })
      } else {
        pending.push([data, isBinary])
      }
    })

    upstream.on('error', () => {
      try { clientWs.close(1011, 'upstream_error') } catch {}
    })
    upstream.on('close', () => {
      try { clientWs.close(1000) } catch {}
    })
    clientWs.on('close', () => {
      try { upstream.close() } catch {}
    })
    clientWs.on('error', () => {
      try { upstream.close() } catch {}
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

    const reply = await runClaude(userPrompt, {
      systemPromptText: TURN_PROMPT,
      timeoutMs: 30000,
      conversationContext,
      model: 'haiku',
      fallbackReply: 'No tengo respuesta en este momento.',
      namespace: 'jarvis-turn',
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
