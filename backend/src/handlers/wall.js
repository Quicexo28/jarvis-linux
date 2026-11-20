/**
 * Pared — proxy hacia `wall-server` (~/Projects/proyector-simple/server, :8450).
 *
 * La pestaña «Pared» de la app remota (móvil y tablet) maneja el proyector a
 * través de esto: `/api/skills/wall/<ruta>` -> `wall-server` `/api/<ruta>`. El
 * contrato (rutas, cuerpos, tipos) vive en ~/Projects/proyector-simple/PROTOCOL.md
 * y este módulo no lo interpreta: reenvía status y cuerpo tal cual.
 *
 * El token de wall-server se pone AQUÍ, del lado servidor, y nunca viaja al
 * navegador: la app solo tiene el token web de Jarvis, que tampoco se reenvía.
 *
 * Lista blanca: solo las rutas del contrato. Una ruta nueva en wall-server no
 * queda expuesta al móvil hasta que alguien la añada a `WALL_ROUTES`.
 *
 * Alcance: lo mismo que el Mando (no es `DANGEROUS_PATHS`). Lanzar una app en
 * el proyector o mandar una ventana a la pared no ejecuta nada arbitrario; la
 * entrada a ventanas de la pared es solo flechas/Return/Escape (ver contrato).
 * v3 añade el navegador de la pared: puntero, texto y abrir URLs `https:` en
 * un Brave con perfil PROPIO que wall-server pilota por CDP (sin puerto TCP);
 * nada de eso alcanza el escritorio, el teclado ni el ratón del portátil, así
 * que sigue siendo nivel Mando y la tablet (remota) tiene que poder usarlo.
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { json, readRawBody } from '../lib/http.js'

const PREFIX = '/api/skills/wall/'

/** Rutas del contrato que la app puede usar, por método. */
const WALL_ROUTES = {
  GET: new Set(['state', 'windows', 'outputs', 'apps', 'profiles', 'webapps']),
  POST: new Set([
    'cast', 'launch', 'home', 'key', 'text', 'warp', 'calibration', 'favorites',
    // Mapping v2 (el keystone de hardware se descartó: no hay `keystone/reset`)
    'warp/reset', 'profiles', 'profiles/apply',
    // v3: navegador de la pared
    'webapps', 'webapps/open', 'pointer', 'browser/nav', 'av',
  ]),
}

/**
 * Icono de una app del proyector. El paquete Android va en la ruta, así que se
 * valida con la forma de un nombre de paquete: nada de `..`, `/` ni escapes.
 */
const ICON_ROUTE = /^apps\/([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\/icon$/

/**
 * `DELETE /profiles/:name`: el nombre lo escribe el usuario («Salón», «Techo
 * 15»), así que se admite texto, pero nada que cambie la ruta (`/`, `%`,
 * `..`) ni caracteres de control. Se decodifica, se valida y se vuelve a
 * codificar: wall-server recibe siempre una sola componente. El juego de
 * caracteres es el mismo que acepta wall-server (`PROFILE_RE` en su
 * `lib/engine.js`; el contrato solo dice `invalid_profile`) y la UI.
 */
const PROFILE_ROUTE = /^profiles\/([^/]+)$/
const PROFILE_NAME = /^[\p{L}\p{N} ._-]{1,40}$/u

export function validProfileName(name) {
  return typeof name === 'string' && PROFILE_NAME.test(name) && name.trim() === name && !/^\.+$/.test(name)
}

/** Los cuerpos del contrato son JSON pequeños; esto solo corta abusos. */
const MAX_BODY = 64 * 1024

const cfg = () => ({
  url: (process.env.JARVIS_WALL_URL || 'http://127.0.0.1:8450').replace(/\/$/, ''),
  configPath: process.env.JARVIS_WALL_CONFIG || path.join(os.homedir(), '.config', 'wall', 'config.json'),
  timeoutMs: Number(process.env.JARVIS_WALL_TIMEOUT_MS ?? 4000),
})

/**
 * Token de wall-server: el de su propia config (la escribe wall-server) y, si
 * no hay, `JARVIS_WALL_TOKEN`. Se lee en cada petición: el fichero puede
 * aparecer o rotar con el backend ya arrancado.
 */
async function wallToken(configPath) {
  try {
    const conf = JSON.parse(await readFile(configPath, 'utf8'))
    if (typeof conf?.token === 'string' && conf.token) return conf.token
  } catch { /* sin config: cae al env */ }
  return process.env.JARVIS_WALL_TOKEN || null
}

/**
 * Ruta de wall-server para una petición de la app, o null si no está en la
 * lista blanca.
 * @param {string} method
 * @param {string} pathname  p. ej. `/api/skills/wall/state`
 */
export function wallTarget(method, pathname) {
  if (!pathname.startsWith(PREFIX)) return null
  const sub = pathname.slice(PREFIX.length)
  if (WALL_ROUTES[method]?.has(sub)) return `/api/${sub}`
  if (method === 'GET' && ICON_ROUTE.test(sub)) return `/api/${sub}`
  const profile = method === 'DELETE' && PROFILE_ROUTE.exec(sub)
  if (profile) {
    let name
    try { name = decodeURIComponent(profile[1]) } catch { return null }
    return validProfileName(name) ? `/api/profiles/${encodeURIComponent(name)}` : null
  }
  return null
}

/** Mismas cabeceras CORS que `json()`, para respuestas que no son JSON. */
function passthrough(res, status, contentType, buf) {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.end(buf)
}

/** GET|POST|DELETE /api/skills/wall/* */
export async function handleWall(req, res) {
  const pathname = req.url.split('?')[0]
  const target = wallTarget(req.method, pathname)
  if (!target) return json(res, 404, { ok: false, error: 'not_found' })

  const c = cfg()
  let body
  if (req.method === 'POST') {
    try {
      body = await readRawBody(req, MAX_BODY)
    } catch (e) {
      return json(res, e?.code === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, error: e?.code === 'BODY_TOO_LARGE' ? 'body_too_large' : 'bad_body' })
    }
  }

  const token = await wallToken(c.configPath)
  if (!token) return json(res, 503, { ok: false, error: 'wall_not_configured' })

  try {
    const upstream = await fetch(`${c.url}${target}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      // `POST /home` no lleva cuerpo; se manda `{}` para que el server no
      // tenga que distinguir vacío de JSON.
      body: body ? (body.length ? body : '{}') : undefined,
      signal: AbortSignal.timeout(c.timeoutMs),
    })
    // Dentro del mismo try: el timeout también corta un cuerpo que no termina.
    const buf = Buffer.from(await upstream.arrayBuffer())
    const type = upstream.headers.get('content-type') || 'application/octet-stream'
    if (target.endsWith('/icon') && upstream.ok) res.setHeader('Cache-Control', 'private, max-age=86400')
    return passthrough(res, upstream.status, type, buf)
  } catch {
    // Caído, sin arrancar o colgado: para la app es lo mismo.
    return json(res, 503, { ok: false, error: 'wall_offline' })
  }
}
