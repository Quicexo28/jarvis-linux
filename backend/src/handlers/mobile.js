import { env } from 'node:process'
import { json, readBody } from '../lib/http.js'
import { getSession, activateSession, resetSession, isExpired } from '../state/mobileSession.js'
import { getTailscaleIp, getLanIp } from '../lib/tailscale.js'

const PORT = env.PORT ?? '8788'

export async function handleMobileToken(_req, res) {
  if (isExpired()) resetSession()
  const session = getSession()
  const tailscaleIp = await getTailscaleIp()
  const lanIp = getLanIp()
  const lanUrl = `http://${lanIp}:${PORT}`
  const tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${PORT}` : null
  const baseUrl = tailscaleUrl ?? lanUrl
  const qrUrl = `${baseUrl}?token=${session.token}`
  return json(res, 200, {
    token: session.token,
    lanUrl,
    tailscaleUrl,
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
    if (!token || token !== session.token) {
      return json(res, 401, { ok: false, reason: 'invalid' })
    }
    if (isExpired()) {
      return json(res, 401, { ok: false, reason: 'expired' })
    }
    const remoteIp = req.socket?.remoteAddress ?? ''
    const via = remoteIp.startsWith('100.') ? 'tailscale' : 'lan'
    activateSession(req.headers['user-agent'] ?? null, via)
    return json(res, 200, { ok: true, via })
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
