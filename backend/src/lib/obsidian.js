/**
 * Obsidian vault integration.
 *
 * Todas las operaciones son no-op si la env var JARVIS_OBSIDIAN_VAULT no
 * apunta a un directorio existente, para que Jarvis siga funcionando
 * exactamente igual aunque el usuario no haya instalado Obsidian todavía.
 *
 * Etapas (ver docs/obsidian-integration-spec.md):
 *  A. ✅ Cimientos (vault skeleton + status endpoint).
 *  B. ✅ Escrituras pasivas (device-actions, history).
 *  C. ⏳ Intent-driven writes (tasks, notes, personalization).
 *  D. ⏳ Lectura via Local REST API plugin.
 */

import { existsSync, mkdirSync, statSync, appendFileSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'

const SKELETON_DIRS = [
  '00-System',
  '01-Perfil',
  '02-Proyectos',
  '03-Conocimiento/IA-LLMs-Agentes',
  '03-Conocimiento/Fisica',
  '03-Conocimiento/Programacion',
  '04-Habitos',
  '05-Daily',
  '06-Conversaciones',
  '_Templates',
]

export function getVaultPath() {
  const raw = process['env'].JARVIS_OBSIDIAN_VAULT
  if (!raw) return null
  const trimmed = raw.trim()
  return trimmed || null
}

export function isConfigured() {
  const path = getVaultPath()
  if (!path) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function ensureSkeleton() {
  if (!isConfigured()) return false
  const root = getVaultPath()
  for (const dir of SKELETON_DIRS) {
    const full = join(root, dir)
    if (!existsSync(full)) {
      try { mkdirSync(full, { recursive: true }) } catch {}
    }
  }
  return true
}

function getApiUrl() {
  return process['env'].JARVIS_OBSIDIAN_API_URL || 'https://localhost:27124'
}

function getApiKey() {
  return process['env'].JARVIS_OBSIDIAN_API_KEY || null
}

// HEAD/GET against the plugin. The Local REST API plugin uses a
// self-signed cert by default on HTTPS — tolerate it for THIS request only.
function probeUrl(rawUrl, { headers = {}, timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(rawUrl) } catch { return resolve({ status: 0, ok: false }) }
    const lib = u.protocol === 'https:' ? https : http
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      rejectUnauthorized: false,  // localhost self-signed
    }
    const req = lib.request(opts, (res) => {
      const status = res.statusCode ?? 0
      resolve({ status, ok: status >= 200 && status < 300 })
      res.resume()
    })
    req.on('error', () => resolve({ status: 0, ok: false }))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, ok: false }) })
    req.end()
  })
}

async function checkRestApiReachable() {
  const url = getApiUrl()
  const key = getApiKey()
  const headers = key ? { Authorization: `Bearer ${key}` } : {}
  const { status, ok } = await probeUrl(url, { headers })
  // 200 = authed OK · 401 = plugin alive but key missing/wrong
  return ok || status === 401
}

export async function getStatus() {
  const configured = isConfigured()
  const vaultPath = getVaultPath()
  const restApiReachable = configured ? await checkRestApiReachable() : false
  return {
    configured,
    vaultPath,
    restApiReachable,
    skeletonReady: configured && SKELETON_DIRS.every(d => existsSync(join(vaultPath, d))),
  }
}

// --- Helpers ---

