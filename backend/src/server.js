import http from 'http'
import { env } from 'node:process'
import { loadLocalSecrets } from './lib/secrets.js'

// Load local secrets (gitignored) into process.env BEFORE any module reads env.
loadLocalSecrets()

import { dispatch, loadDynamicRoutes } from './routes.js'
import { serveStatic } from './handlers/static.js'
import { handleSttStreamUpgrade } from './handlers/stt.js'
import { handleJarvisTtsStreamUpgrade } from './handlers/jarvis.js'
import { warmupSpeechSession } from './handlers/speech.js'
import { handleSkillBusUpgrade } from './lib/skillBus.js'
import { migrateStraySpeakers } from './lib/obsidian.js'
import { startScheduler } from './lib/reminders.js'
import { attachAgentBridge } from './agent/bridge.js'
import { handleMobileGestureUpgrade } from './handlers/mobileGesture.js'
import { startCloudflareTunnel } from './lib/cloudflareTunnel.js'
import { startPdfWatcher } from './lib/pdfWatcher.js'

const port = Number(env.PORT ?? 8788)
const host = env.HOST ?? '0.0.0.0'

const server = http.createServer(async (req, res) => {
  try {
    // Serve built frontend before API routes. Returns false when no file matches,
    // allowing API dispatch to proceed normally.
    if (await serveStatic(req, res)) return
    await dispatch(req, res)
  } catch (err) {
    console.error('unhandled', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'internal' }))
    }
  }
})

// Jarvis agent: duplex WS bridge + swappable brain. Single shared 'upgrade'
// listener below delegates to it so paths never destroy each other's sockets.
const agentBridge = attachAgentBridge(server)

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname === '/api/jarvis/stt/stream') {
    handleSttStreamUpgrade(req, socket, head)
  } else if (url.pathname === '/api/jarvis/tts/ws') {
    handleJarvisTtsStreamUpgrade(req, socket, head)
  } else if (url.pathname === '/api/skills/bus') {
    handleSkillBusUpgrade(req, socket, head)
  } else if (url.pathname === '/api/mobile/gesture/ws') {
    handleMobileGestureUpgrade(req, socket, head)
  } else if (agentBridge.handleUpgrade(req, socket, head)) {
    // claimed by the agent bridge (/api/jarvis/agent/ws)
  } else {
    socket.destroy()
  }
})

// Start warming the persistent Claude session immediately at boot (app launch,
// even while DORMANT) so the first voice turn doesn't pay the cold-start.
warmupSpeechSession()

// One-time vault cleanup: collapse stray speaker folders into the owner so
// reads always hit the right place.
try { migrateStraySpeakers() } catch (e) { console.warn('[obsidian] migrate skipped:', e?.message) }

// Watch vault for new PDFs → convert to .md → delete PDF.
startPdfWatcher().catch((e) => console.warn('[pdfWatcher] start failed:', e?.message))

// Cloudflare quick tunnel — public HTTPS URL for mobile QR outside LAN.
startCloudflareTunnel(port)

// Telegram reminder scheduler — fires due reminders even while DORMANT.
startScheduler()

await loadDynamicRoutes()
server.listen(port, host, () => console.log(`Jarvis backend on http://${host}:${port}`))
