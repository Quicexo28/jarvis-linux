/**
 * Web auth — token gate for every non-local HTTP request and WS upgrade.
 *
 * Local clients (Tauri/Chromium renderer, MCP server, Python services,
 * Hyprland keybinds) bypass the gate entirely, so the desktop app keeps
 * working even with no token configured.
 *
 * IMPORTANT: `tailscale serve` terminates TLS locally and proxies to this
 * port, so remote traffic arrives on the socket AS loopback. The proxy always
 * injects X-Forwarded-For, and a direct remote client cannot fake a loopback
 * socket address — therefore "local" means loopback socket AND no
 * X-Forwarded-For header. Never weaken this to socket address alone.
 *
 * Remote clients must present JARVIS_WEB_TOKEN (persistent, from
 * secrets.local.json) or the active mobile QR session token, via
 * `Authorization: Bearer`, `?token=` or the jarvis_auth cookie (set by
 * /api/mobile/auth so plain fetch()/WebSocket call sites inherit auth
 * without per-call changes).
 *
 * Dangerous endpoints (shell exec, power, PC control, voice identity…) stay
 * local-only regardless of token; JARVIS_WEB_ALLOW_PATHS (comma-separated
 * exact paths or prefixes ending in '/') can deliberately unlock specific
 * ones for remote use.
 */
import { env } from 'node:process'
import { getSession } from '../state/mobileSession.js'

// No token required — these validate themselves or must stay reachable.
const PUBLIC_PATHS = new Set([
  '/health',
  '/api/mobile/auth', // validates the token in its own body
])
// Self-authenticating prefixes (MOBILE_INGEST_TOKEN / session token checked
// inside the handler — keeps the ingest token scoped to ctx ingestion only).
const SELF_AUTH_PREFIXES = ['/api/mobile/ctx/']

// Local-only regardless of token. Entries ending in '/' match as prefixes.
const DANGEROUS_PATHS = [
  '/api/skills/system/terminal',
  '/api/skills/system/launch',
  '/api/skills/system/power',
  '/api/skills/system/process',
  '/api/skills/code/',
  '/api/skills/file/pick',
  '/api/pc/',
  '/api/security/unlock',
  '/api/speaker-id/',
  '/api/agents/rpc', // can trigger remote exec/fs — local brain only
  '/api/agents/wake', // can power on remote machines — local brain only
]

function matchesList(pathname, list) {
  return list.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p))
}

function allowedRemotePaths() {
  return (env.JARVIS_WEB_ALLOW_PATHS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** True only for a loopback socket with no proxy header (see module doc). */
export function isLocal(req) {
  const addr = req.socket?.remoteAddress ?? ''
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  return loopback && !req.headers['x-forwarded-for']
}

/** Effective client address: first X-Forwarded-For hop when proxied locally. */
export function clientAddress(req) {
  const fwd = req.headers['x-forwarded-for']
  const addr = req.socket?.remoteAddress ?? ''
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (loopback && fwd) return String(fwd).split(',')[0].trim()
  return addr
}

function extractToken(req) {
  const auth = req.headers['authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  try {
    const q = new URL(req.url, 'http://localhost').searchParams.get('token')
    if (q) return q
  } catch {}
  const cookies = req.headers['cookie']
  if (cookies) {
    const m = /(?:^|;\s*)jarvis_auth=([^;]+)/.exec(cookies)
    if (m) return decodeURIComponent(m[1])
  }
  return null
}

export function isValidToken(token) {
  if (!token) return false
  const webToken = env.JARVIS_WEB_TOKEN
  if (webToken && token === webToken) return true
  const session = getSession()
  if (session.activated && token === session.token) return true
  return false
}

/**
 * Gate for HTTP dispatch and WS upgrades.
 * @returns {{ok: true}|{ok: false, code: number, error: string}}
 */
export function authorize(req) {
  const pathname = req.url.split('?')[0]
  const local = isLocal(req)

  if (!local && matchesList(pathname, DANGEROUS_PATHS) && !matchesList(pathname, allowedRemotePaths())) {
    return { ok: false, code: 403, error: 'remote_forbidden' }
  }
  if (local) return { ok: true }
  if (PUBLIC_PATHS.has(pathname)) return { ok: true }
  if (SELF_AUTH_PREFIXES.some((p) => pathname.startsWith(p))) return { ok: true }
  if (isValidToken(extractToken(req))) return { ok: true }
  return { ok: false, code: 401, error: 'unauthorized' }
}
