/**
 * Skill manifest — persistent registry of self-built skills so Jarvis can invoke
 * them again on later turns (not just the turn that built them).
 *
 * Each entry: { slug, path, method, description, triggers[], createdAt }.
 * Stored in backend/data/skillManifest.json (gitignored).
 *
 * Also provides invokeRoute(): an in-process call of a { method, path, handler }
 * route, returning the parsed JSON the handler produced — used for auto-invoke
 * right after a build and for matched invocations from speech.js.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Readable } from 'stream'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', '..', 'data')
const MANIFEST_PATH = join(DATA_DIR, 'skillManifest.json')

function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim()
}

/** @returns {Array<{slug,path,method,description,triggers,createdAt}>} */
export function loadManifest() {
  try {
    if (!existsSync(MANIFEST_PATH)) return []
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  } catch {
    return []
  }
}

/** Upsert a skill entry by slug. */
export function saveSkillEntry(entry) {
  mkdirSync(DATA_DIR, { recursive: true })
  const list = loadManifest().filter((e) => e.slug !== entry.slug)
  list.push({ createdAt: new Date().toISOString(), ...entry })
  writeFileSync(MANIFEST_PATH, JSON.stringify(list, null, 2), 'utf8')
  return entry
}

export function removeSkillEntry(slug) {
  const list = loadManifest().filter((e) => e.slug !== slug)
  writeFileSync(MANIFEST_PATH, JSON.stringify(list, null, 2), 'utf8')
}

/**
 * Match an utterance to a built skill by its triggers. Returns the entry or null.
 */
export function findSkillByText(text) {
  const t = norm(text)
  if (!t) return null
  for (const entry of loadManifest()) {
    const triggers = (entry.triggers || []).map(norm).filter(Boolean)
    for (const tr of triggers) {
      if (tr.length >= 4 && (t.includes(tr) || tr.includes(t))) return entry
    }
  }
  return null
}

/**
 * Call a route's handler in-process and return the JSON it emitted.
 * @param {{method:string, path:string, handler:Function}} route
 * @param {object} [body] request body for POST handlers
 * @returns {Promise<any>} parsed JSON response payload
 */
export async function invokeRoute(route, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = route.method
  req.url = route.path
  req.headers = { 'content-type': 'application/json' }

  let captured = ''
  let statusCode = 200
  const res = {
    statusCode,
    setHeader() {},
    end(chunk) { captured = chunk == null ? '' : String(chunk) },
  }

  await route.handler(req, res)
  try { return JSON.parse(captured || '{}') } catch { return { raw: captured } }
}
