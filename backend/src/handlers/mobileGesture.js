import { requestClient as skillBusRequest, hasClient as skillBusHasClient } from '../lib/skillBus.js'

/**
 * WebSocket upgrade handler for /api/mobile/gesture/ws.
 * Receives GestureOutput JSON at ~10 fps from the mobile gesture camera and
 * forwards it to the desktop renderer via the skill bus 'gesture_remote' primitive.
 * Fire-and-forget: gesture_remote completes synchronously in the renderer so no
 * back-pressure accumulates even at sustained 10 fps.
 */
export async function handleMobileGestureUpgrade(req, socket, head) {
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
  wss.handleUpgrade(req, socket, head, (ws) => {
    console.log('[mobile-gesture] camera connected')
    ws.on('message', (data) => {
      if (!skillBusHasClient()) return
      let gesture
      try { gesture = JSON.parse(data.toString()) } catch { return }
      skillBusRequest('gesture_remote', gesture).catch(() => {})
    })
    ws.on('close', () => console.log('[mobile-gesture] camera disconnected'))
    ws.on('error', () => {})
  })
}
