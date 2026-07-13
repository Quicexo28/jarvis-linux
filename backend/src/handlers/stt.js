/**
 * STT handler - proxies audio to the local faster-whisper Python service.
 *
 * POST /api/jarvis/stt         - upload audio file, get transcription
 * WS   /api/jarvis/stt/stream  - real-time PCM streaming (handled via upgrade)
 */

import { json } from '../lib/http.js'
import { env } from 'node:process'

const STT_URL = env.STT_URL || 'http://127.0.0.1:8790'

/**
 * POST /api/jarvis/stt - proxy audio upload to the STT service.
 * Expects raw audio body (WAV or PCM).
 */
export async function handleSttTranscribe(req, res) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)

  if (!body.length) return json(res, 400, { ok: false, error: 'empty_body' })

  const boundary = '----JarvisSttBoundary' + Date.now()
  const filename = 'audio.wav'
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`
  const footer = `\r\n--${boundary}--\r\n`

  const multipartBody = Buffer.concat([
    Buffer.from(header),
    body,
    Buffer.from(footer),
  ])

  try {
    const upstream = await fetch(`${STT_URL}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(multipartBody.length),
      },
      body: multipartBody,
    })

    if (!upstream.ok) {
      return json(res, 502, { ok: false, error: 'stt_service_error', status: upstream.status })
    }

    const result = await upstream.json()
    return json(res, 200, { ok: true, ...result })
  } catch (err) {
    return json(res, 502, { ok: false, error: 'stt_service_unavailable', detail: err.message })
  }
}

/**
 * WebSocket upgrade handler for /api/jarvis/stt/stream.
 * Proxies binary PCM frames to Python STT WebSocket, relays JSON transcripts back.
 */
export async function handleSttStreamUpgrade(req, socket, head) {
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
    const upstreamUrl = STT_URL.replace('http', 'ws') + '/stream'
    const upstream = new WsClient(upstreamUrl)
    // Keepalive ping timer (browsers auto-pong): keeps a long-lived streaming
    // socket from being reaped by any intermediary and surfaces a dead peer fast.
    let pingTimer = null
    const cleanup = () => { if (pingTimer) { clearInterval(pingTimer); pingTimer = null } }

    // Relay transcripts upstream -> client immediately (no race with 'open').
    upstream.on('message', (data) => {
      if (clientWs.readyState === WsClient.OPEN) {
        clientWs.send(data.toString())
      }
    })

    // Buffer client audio frames until the upstream STT socket is open, so the
    // first ~ms of speech isn't dropped before the connection is ready.
    const pending = []
    let upstreamOpen = false
    upstream.on('open', () => {
      upstreamOpen = true
      pingTimer = setInterval(() => { try { clientWs.ping() } catch {} }, 15000)
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

    // Close-cause diagnostics: log WHICH side tore the socket down and with what
    // code. The frontend reconnect churn ("ws close 1000") is a clean close, not
    // a crash — these lines reveal the true initiator (browser vs python) so the
    // real trigger can be pinned from journald instead of guessed.
    upstream.on('error', (err) => {
      console.warn('[stt-proxy] upstream(python) error:', err?.message)
      cleanup()
      try { clientWs.close(1011, 'upstream_error') } catch {}
    })

    upstream.on('close', (code, reason) => {
      console.log(`[stt-proxy] upstream(python) closed code=${code} reason=${reason?.toString?.() || '-'} -> closing client`)
      cleanup()
      // 1005/1006 aren't sendable close codes; fall back to a clean 1000.
      const out = (code >= 1000 && code !== 1005 && code !== 1006) ? code : 1000
      try { clientWs.close(out) } catch {}
    })

    clientWs.on('close', (code, reason) => {
      console.log(`[stt-proxy] client(browser) closed code=${code} reason=${reason?.toString?.() || '-'} -> closing upstream`)
      cleanup()
      try { upstream.close() } catch {}
    })

    clientWs.on('error', (err) => {
      console.warn('[stt-proxy] client(browser) error:', err?.message)
      cleanup()
      try { upstream.close() } catch {}
    })
  })
}
