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
import { spawn } from 'node:child_process'
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

// --- Reglas de organización de la bóveda (ver ~/Jarvis-Vault/CLAUDE.md) ------

// Tras cada escritura corre 00-System/auto-linker.py (debounced) para que las
// menciones queden conectadas al grafo sin esperar al timer systemd de 15 min.
let linkerTimer = null
function scheduleAutoLinker() {
  if (!isConfigured()) return
  const script = join(getVaultPath(), '00-System', 'auto-linker.py')
  if (!existsSync(script)) return
  if (linkerTimer) clearTimeout(linkerTimer)
  linkerTimer = setTimeout(() => {
    linkerTimer = null
    try {
      const p = spawn('python3', [script], { stdio: 'ignore', detached: true })
      p.on('error', () => {})
      p.unref()
    } catch {}
  }, 15_000)
  if (typeof linkerTimer.unref === 'function') linkerTimer.unref()
}

// Reusa una carpeta/nota existente que solo difiere en mayúsculas/acentos/guiones
// (el LLM dice "fisica" pero la carpeta es "Fisica"; "tiempo de vuelo" vs
// "Tiempo-de-Vuelo") para no crear hermanos casi-duplicados.
function matchExistingEntry(parent, wanted) {
  if (!existsSync(parent)) return null
  try {
    for (const entry of readdirSync(parent)) {
      const base = entry.replace(/\.md$/i, '')
      if (slugify(base) === slugify(wanted)) return base
    }
  } catch {}
  return null
}

// "física de partículas" → "Fisica-De-Particulas" (estilo de carpetas/hubs)
function titleKebab(s) {
  const words = slugify(s).split('-').filter(Boolean)
  if (!words.length) return 'Sin-Tema'
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-')
}

// Aliases SIEMPRE en minúsculas (contrato del auto-linker: coinciden con cómo
// se menciona el tema hablando). Sin aliases explícitos, cae al título.
function lcAliases(aliases, fallback) {
  const list = (Array.isArray(aliases) ? aliases : [])
    .map(a => String(a ?? '').trim().toLowerCase()).filter(Boolean)
  if (!list.length && fallback) {
    const t = String(fallback).toLowerCase().replace(/…$/, '').trim()
    if (t) list.push(t)
  }
  return [...new Set(list)]
}

function yamlList(items) {
  return `[${items.map(x => JSON.stringify(String(x))).join(', ')}]`
}

// [[YYYY-MM-DD]] si hoy hay transcripción en 06-Conversaciones/
function todaysConversationLink() {
  const date = todayIso()
  const file = join(getVaultPath(), '06-Conversaciones', `${date}.md`)
  return existsSync(file) ? `[[${date}]]` : null
}

// Merge de alias hablados de una hub en 00-System/linker-aliases.json.
// Solo toca la clave de la hub — preserva "_exclude" y el resto del mapa.
function registerLinkerAliases(hubName, aliases) {
  if (!aliases.length) return
  const file = join(getVaultPath(), '00-System', 'linker-aliases.json')
  let map = {}
  try { map = JSON.parse(readFileSync(file, 'utf-8')) } catch {}
  if (typeof map !== 'object' || map === null || Array.isArray(map)) map = {}
  const current = Array.isArray(map[hubName]) ? map[hubName] : []
  const merged = [...new Set([...current, ...aliases])]
  if (merged.length === current.length) return
  map[hubName] = merged
  try { writeFileSync(file, JSON.stringify(map, null, 2) + '\n', 'utf-8') } catch {}
}

// Inserta una línea de lista bajo un heading (al final de su bloque), o crea
// la sección al final del archivo si no existe. No duplica si el archivo ya
// enlaza la nota.
function appendUnderHeading(file, heading, line) {
  try {
    if (!existsSync(file)) return
    const existing = readFileSync(file, 'utf-8')
    const target = line.match(/\[\[([^\]]+)\]\]/)?.[1]
    if (target && existing.includes(`[[${target}]]`)) return
    const lines = existing.split('\n')
    const h = lines.findIndex(l => l.trim() === heading)
    if (h === -1) {
      appendFileSync(file, (existing.endsWith('\n') ? '' : '\n') + `\n${heading}\n\n${line}\n`, 'utf-8')
      return
    }
    let end = h + 1
    while (end < lines.length && !/^#{1,6} /.test(lines[end])) end++
    while (end > h + 1 && lines[end - 1].trim() === '') end--
    lines.splice(end, 0, line)
    writeFileSync(file, lines.join('\n'), 'utf-8')
  } catch {}
}

