import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Override via env var for testing or alternate deployments.
const DEFAULT_DIST = path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist')

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.webp':  'image/webp',
  '.glb':   'model/gltf-binary',
  '.wav':   'audio/wav',
  '.mp3':   'audio/mpeg',
}

/**
 * Try to serve a static file from distPath (defaults to frontend/dist/).
 * Returns true if the response was handled; false to fall through to API routes.
 * Signature: (req, res, distPath?) => Promise<boolean>
 */
export async function serveStatic(req, res, distPath = process.env.JARVIS_FRONTEND_DIST ?? DEFAULT_DIST) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false

  // Reject raw URLs containing path traversal sequences before URL parsing
  // normalizes them away. Covers both encoded (%2e%2e) and literal (../) forms.
  if (/(\.\.(\/|\\|%2f|%5c)|%2e%2e)/i.test(req.url)) return false

  const url = new URL(req.url, 'http://localhost')
  const normalized = path.normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '')
  let filePath = path.join(distPath, normalized)

  // Security: reject any path that escapes distPath after normalization.
  if (!filePath.startsWith(path.resolve(distPath))) return false

  // Never serve static for API routes — let them fall through to dispatch().
  if (url.pathname.startsWith('/api/')) return false

  let stat = null
  try { stat = await fs.stat(filePath) } catch {}

  // SPA fallback: root path or deep paths (depth > 1) with no file extension.
  // Single-segment paths like /health, /modules fall through to dispatch()
  // so backend root-level routes are not masked by the SPA fallback.
  const isSpaCandidate = url.pathname === '/' || url.pathname.split('/').length > 2
  if ((!stat || !stat.isFile()) && !path.extname(url.pathname) && isSpaCandidate) {
    filePath = path.join(distPath, 'index.html')
    try { stat = await fs.stat(filePath) } catch {}
  }

  if (!stat || !stat.isFile()) return false

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME[ext] ?? 'application/octet-stream'

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', stat.size)

  if (req.method === 'HEAD') { res.end(); return true }

  const content = await fs.readFile(filePath)
  res.end(content)
  return true
}