// Reserved chars on Windows + Obsidian-unfriendly chars. Keep accents and
// spaces (Obsidian handles unicode + spaces in note names just fine).
const INVALID_PATH_CHARS = /[\\/:*?"<>|]/g

function sanitizeName(name) {
  const cleaned = String(name ?? '').replace(INVALID_PATH_CHARS, '').trim()
  return cleaned || 'Unknown'
}

// Canonical owner: this is a single-user assistant, so every read/write must
// land in ONE speaker folder. STT emits "default" (single-profile fallback) and
// the frontend sends null when speaker confidence dips (-> "Unknown"), which
// scattered data across Speakers/default, Speakers/Unknown and the real folder.
// Collapse all of those to the owner so Jarvis always sees its own notes/tasks.
const OWNER_NAME = () => (process['env'].JARVIS_OWNER_NAME || 'Santiago').trim()
const STRAY_SPEAKERS = new Set(['', 'unknown', 'default'])

function resolveOwner(name) {
  const raw = String(name ?? '').trim()
  if (STRAY_SPEAKERS.has(raw.toLowerCase())) return sanitizeName(OWNER_NAME())
  return sanitizeName(raw)
}

function todayIso() {
  // YYYY-MM-DD in local time (not UTC) — matches user's expectation of "today".
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeHms() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function ensureDir(path) {
  if (!existsSync(path)) {
    try { mkdirSync(path, { recursive: true }) } catch { return false }
  }
  return true
}

function isoNow() {
  return new Date().toISOString()
}

function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled'
}

function deriveTitle(text) {
  const cleaned = String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (cleaned.length <= 60) return cleaned
  return cleaned.slice(0, 60).trim() + '…'
}

// --- Etapa C — intent-driven writes ---

export async function writeTask(speakerName, { text, source, mode } = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' }
  const root = getVaultPath()
  const dir = join(root, '05-Daily')
  if (!ensureDir(dir)) return { skipped: true, reason: 'mkdir_failed' }

  const date = todayIso()
  const file = join(dir, `${date}.md`)
  const body = String(text ?? '').trim() || '(sin texto)'
  const title = deriveTitle(body)
  const entry = `- [ ] ${body} _(${timeHms()} · ${source || 'voice'})_\n`

  try {
    if (!existsSync(file)) {
      const header = `# Daily — ${date}\n\n**Generado por**: Jarvis\n\n---\n\n## Tareas\n\n`
      writeFileSync(file, header + entry, 'utf-8')
    } else {
      appendFileSync(file, entry, 'utf-8')
    }
    return { ok: true, file, title }
  } catch (e) {
    return { skipped: true, reason: 'write_failed', detail: String(e) }
  }
}

// area: 'ia' | 'fisica' | 'programacion' | null (default: IA)
export async function writeNote(speakerName, { title, body, tags, area } = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' }
  const root = getVaultPath()

  const areaMap = {
    ia: '03-Conocimiento/IA-LLMs-Agentes',
    fisica: '03-Conocimiento/Fisica',
    programacion: '03-Conocimiento/Programacion',
  }
  const subdir = areaMap[(area || '').toLowerCase()] || '03-Conocimiento/IA-LLMs-Agentes'
  const dir = join(root, subdir)
  if (!ensureDir(dir)) return { skipped: true, reason: 'mkdir_failed' }

  const text = String(body ?? '').trim() || '(sin texto)'
  const derivedTitle = title || deriveTitle(text)
  const slug = slugify(derivedTitle)
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const file = join(dir, `${stamp}-${slug}.md`)

  const tagLine = Array.isArray(tags) && tags.length ? `tags: [${tags.map(t => JSON.stringify(t)).join(', ')}]\n` : ''
  const content = `---\ntype: nota\narea: ${subdir}\ncreated: ${isoNow()}\n${tagLine}---\n\n# ${derivedTitle}\n\n${text}\n`

  try {
    writeFileSync(file, content, 'utf-8')
    return { ok: true, file, title: derivedTitle }
  } catch (e) {
    return { skipped: true, reason: 'write_failed', detail: String(e) }
  }
}

// --- Etapa B — escrituras pasivas ---

/**
 * Append a single device-action line to System/Actions/YYYY-MM-DD.md.
 * Creates the daily file with a header on first call of the day.
 */
export async function appendDeviceAction({ speakerName, deviceLabel, action } = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' }
  const root = getVaultPath()
  const dir = join(root, '00-System')
  if (!ensureDir(dir)) return { skipped: true, reason: 'mkdir_failed' }

  const file = join(dir, 'Jarvis-Log.md')
  const who = resolveOwner(speakerName)
  const label = String(deviceLabel ?? 'Dispositivo')
  const act = String(action ?? 'unknown')
  const line = `\n### [${todayIso()} ${timeHms()}] — ${act}\n- **Tipo**: dispositivo\n- **Detalle**: ${who} · ${label} · \`${act}\`\n- **Resultado**: éxito\n`

  try {
    if (!existsSync(file)) {
      writeFileSync(file, `# Jarvis — Log de Acciones\n${line}`, 'utf-8')
    } else {
      appendFileSync(file, line, 'utf-8')
    }
    return { ok: true, file }
  } catch (e) {
    return { skipped: true, reason: 'write_failed', detail: String(e) }
  }
}

/**
 * Append one conversation turn (user message + assistant reply) to
 * Speakers/<name>/History/YYYY-MM-DD.md.
 */
export async function appendHistoryEntry(speakerName, { userText, assistantReply } = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' }
  const root = getVaultPath()
  const dir = join(root, '06-Conversaciones')
  if (!ensureDir(dir)) return { skipped: true, reason: 'mkdir_failed' }

  const date = todayIso()
  const file = join(dir, `${date}.md`)
  const time = timeHms()
  const user = String(userText ?? '').trim() || '(sin texto)'
  const reply = String(assistantReply ?? '').trim() || '(sin respuesta)'

  const entry = `## ${time}\n**Usuario:** ${user}\n**Jarvis:** ${reply}\n\n`

  try {
    if (!existsSync(file)) {
      const header = `---\ntype: conversacion\ndate: ${date}\n---\n\n# Conversación — ${date}\n\n`
      writeFileSync(file, header + entry, 'utf-8')
    } else {
      appendFileSync(file, entry, 'utf-8')
    }
    return { ok: true, file }
  } catch (e) {
    return { skipped: true, reason: 'write_failed', detail: String(e) }
  }
}

// Appends a learned fact to 01-Perfil/Santiago.md (owner profile)
export async function updatePersonalization(speakerName, { fact } = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' }
  const root = getVaultPath()
  const dir = join(root, '01-Perfil')
  if (!ensureDir(dir)) return { skipped: true, reason: 'mkdir_failed' }

  const file = join(dir, `${sanitizeName(OWNER_NAME())}.md`)
  const factLine = `\n- [${isoNow()}] ${String(fact ?? '').trim()}`

  try {
    if (!existsSync(file)) {
      const who = sanitizeName(OWNER_NAME())
      const header = `---\ntype: perfil\nspeaker: ${who}\nupdated: ${isoNow()}\n---\n\n# Perfil — ${who}\n\n## Hechos aprendidos\n${factLine}\n`
      writeFileSync(file, header, 'utf-8')
    } else {
      appendFileSync(file, factLine + '\n', 'utf-8')
    }
    return { ok: true, file }
  } catch (e) {
    return { skipped: true, reason: 'write_failed', detail: String(e) }
  }
}

// --- Etapa D — lecturas ---

// Reads open tasks from 05-Daily/ (last 7 daily files)
export async function listOpenTasks(speakerName) {
  if (!isConfigured()) return []
  const root = getVaultPath()
  const dir = join(root, '05-Daily')
  if (!existsSync(dir)) return []

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort().reverse()
    const out = []
    for (const f of files.slice(0, 7)) {  // last 7 days
      const content = readFileSync(join(dir, f), 'utf-8')
      const matches = content.matchAll(/^- \[ \] (.+)$/gm)
      for (const m of matches) {
        out.push({ file: f, text: m[1].trim() })
        if (out.length >= 30) break
      }
      if (out.length >= 30) break
    }
    return out
  } catch {
    return []
  }
}