// Garantiza la nota hub del tema (<Tema>/<Tema>.md) y su registro en la rama
// Conocimiento del cerebro (02-Proyectos/Jarvis.md → ## Cerebro).
function ensureThemeHub(root, themeDir, theme) {
  const hubFile = join(themeDir, `${theme}.md`)
  if (existsSync(hubFile)) return
  const spoken = theme.toLowerCase().replace(/-/g, ' ')
  const fm = `---\naliases: ${yamlList([spoken])}\ntags: ${yamlList([slugify(theme), 'conocimiento'])}\n---\n\n# ${theme}\n\nHub del conocimiento de ${spoken}. Rama del cerebro de [[Jarvis]].\n`
  try { writeFileSync(hubFile, fm, 'utf-8') } catch { return }
  registerLinkerAliases(theme, [spoken])
  appendUnderHeading(join(root, '02-Proyectos', 'Jarvis.md'), '## Cerebro', `- **Conocimiento:** [[${theme}]]`)
}

// Crea la nota hub de un experimento/serie si falta (en <Tema>/Experimentos/)
// y registra la nueva nota de datos en su tabla resumen. Si la hub existente
// no tiene tabla, cae a una línea de lista para no romper el markdown.
function appendToHub(hubDir, hubName, noteName, hubAliases, theme, themeHubFile) {
  const hubFile = join(hubDir, `${hubName}.md`)
  const row = `| [[${noteName}]] | ${todayIso()} |`
  try {
    if (!existsSync(hubFile)) {
      const fm = `---\naliases: ${yamlList(hubAliases)}\ntags: [experimento, hub]\n---\n\n# ${hubName}\n\n## Notas\n\n| Nota | Fecha |\n|---|---|\n${row}\n\n## Relacionado\n\n- Tema: [[${theme}]]\n`
      writeFileSync(hubFile, fm, 'utf-8')
      appendUnderHeading(themeHubFile, '## Experimentos', `- [[${hubName}]]`)
    } else {
      const existing = readFileSync(hubFile, 'utf-8')
      if (!existing.includes(`[[${noteName}]]`)) {
        const lines = existing.split('\n')
        let idx = -1
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].trim().startsWith('|')) { idx = i; break }
        }
        if (idx >= 0) {
          lines.splice(idx + 1, 0, row)
          writeFileSync(hubFile, lines.join('\n'), 'utf-8')
        } else {
          appendFileSync(hubFile, (existing.endsWith('\n') ? '' : '\n') + `- [[${noteName}]] — ${todayIso()}\n`, 'utf-8')
        }
      }
    }
    registerLinkerAliases(hubName, hubAliases)
  } catch {}
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
    scheduleAutoLinker()
    return { ok: true, file, title }
  } catch (e) {
    return { skipped: true, reason: 'write_failed', detail: String(e) }
  }
}

/**
 * Crea una nota siguiendo las reglas de organización de la bóveda
 * (~/Jarvis-Vault/CLAUDE.md — nunca en la raíz):
 *  - project → 02-Proyectos/<Proyecto>.md (append de sección; nunca duplica la nota)
 *  - area    → 03-Conocimiento/<Tema>/ ('ia'|'fisica'|'programacion' o tema libre;
 *              crea el tema con su nota hub colgada del cerebro [[Jarvis]])
 *  - series  → hub en <Tema>/Experimentos/<Hub>.md + nota en Experimentos/Datos/;
 *              la nota queda en la tabla de la hub y termina con `**Experimento:** [[Hub]]`
 *  - frontmatter con aliases en minúsculas (obligatorios: los usa el auto-linker) y tags
 *  - `**Origen:** [[YYYY-MM-DD]]` si existe la conversación del día
 * Tras escribir dispara el auto-linker (debounced) para conectar el grafo.
 */
