/**
 * Wake signal bus — broadcasts a wake event to all DORMANT frontend clients
 * connected via WS at /api/jarvis/wake-bus.
 *
 * Used when an external trigger (Hyprland keybind → POST /api/skills/system/wake)
 * needs to bring the Tauri window out of its hidden DORMANT state. The skill bus
 * (/api/skills/bus) can't serve this role because it only connects while AWAKE.
 */

const clients = new Set()

function registerClient(ws) {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
}

export function broadcastWake() {
  const msg = JSON.stringify({ type: 'wake' })
  for (const ws of clients) {
    try { ws.send(msg) } catch { clients.delete(ws) }
  }
}

export async function handleWakeBusUpgrade(req, socket, head) {
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
  wss.handleUpgrade(req, socket, head, (ws) => registerClient(ws))
}
