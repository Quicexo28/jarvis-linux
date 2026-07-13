import fs from 'fs'
import path from 'path'
import os from 'os'

const CLOUD_ROOT = process.env.CLOUD_ROOT
  ?? path.join(os.homedir(), 'SyncthingCloud', 'TelegramCloud', 'Santi')
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
    CLOUD_ROOT,
    category,
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function stampedName(filename) {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}__${filename}`
}

export function saveToCloud(content, filename, category) {
  const cat = category || resolveCategory(filename)
  const name = stampedName(filename)
  const outPath = path.join(datedDir(cat), name)
  fs.writeFileSync(outPath, typeof content === 'string' ? content : Buffer.from(content))
  return { path: outPath, category: cat, filename: name }
}

export function copyToCloud(sourcePath, category) {
  const filename = path.basename(sourcePath)
  const cat = category || resolveCategory(filename)
  const name = stampedName(filename)
  const outPath = path.join(datedDir(cat), name)
  fs.copyFileSync(sourcePath, outPath)
  return { path: outPath, category: cat, filename: name }
}

export function listCloudFiles(category, limit = 10) {
  const cats = category ? [category] : ['Fotos', 'Videos', 'Documentos']
  const files = []
  for (const cat of cats) {
    const root = path.join(CLOUD_ROOT, cat)
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

// ─── Telegram core sender ─────────────────────────────────────────────────────

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

export async function notifySanti(text, filePath) {
  return sendTelegram(process.env.TELEGRAM_BOT_TOKEN, SANTI_CHAT_ID, text, filePath)
}

export async function notifyJarvis(text, filePath) {
  const env = process.env
  const token = env.TELEGRAM_BOT_TOKEN_JARVIS || env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CHAT_ID_JARVIS || SANTI_CHAT_ID
  if (!env.TELEGRAM_BOT_TOKEN_JARVIS) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN_JARVIS not set — falling back to cloud bot')
  }
  return sendTelegram(token, chatId, text, filePath)
}

// ─── Cloud Bot polling ────────────────────────────────────────────────────────

const CLOUD_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🖼 Fotos', callback_data: 'list:Fotos' },
      { text: '🎥 Videos', callback_data: 'list:Videos' },
      { text: '📄 Docs', callback_data: 'list:Documentos' },
    ],
    [{ text: '📋 Todos (últimos 10)', callback_data: 'list:all' }],
  ],
}

async function sendCloud(token, chatId, text, keyboard) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: keyboard ?? CLOUD_KEYBOARD }),
    })
  } catch {}
}

async function downloadTelegramFile(token, fileId) {
  try {
    const info = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
    const { result } = await info.json()
    if (!result?.file_path) return null
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${result.file_path}`)
    if (!r.ok) return null
    return { buffer: Buffer.from(await r.arrayBuffer()), name: path.basename(result.file_path) }
  } catch {
    return null
  }
}

async function handleCloudMessage(token, chatId, msg) {
  const fileObj = msg.document
    || msg.video
    || (msg.photo ? msg.photo[msg.photo.length - 1] : null)

  if (fileObj) {
    const filename = msg.document?.file_name
      || msg.video?.file_name
      || `foto_${Date.now()}.jpg`
    try {
      const dl = await downloadTelegramFile(token, fileObj.file_id)
      if (!dl) throw new Error('descarga fallida')
      const saved = saveToCloud(dl.buffer, filename)
      await sendCloud(token, chatId, `✅ Guardado en ${saved.category}:\n📁 ${saved.filename}`)
    } catch (e) {
      await sendCloud(token, chatId, `❌ Error al guardar: ${e.message}`)
    }
    return
  }

  const text = msg.text?.trim() ?? ''
  const lower = text.toLowerCase()

  if (lower === '/start' || lower === 'hola') {
    await sendCloud(token, chatId,
      '☁️ Cloud Jarvis activo.\n\nEnvíame archivos (fotos, videos, documentos) para guardarlos, o usa los botones para ver lo guardado.'
    )
    return
  }

  if (lower === '/list' || lower === '/archivos') {
    const files = listCloudFiles(null, 10)
    if (!files.length) {
      await sendCloud(token, chatId, '📭 No hay archivos guardados aún.')
      return
    }
    const lines = files.map((f, i) => `${i + 1}. [${f.category}] ${f.filename.slice(0, 40)}`).join('\n')
    await sendCloud(token, chatId, `📋 Últimos archivos:\n\n${lines}`)
    return
  }

  await sendCloud(token, chatId, '☁️ Envíame un archivo para guardarlo, o usa los botones.')
}

async function handleCloudCallback(token, chatId, callbackQueryId, data) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    })
  } catch {}

  if (data.startsWith('list:')) {
    const cat = data.slice(5)
    const files = listCloudFiles(cat === 'all' ? null : cat, 10)
    if (!files.length) {
      await sendCloud(token, chatId, `📭 No hay ${cat === 'all' ? 'archivos' : cat.toLowerCase()} guardados aún.`)
      return
    }
    const lines = files.map((f, i) => `${i + 1}. ${f.filename.slice(0, 50)}`).join('\n')
    await sendCloud(token, chatId, `📋 ${cat === 'all' ? 'Últimos archivos' : cat}:\n\n${lines}`)
    return
  }

  await sendCloud(token, chatId, '☁️ Envíame un archivo para guardarlo.')
}

async function clearCloudWebhook(token) {
  try {
    const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
    const { result } = await info.json()
    if (result?.url) {
      console.warn('[cloudBot] active webhook detected — deleting')
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' })
    }
  } catch (e) {
    console.warn('[cloudBot] could not clear webhook:', e?.message)
  }
}

function cloudSleep(ms) { return new Promise(r => setTimeout(r, ms)) }

let cloudRunning = false
let cloudOffset = 0

async function pollCloud(token) {
  const api = `https://api.telegram.org/bot${token}`
  while (cloudRunning) {
    try {
      const r = await fetch(`${api}/getUpdates?offset=${cloudOffset}&timeout=30`)
      if (!r.ok) { await cloudSleep(5000); continue }
      const data = await r.json()
      if (!data.ok) { await cloudSleep(5000); continue }
      if (!data.result.length) { await cloudSleep(200); continue }

      for (const update of data.result) {
        cloudOffset = update.update_id + 1

        if (update.callback_query) {
          const cb = update.callback_query
          handleCloudCallback(token, cb.message.chat.id, cb.id, cb.data).catch(() => {})
          continue
        }

        const msg = update.message
        if (!msg) continue
        handleCloudMessage(token, msg.chat.id, msg).catch(() => {})
      }
    } catch (e) {
      console.error('[cloudBot] poll error:', e?.message)
      await cloudSleep(5000)
    }
  }
  console.log('[cloudBot] polling stopped')
}

export function startCloudPolling() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[cloudBot] TELEGRAM_BOT_TOKEN not set — polling disabled')
    return
  }
  if (cloudRunning) return
  cloudRunning = true
  cloudOffset = 0
  fs.mkdirSync(CLOUD_ROOT, { recursive: true })
  clearCloudWebhook(token).then(() => {
    pollCloud(token).catch(e => console.error('[cloudBot] fatal poll error:', e?.message))
    console.log(`[cloudBot] polling started — root: ${CLOUD_ROOT}`)
  })
}

export function stopCloudPolling() {
  cloudRunning = false
}
