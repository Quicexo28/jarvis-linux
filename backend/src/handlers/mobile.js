import { env } from 'node:process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { json, readBody } from '../lib/http.js'
import { getSession, activateSession, resetSession, isExpired } from '../state/mobileSession.js'
import { getTailscaleIp, getLanIp, getTailscaleServeUrl } from '../lib/tailscale.js'
import { getTunnelUrl } from '../lib/cloudflareTunnel.js'
import { clientAddress } from '../lib/webAuth.js'
import { notifyJarvis } from '../lib/cloudStorage.js'

const PORT = env.PORT ?? '8788'

// Priority: tailscale serve (HTTPS — mic + PWA need a secure context) >
// tailscale IP (VPN) > cloudflare tunnel (opt-in) > LAN.
async function bestBaseUrl() {
  const [serveUrl, tailscaleIp] = await Promise.all([getTailscaleServeUrl(PORT), getTailscaleIp()])
  const lanUrl = `http://${getLanIp()}:${PORT}`
  const tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${PORT}` : null
  const tunnelUrl = getTunnelUrl()
  return { serveUrl, tailscaleUrl, tunnelUrl, lanUrl, baseUrl: serveUrl ?? tailscaleUrl ?? tunnelUrl ?? lanUrl }
}

export async function handleMobileToken(_req, res) {
  if (isExpired()) resetSession()
  const session = getSession()
  const { serveUrl, tailscaleUrl, tunnelUrl, lanUrl, baseUrl } = await bestBaseUrl()
  // Con JARVIS_WEB_TOKEN configurado el QR es PERMANENTE (sobrevive reinicios
  // del backend, un solo escaneo por dispositivo). Sin él, token rotativo.
  const webToken = env.JARVIS_WEB_TOKEN
  const token = webToken ?? session.token
  const qrUrl = `${baseUrl}?token=${token}`
  return json(res, 200, {
    token,
    permanent: !!webToken,
    lanUrl,
    tailscaleUrl,
    tailscaleServeUrl: serveUrl,
    tunnelUrl,
    qrUrl,
    expiresAt: session.expiresAt,
    activated: session.activated,
  })
}

export async function handleMobileAuth(req, res) {
  try {
    const body = await readBody(req)
    const { token } = body
    const session = getSession()
    // Two valid credentials: the persistent web token (secrets.local.json,
    // survives restarts) or the rotating mobile QR session token.
    const isWeb = !!(env.JARVIS_WEB_TOKEN && token === env.JARVIS_WEB_TOKEN)
    if (!token || (!isWeb && token !== session.token)) {
      return json(res, 401, { ok: false, reason: 'invalid' })
    }
    if (!isWeb && isExpired()) {
      return json(res, 401, { ok: false, reason: 'expired' })
    }
    const remoteIp = clientAddress(req)
    const via = remoteIp.startsWith('100.') ? 'tailscale' : 'lan'
    // Cookie so every existing fetch()/WebSocket call site inherits auth on
    // same-origin requests without per-call changes. Secure when served over
    // HTTPS (tailscale serve sets X-Forwarded-Proto).
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
    res.setHeader('Set-Cookie', `jarvis_auth=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=31536000; HttpOnly${secure}`)
    // Also on web-token auth: records device metadata so the desktop panel
    // shows "Sesión activa" after a permanent-QR scan.
    activateSession(req.headers['user-agent'] ?? null, via)
    return json(res, 200, { ok: true, via, scope: isWeb ? 'web' : 'mobile' })
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' })
  }
}

export function handleMobileStatus(_req, res) {
  const session = getSession()
  return json(res, 200, {
    connected: session.activated,
    lastSeen: session.lastSeen,
    via: session.via,
    userAgent: session.userAgent,
  })
}

export async function handleMobileRefresh(_req, res) {
  resetSession()
  return json(res, 200, { ok: true })
}

export async function handleMobileSendQr(_req, res) {
  if (isExpired()) resetSession()
  const session = getSession()
  const { baseUrl, lanUrl } = await bestBaseUrl()

  if (baseUrl === lanUrl) {
    await notifyJarvis('⏳ Sin URL remota (Tailscale caído y sin túnel).\nEl QR solo funcionará dentro de la LAN.')
  }

  const qrUrl = `${baseUrl}?token=${env.JARVIS_WEB_TOKEN ?? session.token}`
  const tmpPath = path.join(os.tmpdir(), 'jarvis-mobile-qr.png')
  try {
    const buf = await QRCode.toBuffer(qrUrl, { type: 'png', width: 400, margin: 2 })
    fs.writeFileSync(tmpPath, buf)
    await notifyJarvis(`📱 QR de conexión mobile.\n🔗 ${qrUrl}`, tmpPath)
    return json(res, 200, { ok: true, qrUrl })
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message })
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}