export async function writeNote(speakerName, { title, body, tags, area, aliases, project, series } = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'not_configured' }
  const root = getVaultPath()

  const text = String(body ?? '').trim() || '(sin texto)'
  const derivedTitle = title || deriveTitle(text)
  const aliasList = lcAliases(aliases, derivedTitle)
  const tagList = Array.isArray(tags) ? tags.map(t => String(t ?? '').trim()).filter(Boolean) : []
  const convoLink = todaysConversationLink()

  // Información de proyecto: actualiza la nota existente, no crea duplicados.
  if (project) {
    const projDir = join(root, '02-Proyectos')
    if (!ensureDir(projDir)) return { skipped: true, reason: 'mkdir_failed' }
    const name = matchExistingEntry(projDir, project) || titleKebab(project)
    const file = join(projDir, `${name}.md`)
    const origin = convoLink ? `\n**Origen:** ${convoLink}\n` : ''
    const section = `\n## ${todayIso()} — ${derivedTitle}\n\n${text}\n${origin}`
    try {
      if (!existsSync(file)) {
        const fm = `---\naliases: ${yamlList(lcAliases(aliases, project))}\ntags: ${yamlList(['proyecto', ...tagList])}\n---\n\n# ${name}\n`
        writeFileSync(file, fm + section, 'utf-8')
      } else {
        appendFileSync(file, section, 'utf-8')
      }
      scheduleAutoLinker()
      return { ok: true, file, title: derivedTitle }
    } catch (e) {
      return { skipped: true, reason: 'write_failed', detail: String(e) }
    }
  }

  // Conocimiento por tema: carpetas conocidas o tema libre bajo 03-Conocimiento/.
  // Cada tema tiene nota hub (<Tema>/<Tema>.md) colgada del cerebro ([[Jarvis]]).
  const areaMap = { ia: 'IA-LLMs-Agentes', fisica: 'Fisica', programacion: 'Programacion' }
  const conocimiento = join(root, '03-Conocimiento')
  const key = String(area ?? '').trim().toLowerCase()
  const theme = areaMap[key]
    || (key ? (matchExistingEntry(conocimiento, key) || titleKebab(key)) : 'IA-LLMs-Agentes')
  const themeDir = join(conocimiento, theme)
  if (!ensureDir(themeDir)) return { skipped: true, reason: 'mkdir_failed' }
  ensureThemeHub(root, themeDir, theme)
  const themeHubFile = join(themeDir, `${theme}.md`)
  let dir = themeDir

  // Serie (mediciones, sesiones, capítulos): hub en <Tema>/Experimentos/,
  // notas de datos en <Tema>/Experimentos/Datos/ (estructura de la bóveda).
  let hubName = null
  let hubDir = null
  if (series) {
    hubDir = join(themeDir, 'Experimentos')
    if (!ensureDir(hubDir)) return { skipped: true, reason: 'mkdir_failed' }
    hubName = matchExistingEntry(hubDir, series) || titleKebab(series)
    dir = join(hubDir, 'Datos')
    if (!ensureDir(dir)) return { skipped: true, reason: 'mkdir_failed' }
  }

  const slug = slugify(derivedTitle)
  let noteName = slug
  let file = join(dir, `${noteName}.md`)
  for (let i = 2; existsSync(file); i++) {
    noteName = `${slug}-${i}`
    file = join(dir, `${noteName}.md`)
  }

  const fmLines = [`aliases: ${yamlList(aliasList)}`]
  if (tagList.length) fmLines.push(`tags: ${yamlList(tagList)}`)
  fmLines.push(`created: ${isoNow()}`)

  // Vínculo padre obligatorio: la hub del experimento para notas de serie,
  // la hub del tema para el resto. + conversación de origen si existe.
  const footerLinks = []
  if (hubName) footerLinks.push(`**Experimento:** [[${hubName}]]`)
  else footerLinks.push(`**Tema:** [[${theme}]]`)
  if (convoLink) footerLinks.push(`**Origen:** ${convoLink}`)
  const footer = `\n---\n\n${footerLinks.join('\n')}\n`

  const content = `---\n${fmLines.join('\n')}\n---\n\n# ${derivedTitle}\n\n${text}\n${footer}`

  try {
    writeFileSync(file, content, 'utf-8')
    if (hubName) {
      const spoken = String(series).toLowerCase().replace(/-/g, ' ').trim()
      const hubAliases = [...new Set([spoken, String(series).toLowerCase().trim()])].filter(Boolean)
      appendToHub(hubDir, hubName, noteName, hubAliases, theme, themeHubFile)
    }
    scheduleAutoLinker()
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
    scheduleAutoLinker()
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
    scheduleAutoLinker()
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

// --- Productividad: tareas del día y marcarlas como hechas ---

function normTask(s) {
  return String(s || '')
    .replace(/_\([^)]*\)_\s*$/, '')          // la marca "_(hh:mm:ss · voice)_" que añade writeTask
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Open and done tasks of today's daily note, plus how many are still open in
 * the previous six days (tasks carried over).
 */
export function tasksForToday() {
  const empty = { open: [], done: [], carriedOver: 0 }
  if (!isConfigured()) return empty
  const dir = join(getVaultPath(), '05-Daily')
  if (!existsSync(dir)) return empty
  try {
    const today = `${todayIso()}.md`
    const out = { open: [], done: [], carriedOver: 0 }
    const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, 7)
    for (const f of files) {
      const content = readFileSync(join(dir, f), 'utf-8')
      for (const m of content.matchAll(/^- \[( |x|X)\] (.+)$/gm)) {
        const text = m[2].replace(/\s*_\([^)]*\)_\s*$/, '').trim()
        if (f === today) (m[1] === ' ' ? out.open : out.done).push(text)
        else if (m[1] === ' ') out.carriedOver++
      }
    }
    return out
  } catch {
    return empty
  }
}

