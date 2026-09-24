/**
 * Vault ingest — el aterrizaje de "Compartir → Jarvis" desde el móvil/tablet.
 *
 * Deliberadamente delgado: su único trabajo es dejar los bytes EN DISCO dentro
 * de la bóveda. `lib/pdfWatcher.js` ya vigila el vault entero de forma recursiva
 * y convierte pdf/docx/jpg/jpeg/png a markdown (OCR spa+eng para imágenes), así
 * que aquí no se reconstruye ningún pipeline: un PDF compartido se vuelve nota
 * legible sin que este fichero sepa nada de PDFs.
 *
 * OJO: el watcher BORRA el original tras convertir. Es la conducta elegida —
 * la bóveda guarda el texto, no el binario. Lo que el watcher no sabe convertir
 * se queda tal cual como adjunto.
 *
 * Auth: webAuth normal (JARVIS_WEB_TOKEN o el token de sesión móvil). NO está
 * en DANGEROUS_PATHS a propósito, porque la tablet tiene que alcanzarlo — pero
 * escribe en disco, así que todo campo del cliente se trata como hostil:
 * allowlist de extensiones, tope de tamaño, y la ruta resuelta se vuelve a
 * comprobar contra la raíz del vault antes de escribir.
 */

import { env } from 'node:process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep, extname, basename } from 'node:path'
import { json, readBody, readRawBody } from '../lib/http.js'
import { getVaultPath, isConfigured } from '../lib/obsidian.js'

/** Subcarpeta destino. Cualquiera valdría (el watcher es recursivo); esta
 *  mantiene lo compartido separado de lo que escribe el propio Jarvis. */
const INBOX = 'Clippings'

/**
 * Allowlist, no denylist: lo que no esté aquí no se escribe. Las cinco primeras
 * las convierte el watcher; el resto aterrizan como adjunto y ahí se quedan.
 */
const ALLOWED_EXT = new Set([
  '.pdf', '.docx', '.jpg', '.jpeg', '.png',
  '.md', '.txt', '.csv', '.json', '.webp', '.gif', '.heic',
  '.rtf', '.odt', '.epub', '.pptx', '.xlsx',
])

/** Las que pdfWatcher sabe convertir a markdown (y cuyo original borra). */
const CONVERTED_EXT = new Set(['.pdf', '.docx', '.jpg', '.jpeg', '.png'])

const MAX_NAME = 96

function maxBytes() {
  const mb = Number(env.JARVIS_VAULT_INGEST_MAX_MB ?? 25)
  return (Number.isFinite(mb) && mb > 0 ? mb : 25) * 1024 * 1024
}

/**
 * Nombre de fichero seguro a partir de uno propuesto por el cliente.
 *
 * Se queda con el basename porque el nombre puede traer separadores de
 * CUALQUIER sistema (`..\..\x`), y quitar sólo `/` dejaría pasar el de Windows.
 * Devuelve null si tras limpiar no queda nada utilizable.
 */
function sanitizeName(raw) {
  const base = String(raw ?? '').split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) return null

  const ext = extname(cleaned).toLowerCase()
  const stem = cleaned.slice(0, cleaned.length - ext.length).trim()
  if (!stem) return null
  return { stem: stem.slice(0, MAX_NAME), ext }
}

/** Primer nombre libre: `foo.pdf`, `foo (2).pdf`, … Evita pisar un adjunto. */
function freePath(dir, stem, ext) {
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? `${stem}${ext}` : `${stem} (${i})${ext}`
    const full = join(dir, name)
    if (!existsSync(full)) return { full, name }
  }
  const name = `${stem} ${Date.now()}${ext}`
  return { full: join(dir, name), name }
}

/**
 * Prepara el destino y verifica que no se sale del vault.
 *
 * El chequeo de contención es defensa en profundidad: `sanitizeName` ya debería
 * hacerlo imposible, pero escribir en disco desde una ruta remota merece que la
 * comprobación viva junto al `writeFileSync`, no sólo tres funciones más arriba.
 */
function targetFor(stem, ext) {
  const root = resolve(getVaultPath())
  const dir = join(root, INBOX)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const { full, name } = freePath(dir, stem, ext)
  const resolved = resolve(full)
  if (resolved !== join(root, INBOX, basename(resolved)) || !resolved.startsWith(root + sep)) {
    return null
  }
  return { full: resolved, name }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function yamlSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim()
}

