import fs from 'fs'
import os from 'os'
import path from 'path'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dir, '..', '..', 'data')

// CLOUD_ROOT is now the parent directory — subdirs per user: Juliana/, Gustavo/, Santiago/
// Old env var SYNCTHING_CLOUD_ROOT used to point to .../Santi directly.
// New convention: CLOUD_ROOT points to the parent, SYNCTHING_CLOUD_ROOT is an alias.
const CLOUD_ROOT =
  process.env.CLOUD_ROOT ||
  process.env.SYNCTHING_CLOUD_ROOT ||
  path.join(os.homedir(), 'SyncthingCloud', 'Uploads', 'TelegramCloud')

// Known users — also the login options shown on first contact
export const KNOWN_USERS = ['Juliana', 'Gustavo', 'Santiago']

// For backward compat: legacy code that called notifySanti targets Santiago's chat
const SANTI_CHAT_ID = 2017358997

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'])

// ─── User registry ───────────────────────────────────────────────────────────

const USERS_FILE = path.join(DATA_DIR, 'telegram-users.json')

export function loadUserRegistry() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {}
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveUserRegistry(registry) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(USERS_FILE, JSON.stringify(registry, null, 2), 'utf-8')
}

/** Returns the username associated with this chatId, or null. */
export function getUserForChat(chatId) {
  const reg = loadUserRegistry()
  return reg[String(chatId)] ?? null
}

/** Link chatId to a username, persisted in JSON. */
export function registerUser(chatId, name) {
  const reg = loadUserRegistry()
  reg[String(chatId)] = name
  saveUserRegistry(reg)
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function resolveCategory(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (PHOTO_EXT.has(ext)) return 'Fotos'
  if (VIDEO_EXT.has(ext)) return 'Videos'
  return 'Documentos'
}

function datedDir(category, userName = 'Santiago') {
  const d = new Date()
  const dir = path.join(
    CLOUD_ROOT,
    userName,
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
 * Write string/Buffer content to a user's cloud folder.
 * Returns { path, category, filename }.
 */
export function saveToCloud(content, filename, category, userName = 'Santiago') {
  const cat = category || resolveCategory(filename)
  const name = stampedName(filename)
  const outPath = path.join(datedDir(cat, userName), name)
  fs.writeFileSync(outPath, typeof content === 'string' ? content : Buffer.from(content))
  return { path: outPath, category: cat, filename: name }
}

/**
 * Copy an existing local file into a user's cloud folder.
 * Returns { path, category, filename }.
 */
export function copyToCloud(sourcePath, category, userName = 'Santiago') {
  const filename = path.basename(sourcePath)
  const cat = category || resolveCategory(filename)
  const name = stampedName(filename)
  const outPath = path.join(datedDir(cat, userName), name)
  fs.copyFileSync(sourcePath, outPath)
  return { path: outPath, category: cat, filename: name }
}

/**
 * List recent files from a user's cloud folder.
 */
export function listCloudFiles(category, limit = 10, userName = 'Santiago') {
  const cats = category ? [category] : ['Fotos', 'Videos', 'Documentos']
  const files = []
  for (const cat of cats) {
    const root = path.join(CLOUD_ROOT, userName, cat)
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

// ─── Telegram send helpers ────────────────────────────────────────────────────

const CLOUD_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📁 Mis archivos', callback_data: 'list' },
      { text: '📥 Pedir último', callback_data: 'last' },
    ],
  ],
}

const LOGIN_KEYBOARD = {
  inline_keyboard: [
    KNOWN_USERS.map((name) => ({
      text: `👤 ${name}`,
      callback_data: `login:${name}`,
    })),
  ],
}

async function sendTelegramText(token, chatId, text, keyboard) {
  if (!token) return false
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }),
    })
    return r.ok
  } catch {
    return false
  }
}

async function sendTelegramFile(token, chatId, filePath, caption, keyboard) {
  if (!token || !fs.existsSync(filePath)) return false
  const ext = path.extname(filePath).toLowerCase()
  const isPhoto = PHOTO_EXT.has(ext)
  const isVideo = VIDEO_EXT.has(ext)
  const field  = isPhoto ? 'photo' : isVideo ? 'video' : 'document'
  const method = isPhoto ? 'sendPhoto' : isVideo ? 'sendVideo' : 'sendDocument'
  try {
    const form = new FormData()
    form.set('chat_id', String(chatId))
    if (caption) form.set('caption', caption)
    if (keyboard) form.set('reply_markup', JSON.stringify(keyboard))
    form.set(field, new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
    })
    return r.ok
  } catch {
    return false
  }
}

