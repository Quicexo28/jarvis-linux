import fs from 'fs'
import path from 'path'
import { homedir } from 'os'

// Override via JARVIS_CLOUD_ROOT; defaults match the Windows host layout and
// its ~/SyncthingCloud equivalent on Linux.
const SANTI_CLOUD_ROOT = process.env.JARVIS_CLOUD_ROOT
  || (process.platform === 'win32'
    ? 'D:\\SyncthingCloud\\Uploads\\TelegramCloud\\Santi'
    : path.join(homedir(), 'SyncthingCloud', 'Uploads', 'TelegramCloud', 'Santi'))
const SANTI_CHAT_ID = 2017358997
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'])

function resolveCategory(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (PHOTO_EXT.has(ext)) return 'Fotos'
  if (VIDEO_EXT.has(ext)) return 'Videos'
  return 'Documentos'
}

function datedDir(category) {
  const d = new Date()
  const dir = path.join(
    SANTI_CLOUD_ROOT,
    category,
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function stampedName(filename) {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}__${filename}`
}

/**
 * Write string/Buffer content directly to Santi's cloud folder.
 * Returns { path, category, filename }.
 */
export function saveToCloud(content, filename, category) {
  const cat = category || resolveCategory(filename)
  const name = stampedName(filename)
  const outPath = path.join(datedDir(cat), name)
  fs.writeFileSync(outPath, typeof content === 'string' ? content : Buffer.from(content))
  return { path: outPath, category: cat, filename: name }
}

/**
 * Copy an existing local file into Santi's cloud.
 * Returns { path, category, filename }.
 */
export function copyToCloud(sourcePath, category) {
  const filename = path.basename(sourcePath)
  const cat = category || resolveCategory(filename)
  const name = stampedName(filename)
  const outPath = path.join(datedDir(cat), name)
  fs.copyFileSync(sourcePath, outPath)
  return { path: outPath, category: cat, filename: name }
}

/**
 * List recent files from Santi's cloud.
 * category: 'Fotos' | 'Videos' | 'Documentos' | null (all categories)
 */
export function listCloudFiles(category, limit = 10) {
  const cats = category ? [category] : ['Fotos', 'Videos', 'Documentos']
  const files = []
  for (const cat of cats) {
    const root = path.join(SANTI_CLOUD_ROOT, cat)
    if (!fs.existsSync(root)) continue
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else files.push({ path: p, category: cat, filename: path.basename(p) })
      }
    }
    walk(root)
  }
  return files
    .sort((a, b) => fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs)
    .slice(0, limit)
}

// Core Telegram sender — picks message vs media call from filePath ext.
async function sendTelegram(token, chatId, text, filePath) {
  if (!token) return false
  const api = `https://api.telegram.org/bot${token}`
  try {
    if (filePath && fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase()
      const isPhoto = PHOTO_EXT.has(ext)
      const isVideo = VIDEO_EXT.has(ext)
      const field  = isPhoto ? 'photo' : isVideo ? 'video' : 'document'
      const method = isPhoto ? 'sendPhoto' : isVideo ? 'sendVideo' : 'sendDocument'
      const form = new FormData()
      form.set('chat_id', String(chatId))
      form.set('caption', text)
      form.set(field, new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
      const r = await fetch(`${api}/${method}`, { method: 'POST', body: form })
      return r.ok
    }
    const r = await fetch(`${api}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    return r.ok
  } catch {
    return false
  }
}

/**
 * Notify Santi via the Cloud bot (TELEGRAM_BOT_TOKEN).
 * Used by cloud_save (file uploads) — keep distinct from the Jarvis bot.
 */
export async function notifySanti(text, filePath) {
  return sendTelegram(process['env']['TELEGRAM_BOT_TOKEN'], SANTI_CHAT_ID, text, filePath)
}

/**
 * Send via the dedicated Jarvis bot (TELEGRAM_BOT_TOKEN_JARVIS) for reminders
 * and on-demand notifications. Falls back to the cloud bot if the Jarvis token
 * isn't configured yet, so the feature degrades gracefully.
 */
export async function notifyJarvis(text, filePath) {
  const env = process['env']
  const token = env['TELEGRAM_BOT_TOKEN_JARVIS'] || env['TELEGRAM_BOT_TOKEN']
  const chatId = env['TELEGRAM_CHAT_ID_JARVIS'] || SANTI_CHAT_ID
  if (!env['TELEGRAM_BOT_TOKEN_JARVIS']) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN_JARVIS not set — falling back to cloud bot')
  }
  return sendTelegram(token, chatId, text, filePath)
}