function deviceOf(value) {
  const d = String(value ?? '').trim().toLowerCase()
  return /^[a-z0-9_-]{1,24}$/.test(d) ? d : 'movil'
}

/**
 * Texto/URL compartidos: se escriben ya como markdown, sin pasar por el watcher
 * (no hay nada que convertir). El título sale del asunto del share, y si no de
 * la primera línea del cuerpo — que es lo que el usuario reconoce en la bóveda.
 */
function ingestText(body) {
  const text = String(body.text ?? '').trim()
  const url = String(body.url ?? '').trim()
  if (!text && !url) return { code: 400, payload: { ok: false, error: 'empty_share' } }

  const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
  const rawTitle = String(body.title ?? '').trim() || firstLine || url || 'Compartido'
  const safe = sanitizeName(`${stamp()} ${rawTitle.slice(0, MAX_NAME)}.md`)
  if (!safe) return { code: 400, payload: { ok: false, error: 'bad_title' } }

  const target = targetFor(safe.stem, '.md')
  if (!target) return { code: 400, payload: { ok: false, error: 'bad_path' } }

  const front = [
    '---',
    'type: clipping',
    `source: ${yamlSafe(url || body.source || 'compartido')}`,
    `device: ${deviceOf(body.device)}`,
    `captured: ${new Date().toISOString()}`,
    'captured_by: jarvis-share',
    '---',
    '',
    `# ${rawTitle}`,
    '',
  ]
  if (url) front.push(url, '')
  if (text && text !== url) front.push(text, '')

  writeFileSync(target.full, front.join('\n'), 'utf-8')
  console.log(`[vaultIngest] nota: ${target.full}`)
  return { code: 200, payload: { ok: true, file: `${INBOX}/${target.name}`, kind: 'note', converted: false } }
}

/**
 * Fichero binario: cuerpo crudo + nombre en `X-Jarvis-Filename`.
 *
 * Se usa una cabecera en vez de multipart porque el único cliente es la app y
 * un parser multipart a mano es superficie de ataque gratuita — el backend no
 * trae ninguno (`handlers/stt.js` CONSTRUYE multipart hacia Python, no lo lee).
 */
async function ingestFile(req) {
  const safe = sanitizeName(req.headers['x-jarvis-filename'])
  if (!safe) return { code: 400, payload: { ok: false, error: 'bad_filename' } }
  if (!ALLOWED_EXT.has(safe.ext)) {
    return { code: 415, payload: { ok: false, error: 'ext_not_allowed', ext: safe.ext } }
  }

  let bytes
  try {
    bytes = await readRawBody(req, maxBytes())
  } catch (error) {
    if (error.code === 'BODY_TOO_LARGE') {
      return { code: 413, payload: { ok: false, error: 'too_large', maxMb: maxBytes() / 1024 / 1024 } }
    }
    return { code: 400, payload: { ok: false, error: 'read_failed', detail: error.message } }
  }
  if (!bytes.length) return { code: 400, payload: { ok: false, error: 'empty_body' } }

  const target = targetFor(safe.stem, safe.ext)
  if (!target) return { code: 400, payload: { ok: false, error: 'bad_path' } }

  writeFileSync(target.full, bytes)
  const converted = CONVERTED_EXT.has(safe.ext)
  console.log(`[vaultIngest] archivo: ${target.full} (${bytes.length} B, convierte=${converted})`)
  return {
    code: 200,
    payload: { ok: true, file: `${INBOX}/${target.name}`, kind: 'file', bytes: bytes.length, converted },
  }
}

export async function handleVaultIngest(req, res) {
  if (!isConfigured()) {
    return json(res, 503, { ok: false, error: 'vault_not_configured' })
  }

  const type = String(req.headers['content-type'] ?? '')
  try {
    if (type.includes('application/json')) {
      const body = await readBody(req)
      const { code, payload } = ingestText(body)
      return json(res, code, payload)
    }
    const { code, payload } = await ingestFile(req)
    return json(res, code, payload)
  } catch (error) {
    console.error('[vaultIngest]', error.message)
    return json(res, 500, { ok: false, error: 'ingest_failed', detail: error.message })
  }
}