/**
 * Tick the open task (last 7 daily notes, newest first) that best matches
 * `text`: exact normalized match, else the one that contains it, else the one
 * it contains. Ambiguity is reported instead of guessed — ticking the wrong
 * task is worse than asking.
 */
export async function completeTask(text) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' }
  const want = normTask(text)
  if (!want) return { ok: false, error: 'text_requerido' }
  const dir = join(getVaultPath(), '05-Daily')
  if (!existsSync(dir)) return { ok: false, error: 'sin_tareas' }
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, 7)
  const candidates = []
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf-8').split('\n')
    lines.forEach((line, i) => {
      const m = line.match(/^- \[ \] (.+)$/)
      if (m) candidates.push({ file: f, line: i, text: m[1], norm: normTask(m[1]) })
    })
  }
  const pick = (pred) => candidates.filter(pred)
  let hits = pick((c) => c.norm === want)
  if (!hits.length) hits = pick((c) => c.norm.includes(want))
  if (!hits.length) hits = pick((c) => want.includes(c.norm))
  if (!hits.length) return { ok: false, error: 'no_encontrada', open: candidates.slice(0, 10).map((c) => normTask(c.text)) }
  const distinct = [...new Set(hits.map((h) => h.norm))]
  if (distinct.length > 1) return { ok: false, error: 'ambigua', matches: distinct.slice(0, 5) }
  const h = hits[0]
  const path = join(dir, h.file)
  const lines = readFileSync(path, 'utf-8').split('\n')
  lines[h.line] = lines[h.line].replace('- [ ]', '- [x]')
  writeFileSync(path, lines.join('\n'), 'utf-8')
  return { ok: true, task: h.text.replace(/\s*_\([^)]*\)_\s*$/, '').trim(), file: h.file }
}

/** One line per check-in in 04-Habitos/<Hábito>.md (the SQLite log is the source of truth). */
export function appendHabitEntry(label, note) {
  if (!isConfigured()) return
  const name = String(label || '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 60)
  if (!name) return
  try {
    const dir = join(getVaultPath(), '04-Habitos')
    if (!ensureDir(dir)) return
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    const file = join(dir, `${title}.md`)
    if (!existsSync(file)) {
      writeFileSync(file, `---\naliases: [${name.toLowerCase()}]\ntags: [habito]\n---\n\n# ${title}\n\nRegistro de hábito llevado por Jarvis.\n\n`, 'utf-8')
    }
    appendFileSync(file, `- ${todayIso()} ${timeHms().slice(0, 5)}${note ? ` · ${String(note).replace(/\n/g, ' ')}` : ''}\n`, 'utf-8')
  } catch {}
}
