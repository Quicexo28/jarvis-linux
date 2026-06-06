// Minimal dependency-free WebSocket (RFC 6455) server helper.
//
// The backend is intentionally zero-runtime-deps, so instead of pulling in `ws`
// we implement just enough of the protocol to exchange small JSON text frames
// over localhost: the server handshake, masked client-frame decode, unmasked
// server-frame encode, and ping/pong + close handling. This is not a general
// purpose WS server — it targets the Jarvis agent bridge only.

import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function isWebSocketUpgrade(req) {
  return String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}

// Completes the HTTP→WS handshake on a raw socket and returns a tiny connection
// object: { on('message'|'close', fn), send(obj), close() }. Returns null if the
// request is missing the Sec-WebSocket-Key header.
export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    try { socket.destroy() } catch {}
    return null
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  return createConnection(socket)
}

function createConnection(socket) {
  const listeners = { message: [], close: [] }
  let buf = Buffer.alloc(0)
  let fragChunks = []
  let closed = false

  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); parseFrames() })
  socket.on('close', () => emit('close'))
  socket.on('error', () => { try { socket.destroy() } catch {} ; emit('close') })

  function emit(type, payload) {
    if (type === 'close') {
      if (closed) return
      closed = true
    }
    for (const l of listeners[type]) { try { l(payload) } catch {} }
  }

  function parseFrames() {
    // Parse as many complete frames as are buffered; bail out when a frame is
    // only partially received (TCP can split/merge frames arbitrarily).
    for (;;) {
      if (buf.length < 2) return
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2

      if (len === 126) {
        if (buf.length < offset + 2) return
        len = buf.readUInt16BE(offset); offset += 2
      } else if (len === 127) {
        if (buf.length < offset + 8) return
        len = Number(buf.readBigUInt64BE(offset)); offset += 8
      }

      let maskKey = null
      if (masked) {
        if (buf.length < offset + 4) return
        maskKey = buf.subarray(offset, offset + 4); offset += 4
      }

      if (buf.length < offset + len) return
      let payload = buf.subarray(offset, offset + len)
      if (masked) {
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3]
        payload = out
      }
      buf = buf.subarray(offset + len)

      if (opcode === 0x8) { close(); return }           // close
      if (opcode === 0x9) { sendFrame(0xa, payload); continue } // ping → pong
      if (opcode === 0xa) { continue }                   // pong → ignore

      if (opcode === 0x1 || opcode === 0x2) {            // text / binary start
        if (fin) emit('message', payload.toString('utf8'))
        else fragChunks = [payload]
      } else if (opcode === 0x0) {                        // continuation
        fragChunks.push(payload)
        if (fin) { emit('message', Buffer.concat(fragChunks).toString('utf8')); fragChunks = [] }
      }
    }
  }

  function sendFrame(opcode, payload) {
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.alloc(2); header[1] = len
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | opcode // FIN + opcode (server frames are never masked)
    try { socket.write(Buffer.concat([header, payload])) } catch {}
  }

  function send(obj) { sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')) }

  function close() {
    try { sendFrame(0x8, Buffer.alloc(0)); socket.end() } catch {}
    emit('close')
  }

  return {
    on(type, listener) { if (listeners[type]) listeners[type].push(listener) },
    send,
    close,
  }
}