// Core sender used by legacy outbound API — picks message vs media.
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

/** Notify Santi via the Cloud bot. Used by cloud_save (backward compat). */
export async function notifySanti(text, filePath) {
  return sendTelegram(process['env']['TELEGRAM_BOT_TOKEN'], SANTI_CHAT_ID, text, filePath)
}

/** Send via the Jarvis bot for reminders/notifications. */
export async function notifyJarvis(text, filePath) {
  const env = process['env']
  const token = env['TELEGRAM_BOT_TOKEN_JARVIS'] || env['TELEGRAM_BOT_TOKEN']
  const chatId = env['TELEGRAM_CHAT_ID_JARVIS'] || SANTI_CHAT_ID
  if (!env['TELEGRAM_BOT_TOKEN_JARVIS']) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN_JARVIS not set — falling back to cloud bot')
  }
  return sendTelegram(token, chatId, text, filePath)
}

// ─── Cloud Bot inbound polling ────────────────────────────────────────────────

async function answerCallback(token, callbackQueryId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    })
  } catch {}
}

async function downloadTelegramFile(token, fileId) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
    )
    if (!r.ok) return null
    const { result } = await r.json()
    if (!result?.file_path) return null
    const fileR = await fetch(
      `https://api.telegram.org/file/bot${token}/${result.file_path}`
    )
    if (!fileR.ok) return null
    const buf = Buffer.from(await fileR.arrayBuffer())
    return { buf, filename: path.basename(result.file_path) }
  } catch {
    return null
  }
}

async function handleCloudMessage(token, chatId, msg) {
  const userName = getUserForChat(chatId)
  console.log(`[cloudBot] message from chat ${chatId} (user: ${userName ?? 'unknown'})`)

  // Unknown user — show login
  if (!userName) {
    console.log(`[cloudBot] unknown chat ${chatId} — sending login keyboard`)
    await sendTelegramText(token, chatId, '¿Quién eres?', LOGIN_KEYBOARD)
    return
  }

  // Receive a file (photo / document / video)
  const fileId =
    (msg.photo && msg.photo[msg.photo.length - 1]?.file_id) ||
    msg.document?.file_id ||
    msg.video?.file_id

  if (fileId) {
    const downloaded = await downloadTelegramFile(token, fileId)
    if (downloaded) {
      try {
        saveToCloud(downloaded.buf, downloaded.filename, null, userName)
        await sendTelegramText(token, chatId, '✅ Guardado.', CLOUD_KEYBOARD)
      } catch (e) {
        await sendTelegramText(token, chatId, `⚠️ Error al guardar: ${e?.message}`, CLOUD_KEYBOARD)
      }
    } else {
      await sendTelegramText(token, chatId, '⚠️ No pude descargar el archivo.', CLOUD_KEYBOARD)
    }
    return
  }

  // Text — show menu
  await sendTelegramText(token, chatId, `Hola, ${userName}. ¿Qué necesitas?`, CLOUD_KEYBOARD)
}