// Searches across all 03-Conocimiento subdirs
export async function searchNotes(speakerName, query) {
  if (!isConfigured()) return []
  const root = getVaultPath()
  const needle = String(query ?? '').toLowerCase().trim()
  if (!needle) return []

  const searchDirs = [
    join(root, '03-Conocimiento', 'IA-LLMs-Agentes'),
    join(root, '03-Conocimiento', 'Fisica'),
    join(root, '03-Conocimiento', 'Programacion'),
    join(root, '01-Perfil'),
    join(root, '02-Proyectos'),
  ]

  const out = []
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_')).sort().reverse()
      for (const f of files) {
        try {
          const content = readFileSync(join(dir, f), 'utf-8')
          if (content.toLowerCase().includes(needle)) {
            const body = content.replace(/^---[\s\S]*?---\n+/, '').trim()
            out.push({ file: f, dir, snippet: body.slice(0, 240) })
            if (out.length >= 5) return out
          }
        } catch {}
      }
    } catch {}
  }
  return out
}

/**
 * No-op: vault v2 uses 01-Perfil/ instead of Speakers/.
 * Kept for backwards compat with server.js call at boot.
 */
export function migrateStraySpeakers() {
  return { ok: true, skipped: true, reason: 'vault_v2_no_speakers' }
}

// Reads owner profile from 01-Perfil/<owner>.md
export async function getPersonalization(speakerName) {
  if (!isConfigured()) return null
  const root = getVaultPath()
  const file = join(root, '01-Perfil', `${sanitizeName(OWNER_NAME())}.md`)
  if (!existsSync(file)) return null
  try {
    const content = readFileSync(file, 'utf-8')
    return content.replace(/^---[\s\S]*?---\n+/, '').trim()
  } catch {
    return null
  }
}
