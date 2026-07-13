/**
 * PTT bus — broadcasts push-to-talk state to all connected WebSocket clients.
 * The ptt-overlay Tauri window subscribes here and shows/hides itself.
 */

const clients = new Set()

function broadcast(type) {
  const msg = JSON.stringify({ type })
  for (const ws of clients) {
    try { ws.send(msg) } catch { clients.delete(ws) }
  }
}

export function broadcastPttStart() { broadcast('ptt_start') }
export function broadcastPttStop()  { broadcast('ptt_stop')  }

export async function handlePttBusUpgrade(req, socket, head) {
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
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })
}