async function handleCloudCallback(token, chatId, callbackQueryId, data, userName) {
  await answerCallback(token, callbackQueryId)

  if (data.startsWith('login:')) {
    const name = data.slice(6)
    if (KNOWN_USERS.includes(name)) {
      registerUser(chatId, name)
      const greeting = name === 'Gustavo' ? `Bienvenido, ${name} 👋` : `Bienvenida, ${name} 👋`
      await sendTelegramText(token, chatId, greeting, CLOUD_KEYBOARD)
    } else {
      await sendTelegramText(token, chatId, '⚠️ Usuario no reconocido.', LOGIN_KEYBOARD)
    }
    return
  }

  // Commands below require a logged-in user
  if (!userName) {
    await sendTelegramText(token, chatId, '¿Quién eres?', LOGIN_KEYBOARD)
    return
  }

  if (data === 'list') {
    const files = listCloudFiles(null, 5, userName)
    if (!files.length) {
      await sendTelegramText(token, chatId, '📭 No tienes archivos guardados.', CLOUD_KEYBOARD)
      return
    }
    const listKeyboard = {
      inline_keyboard: [
        ...files.map((f) => [{ text: `📥 ${f.filename.slice(0, 40)}`, callback_data: `get:${f.filename}` }]),
        [{ text: '🔙 Menú', callback_data: 'menu' }],
      ],
    }
    const listText = files.map((f, i) => `${i + 1}. ${f.filename.slice(0, 50)}`).join('\n')
    await sendTelegramText(token, chatId, `📁 Tus últimos archivos:\n\n${listText}`, listKeyboard)
    return
  }

  if (data === 'last') {
    const files = listCloudFiles(null, 1, userName)
    if (!files.length) {
      await sendTelegramText(token, chatId, '📭 No tienes archivos guardados.', CLOUD_KEYBOARD)
      return
    }
    await sendTelegramFile(token, chatId, files[0].path, files[0].filename, CLOUD_KEYBOARD)
    return
  }

  if (data === 'menu') {
    await sendTelegramText(token, chatId, `Hola, ${userName}. ¿Qué necesitas?`, CLOUD_KEYBOARD)
    return
  }

  if (data.startsWith('get:')) {
    const filename = data.slice(4)
    const files = listCloudFiles(null, 100, userName)
    const found = files.find((f) => f.filename === filename)
    if (found) {
      await sendTelegramFile(token, chatId, found.path, found.filename, CLOUD_KEYBOARD)
    } else {
      await sendTelegramText(token, chatId, '⚠️ Archivo no encontrado.', CLOUD_KEYBOARD)
    }
    return
  }

  await sendTelegramText(token, chatId, '¿Qué necesitas?', CLOUD_KEYBOARD)
}

let cloudRunning = false
let cloudOffset = 0

export function startCloudPolling() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    console.warn('[cloudBot] TELEGRAM_BOT_TOKEN not set — cloud polling disabled')
    return
  }
  if (cloudRunning) return
  cloudRunning = true
  cloudOffset = 0
  // Clear any active webhook — if set, getUpdates returns empty forever
  clearCloudWebhook(token).then(() => {
    cloudPoll(token).catch((e) =>
      console.error('[cloudBot] fatal poll error:', e?.message)
    )
    console.log('[cloudBot] polling started')
  })
}

export function stopCloudPolling() {
  cloudRunning = false
}

async function cloudPoll(token) {
  const api = `https://api.telegram.org/bot${token}`
  while (cloudRunning) {
    try {
      const r = await fetch(`${api}/getUpdates?offset=${cloudOffset}&timeout=30`)
      if (!r.ok) {
        console.warn('[cloudBot] getUpdates HTTP error:', r.status)
        await sleep(5000)
        continue
      }
      const data = await r.json()
      if (!data.ok) { await sleep(5000); continue }
      if (data.result.length === 0) { await sleep(200); continue }

      for (const update of data.result) {
        cloudOffset = update.update_id + 1

        if (update.callback_query) {
          const cb = update.callback_query
          const chatId = String(cb.message?.chat?.id)
          const userName = getUserForChat(chatId)
          handleCloudCallback(token, chatId, cb.id, cb.data, userName).catch((e) =>
            console.error('[cloudBot] callback error:', e?.message)
          )
          continue
        }

        const msg = update.message
        if (!msg) continue
        const chatId = String(msg.chat.id)
        handleCloudMessage(token, chatId, msg).catch((e) =>
          console.error('[cloudBot] message error:', e?.message)
        )
      }
    } catch (e) {
      console.error('[cloudBot] poll error:', e?.message)
      await sleep(5000)
    }
  }
  console.log('[cloudBot] polling stopped')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function clearCloudWebhook(token) {
  try {
    const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
    const { result } = await info.json()
    if (result?.url) {
      console.warn(`[cloudBot] active webhook detected (${result.url}) — deleting so getUpdates works`)
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' })
      console.log('[cloudBot] webhook deleted')
    }
  } catch (e) {
    console.warn('[cloudBot] could not check/clear webhook:', e?.message)
  }
}
