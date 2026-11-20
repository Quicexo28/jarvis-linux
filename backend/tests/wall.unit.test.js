/**
 * Proxy de la pared (/api/skills/wall/* -> wall-server /api/*).
 *
 * Lo que importa: el token de wall-server lo pone el backend y no vuelve nunca
 * al cliente, solo pasan las rutas del contrato, el icono llega en binario y un
 * wall-server caído o colgado es un 503 `wall_offline` rápido, no un cuelgue.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from '../src/routes.js'
import { wallTarget, validProfileName } from '../src/handlers/wall.js'

const WALL_TOKEN = 'wall-secret-token-123'
const WEB_TOKEN = 'jarvis-web-token-456'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80])

let upstream, upstreamUrl, front, base
let seen = []
let hang = false

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)))
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
      if (hang) return // nunca contesta
      if (req.url === '/api/apps/com.netflix.ninja/icon') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(PNG)
      }
      if (req.url === '/api/launch') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'projector_offline' }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echo: req.url }))
    })
  })
  upstreamUrl = await listen(upstream)
  front = http.createServer((req, res) => dispatch(req, res))
  base = await listen(front)

  const dir = mkdtempSync(join(tmpdir(), 'jarvis-wall-'))
  const conf = join(dir, 'config.json')
  writeFileSync(conf, JSON.stringify({ token: WALL_TOKEN }))
  process.env.JARVIS_WALL_CONFIG = conf
  process.env.JARVIS_WALL_URL = upstreamUrl
  process.env.JARVIS_WALL_TIMEOUT_MS = '300'
  process.env.JARVIS_WEB_TOKEN = WEB_TOKEN
  delete process.env.JARVIS_WALL_TOKEN
})

afterAll(async () => {
  upstream.closeAllConnections()
  await new Promise((r) => upstream.close(r))
  await new Promise((r) => front.close(r))
  for (const k of ['JARVIS_WALL_CONFIG', 'JARVIS_WALL_URL', 'JARVIS_WALL_TIMEOUT_MS', 'JARVIS_WEB_TOKEN', 'JARVIS_WALL_TOKEN']) delete process.env[k]
})

beforeEach(() => { seen = []; hang = false })

describe('wallTarget (lista blanca)', () => {
  it('mapea las rutas del contrato con su método', () => {
    expect(wallTarget('GET', '/api/skills/wall/state')).toBe('/api/state')
    expect(wallTarget('GET', '/api/skills/wall/apps')).toBe('/api/apps')
    expect(wallTarget('POST', '/api/skills/wall/warp')).toBe('/api/warp')
    expect(wallTarget('POST', '/api/skills/wall/favorites')).toBe('/api/favorites')
    expect(wallTarget('GET', '/api/skills/wall/apps/com.google.android.youtube.tv/icon')).toBe('/api/apps/com.google.android.youtube.tv/icon')
  })

  it('rechaza método equivocado, rutas fuera del contrato y paquetes raros', () => {
    expect(wallTarget('POST', '/api/skills/wall/state')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/cast')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/config')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/apps/../state/icon')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/apps/a%2Fb/icon')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/apps/com.x/icon/extra')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wallx/state')).toBeNull()
  })
})

describe('mapping v2: perfiles y pánico', () => {
  it('las rutas nuevas del contrato pasan con su método', () => {
    expect(wallTarget('GET', '/api/skills/wall/profiles')).toBe('/api/profiles')
    expect(wallTarget('POST', '/api/skills/wall/profiles')).toBe('/api/profiles')
    expect(wallTarget('POST', '/api/skills/wall/profiles/apply')).toBe('/api/profiles/apply')
    expect(wallTarget('POST', '/api/skills/wall/warp/reset')).toBe('/api/warp/reset')
    expect(wallTarget('DELETE', '/api/skills/wall/profiles/Sal%C3%B3n')).toBe('/api/profiles/Sal%C3%B3n')
    expect(wallTarget('DELETE', '/api/skills/wall/profiles/Techo%2015')).toBe('/api/profiles/Techo%2015')
    expect(wallTarget('DELETE', '/api/skills/wall/profiles/sala_v2.1-b')).toBe('/api/profiles/sala_v2.1-b')
  })

  it('el keystone de hardware se descartó: /keystone/reset ya no pasa', () => {
    expect(wallTarget('POST', '/api/skills/wall/keystone/reset')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/keystone/reset')).toBeNull()
  })

  it('DELETE solo para un perfil con nombre válido; nada que cambie la ruta', () => {
    for (const bad of ['..', '.', 'a%2Fb', 'a%5Cb', '%E0%A4%A', 'x/y', '%20lead', 'trail%20', 'a%00b', 'a%25b', 'x'.repeat(41),
      // Lo que wall-server tampoco acepta (`PROFILE_RE`): no tiene sentido mandarlo.
      'Techo%2015%C2%B0', 'Sal%C3%B3n%20(noche)', 'a%2Bb', 'a%23b', 'a%27b']) {
      expect(wallTarget('DELETE', `/api/skills/wall/profiles/${bad}`)).toBeNull()
    }
    expect(wallTarget('DELETE', '/api/skills/wall/state')).toBeNull()
    expect(wallTarget('DELETE', '/api/skills/wall/profiles')).toBeNull()
    expect(wallTarget('DELETE', '/api/skills/wall/webapps')).toBeNull()
    expect(wallTarget('GET', '/api/skills/wall/profiles/apply')).toBeNull()
    expect(validProfileName('Salón noche')).toBe(true)
    expect(validProfileName('x'.repeat(40))).toBe(true)
    expect(validProfileName('Salón (noche)')).toBe(false)
    expect(validProfileName('')).toBe(false)
  })

  it('DELETE llega a wall-server con el nombre recodificado y sin cuerpo', async () => {
    const r = await fetch(`${base}/api/skills/wall/profiles/Mi%20perfil`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/api/profiles/Mi%20perfil', auth: `Bearer ${WALL_TOKEN}`, body: '' })
  })

  it('un nombre inválido no llega a wall-server', async () => {
    const r = await fetch(`${base}/api/skills/wall/profiles/a%2F..%2Fstate`, { method: 'DELETE' })
    expect(r.status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('guardar perfil y pánico reenvían el cuerpo tal cual', async () => {
    await fetch(`${base}/api/skills/wall/profiles`, { method: 'POST', body: JSON.stringify({ name: 'Salón' }) })
    await fetch(`${base}/api/skills/wall/warp/reset`, { method: 'POST' })
    const r = await fetch(`${base}/api/skills/wall/keystone/reset`, { method: 'POST' })
    expect(r.status).toBe(404)
    expect(seen.map((e) => [e.method, e.url, e.body])).toEqual([
      ['POST', '/api/profiles', '{"name":"Salón"}'],
      ['POST', '/api/warp/reset', '{}'],
    ])
  })
})

describe('v3: navegador de la pared', () => {
  it('las rutas v3 pasan con su método y nada más', () => {
    expect(wallTarget('GET', '/api/skills/wall/webapps')).toBe('/api/webapps')
    expect(wallTarget('POST', '/api/skills/wall/webapps')).toBe('/api/webapps')
    expect(wallTarget('POST', '/api/skills/wall/webapps/open')).toBe('/api/webapps/open')
    expect(wallTarget('POST', '/api/skills/wall/pointer')).toBe('/api/pointer')
    expect(wallTarget('POST', '/api/skills/wall/browser/nav')).toBe('/api/browser/nav')
    expect(wallTarget('POST', '/api/skills/wall/av')).toBe('/api/av')
    for (const [m, p] of [['GET', 'webapps/open'], ['GET', 'pointer'], ['GET', 'browser/nav'], ['GET', 'av'],
      ['POST', 'browser'], ['POST', 'browser/nav/x'], ['POST', 'webapps/open/x'], ['GET', 'launcher'], ['POST', 'launcher']]) {
      expect(wallTarget(m, `/api/skills/wall/${p}`)).toBeNull()
    }
  })

  it('reenvían el cuerpo tal cual con el Bearer de wall-server', async () => {
    const bodies = [
      ['webapps/open', { id: 'netflix' }],
      ['webapps/open', { url: 'https://www.youtube.com/tv' }],
      ['webapps', { apps: [{ id: 'youtube', label: 'YouTube', favorite: true }] }],
      ['pointer', { dx: 12, dy: -3 }],
      ['pointer', { scroll: { dx: 0, dy: 80 } }],
      ['browser/nav', { action: 'back' }],
      ['av', { delayMs: 120 }],
    ]
    for (const [p, b] of bodies) {
      const r = await fetch(`${base}/api/skills/wall/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
      expect(r.status).toBe(200)
    }
    expect(seen.map((e) => [e.url, JSON.parse(e.body)])).toEqual(bodies.map(([p, b]) => [`/api/${p}`, b]))
    expect(seen.every((e) => e.auth === `Bearer ${WALL_TOKEN}`)).toBe(true)
  })
})

describe('proxy', () => {
  it('añade el Bearer de wall-server y reenvía el JSON tal cual', async () => {
    const r = await fetch(`${base}/api/skills/wall/state`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, echo: '/api/state' })
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/state', auth: `Bearer ${WALL_TOKEN}` })
  })

  it('reenvía el cuerpo del POST y nunca el token web del cliente', async () => {
    const warp = { mode: 'screen', rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }
    const r = await fetch(`${base}/api/skills/wall/warp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WEB_TOKEN}`, 'X-Forwarded-For': '100.64.0.9' },
      body: JSON.stringify(warp),
    })
    expect(r.status).toBe(200)
    expect(JSON.parse(seen[0].body)).toEqual(warp)
    expect(seen[0].auth).toBe(`Bearer ${WALL_TOKEN}`)
  })

  it('un POST sin cuerpo llega como {}', async () => {
    await fetch(`${base}/api/skills/wall/home`, { method: 'POST' })
    expect(seen[0]).toMatchObject({ url: '/api/home', body: '{}' })
  })

  it('pasa el status de error de wall-server sin tocarlo', async () => {
    const r = await fetch(`${base}/api/skills/wall/launch`, { method: 'POST', body: JSON.stringify({ pkg: 'com.netflix.ninja' }) })
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ ok: false, error: 'projector_offline' })
  })

  it('el icono llega en binario, con su tipo', async () => {
    const r = await fetch(`${base}/api/skills/wall/apps/com.netflix.ninja/icon`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('una ruta fuera de la lista blanca no llega a wall-server', async () => {
    const r = await fetch(`${base}/api/skills/wall/config`)
    expect(r.status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('desde remoto exige el token web, como el Mando', async () => {
    const r = await fetch(`${base}/api/skills/wall/state`, { headers: { 'X-Forwarded-For': '100.64.0.9' } })
    expect(r.status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  it('el token de wall-server no sale en ninguna respuesta', async () => {
    for (const p of ['state', 'apps', 'config']) {
      const r = await fetch(`${base}/api/skills/wall/${p}`)
      const text = await r.text()
      expect(text).not.toContain(WALL_TOKEN)
      expect(JSON.stringify([...r.headers])).not.toContain(WALL_TOKEN)
    }
  })
})

describe('wall-server caído o sin configurar', () => {
  it('colgado: 503 wall_offline al vencer el timeout', async () => {
    hang = true
    const t0 = Date.now()
    const r = await fetch(`${base}/api/skills/wall/state`)
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ ok: false, error: 'wall_offline' })
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('apagado (puerto cerrado): 503 wall_offline', async () => {
    const prev = process.env.JARVIS_WALL_URL
    process.env.JARVIS_WALL_URL = 'http://127.0.0.1:9'
    try {
      const r = await fetch(`${base}/api/skills/wall/state`)
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ ok: false, error: 'wall_offline' })
    } finally {
      process.env.JARVIS_WALL_URL = prev
    }
  })

  it('sin fichero de config usa JARVIS_WALL_TOKEN', async () => {
    const prev = process.env.JARVIS_WALL_CONFIG
    process.env.JARVIS_WALL_CONFIG = join(tmpdir(), 'no-existe-wall', 'config.json')
    process.env.JARVIS_WALL_TOKEN = 'env-token'
    try {
      await fetch(`${base}/api/skills/wall/state`)
      expect(seen[0].auth).toBe('Bearer env-token')
    } finally {
      process.env.JARVIS_WALL_CONFIG = prev
      delete process.env.JARVIS_WALL_TOKEN
    }
  })

  it('sin token en ningún sitio: 503 wall_not_configured y no se llama a wall-server', async () => {
    const prev = process.env.JARVIS_WALL_CONFIG
    process.env.JARVIS_WALL_CONFIG = join(tmpdir(), 'no-existe-wall', 'config.json')
    try {
      const r = await fetch(`${base}/api/skills/wall/state`)
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ ok: false, error: 'wall_not_configured' })
      expect(seen).toHaveLength(0)
    } finally {
      process.env.JARVIS_WALL_CONFIG = prev
    }
  })
})
