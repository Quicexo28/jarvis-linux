/**
 * Skill bus — duplex command channel from the backend to the AWAKE renderer.
 *
 * Self-built skills run in the Node backend, which can't touch the camera,
 * screen, clipboard, etc. — those live in the browser/renderer. This bus lets a
 * backend handler ask the renderer to run a primitive (capture_photo,
 * enumerate_devices, notify, ...) and await the correlated result.
 *
 * The desktop renderer (local connection) is the PRIMARY client — one at a
 * time, last connection wins. Remote web renderers (Tailscale) are kept in a
 * separate set and NEVER displace the primary: primitives run on the desktop
 * when it's connected, falling back to the newest remote only when no desktop
 * renderer exists. If no client at all, requestClient() rejects with
 * 'no_client' so the caller can fall back to a native (backend-side) path.
 *
 * Wire protocol:
 *   backend -> client: { id, verb, payload }
 *   client -> backend: { id, ok: true, result } | { id, ok: false, error }
 */
import { isLocal } from './webAuth.js'

let client = null          // primary: local renderer (Tauri / Chromium app-mode)
const remotes = new Set()  // remote web renderers, fallback only
let seq = 0
const pending = new Map()

function rejectPendingFor(ws, reason) {
  for (const [id, p] of pending) {
    if (p.ws !== ws) continue
    clearTimeout(p.timer)
    p.reject(new Error(reason))
    pending.delete(id)
  }
}

/** The socket primitives should run on: primary first, newest remote as fallback. */
function activeClient() {
  if (client && client.readyState === 1) return client
  let last = null
  for (const ws of remotes) if (ws.readyState === 1) last = ws
  return last
}

/** @returns {boolean} true if a renderer is connected and ready. */
export function hasClient() {
  return !!activeClient()
}

/**
 * Ask the connected renderer to run a primitive and await its result.
 * @param {string} verb           primitive name (e.g. 'capture_photo')
 * @param {object} [payload]      verb-specific args
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<any>} the primitive's result; rejects 'no_client'/'timeout'
 */
export function requestClient(verb, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = activeClient()
    if (!target) return reject(new Error('no_client'))
    const id = `${Date.now()}-${++seq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer, ws: target })
    try {
      target.send(JSON.stringify({ id, verb, payload }))
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      reject(new Error('send_failed: ' + e.message))
    }
  })
}

/**
 * WebSocket upgrade handler for /api/skills/bus. Mirrors the ws-loading pattern
 * used by stt.js so 'ws' stays an optional runtime dependency.
 */
export async function handleSkillBusUpgrade(req, socket, head) {
  let WsModule
  try {
    const { createRequire } = await import('module')
    const require = createRequire(import.meta.url)
    WsModule = require('ws')
  } catch {
    socket.destroy()
    return
  }
  const { WebSocketServer } = WsModule
  const wss = new WebSocketServer({ noServer: true })
  // Role decided server-side by connection origin — a remote client can't
  // claim the primary slot and steal primitives from the desktop renderer.
  const local = isLocal(req)
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (local) {
      // Last local connection wins — a fresh AWAKE renderer replaces a stale socket.
      if (client && client !== ws) { try { client.close() } catch {} }
      client = ws
      console.log('[skill-bus] renderer connected (primary)')
    } else {
      remotes.add(ws)
      console.log(`[skill-bus] renderer connected (remote, ${remotes.size} total)`)
    }

    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || 'client_error'))
    })

    ws.on('close', () => {
      if (client === ws) client = null
      remotes.delete(ws)
      rejectPendingFor(ws, 'client_disconnected')
      console.log('[skill-bus] renderer disconnected')
    })
    ws.on('error', () => {
      if (client === ws) client = null
      remotes.delete(ws)
      rejectPendingFor(ws, 'client_error')
    })
  })
}
