import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import { notifyJarvis } from './cloudStorage.js'
import { listReminders, cancelReminder } from './reminders.js'

const PORT = process.env.PORT ?? '8788'
const FALLBACK_CHAT_ID = '2017358997'

// Inline keyboard shown on every Jarvis bot response
const JARVIS_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📱 QR Móvil', callback_data: 'qr' },
      { text: '⏰ Recordatorios', callback_data: 'reminders' },
    ],
    [
      { text: '🔇 Silenciar Jarvis', callback_data: 'silence' },
      { text: '🔊 Activar Jarvis', callback_data: 'unsilence' },
    ],
  ],
}

const QR_EXACT = new Set(['/qr', '/movil', '/móvil'])
const QR_KEYWORD = /\bqr\b|\bmóvil\b|\bmovil\b/i

export function isQrRequest(text) {
  if (!text) return false
  if (QR_EXACT.has(text.trim().toLowerCase())) return true
  return QR_KEYWORD.test(text)
}

export async function sendQrToTelegram() {
  let qrUrl, expiresAt
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/mobile/token`)
    if (!r.ok) throw new Error(`backend ${r.status}`)
    const data = await r.json()
    qrUrl = data.qrUrl
    expiresAt = data.expiresAt
  } catch (e) {
    await notifyJarvis(`⚠️ Jarvis no está activo.\nAbre la app Jarvis en tu PC primero.\n_(${e?.message ?? 'sin respuesta'})_`)
    return null
  }

  const tmpPath = path.join(os.tmpdir(), 'jarvis-mobile-qr-tg.png')
  try {
    const buf = await QRCode.toBuffer(qrUrl, { type: 'png', width: 400, margin: 2 })
    fs.writeFileSync(tmpPath, buf)
    const expiresStr = new Date(expiresAt).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })
    await notifyJarvis(`📱 QR de conexión mobile.\n🔗 ${qrUrl}\n⏱ Expira: ${expiresStr}`, tmpPath)
    console.log('[telegramBot] QR enviado a Telegram:', qrUrl)
    return qrUrl
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

/**
 * Send a text message (or photo/document with caption) to chatId,
 * always attaching the Jarvis inline keyboard.
 */
export async function sendWithKeyboard(token, chatId, text, filePath) {
  const api = `https://api.telegram.org/bot${token}`
  const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
  const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'])

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
      form.set('reply_markup', JSON.stringify(JARVIS_KEYBOARD))
      form.set(field, new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
      const r = await fetch(`${api}/${method}`, { method: 'POST', body: form })
      return r.ok
    }
    const r = await fetch(`${api}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: JARVIS_KEYBOARD }),
    })
    return r.ok
  } catch {
    return false
  }
}

async function answerCallback(token, callbackQueryId, text = '') {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    })
  } catch {}
}

function formatReminderType(r) {
  const type = r.type || 'once_at'
  if (type === 'once_at' || type === 'once_after') return 'una vez'
  if (type === 'recurring_every') {
    const ms = r.schedule?.intervalMs ?? 0
    if (ms < 3600000) return `cada ${Math.round(ms / 60000)} min`
    if (ms < 86400000) return `cada ${Math.round(ms / 3600000)}h`
    return `cada ${Math.round(ms / 86400000)} días`
  }
  if (type === 'recurring_at') {
    const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
    const days = (r.schedule?.days ?? []).map((d) => DOW[d]).join('/')
    const h = String(r.schedule?.hour ?? 0).padStart(2, '0')
    const m = String(r.schedule?.minute ?? 0).padStart(2, '0')
    return `${days} ${h}:${m}`
  }
  return ''
}

async function handleRemindersCommand(token, chatId) {
  const all = listReminders()
  const upcoming = all.slice(0, 5)
  if (!upcoming.length) {
    await sendWithKeyboard(token, chatId, '📭 No tienes recordatorios pendientes.')
    return
  }

  // Build message with per-item cancel buttons
  const lines = upcoming.map((r, i) => {
    const when = new Date(r.fireAt).toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      dateStyle: 'short',
      timeStyle: 'short',
    })
    const typeLabel = formatReminderType(r)
    return `${i + 1}. 💬 ${r.text}\n   📅 ${when} (${typeLabel})`
  }).join('\n\n')

  const cancelButtons = upcoming.map((r) => [
    { text: `❌ Cancelar: ${r.text.slice(0, 20)}`, callback_data: `cancel:${r.id}` },
  ])

  const keyboard = {
    inline_keyboard: [
      ...cancelButtons,
      [
        { text: '📱 QR Móvil', callback_data: 'qr' },
        { text: '🔙 Menú', callback_data: 'menu' },
      ],
    ],
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `⏰ Tus próximos recordatorios:\n\n${lines}`,
        reply_markup: keyboard,
      }),
    })
  } catch {}
}

async function handleMessage(token, chatId, text) {
  const lower = text.trim().toLowerCase()

  if (lower === '/start' || lower === 'hola' || lower === 'start') {
    await sendWithKeyboard(token, chatId,
      '👋 Hola, señor. Soy Jarvis.\n\nUsa los botones o escribe:\n• /qr — código QR móvil\n• /recordatorios — ver pendientes'
    )
    return
  }

  if (lower === '/qr' || isQrRequest(text)) {
    await sendQrToTelegram()
    return
  }

  if (lower === '/recordatorios' || lower === 'recordatorios') {
    await handleRemindersCommand(token, chatId)
    return
  }

  // Unknown message — show menu
  await sendWithKeyboard(token, chatId, '¿En qué puedo ayudarte? Usa los botones.')
}

async function handleCallback(token, chatId, callbackQueryId, data) {
  await answerCallback(token, callbackQueryId)

  if (data === 'qr') {
    await sendQrToTelegram()
    return
  }

  if (data === 'reminders' || data === 'menu') {
    await handleRemindersCommand(token, chatId)
    return
  }

  if (data.startsWith('cancel:')) {
    const id = data.slice(7)
    const removed = cancelReminder(id)
    await sendWithKeyboard(token, chatId,
      removed ? '✅ Recordatorio cancelado.' : '⚠️ No se encontró ese recordatorio.'
    )
    return
  }

  if (data === 'silence' || data === 'unsilence') {
    // Attempt to toggle voice via backend HTTP; degrade gracefully if unavailable
    try {
      const port = process.env.PORT ?? '8788'
      const action = data === 'silence' ? 'mute' : 'unmute'
      await fetch(`http://127.0.0.1:${port}/api/jarvis/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      await sendWithKeyboard(token, chatId,
        data === 'silence' ? '🔇 Jarvis silenciado.' : '🔊 Jarvis activado.'
      )
    } catch {
      await sendWithKeyboard(token, chatId, 'ℹ️ Función no disponible aún.')
    }
    return
  }

  await sendWithKeyboard(token, chatId, '¿En qué puedo ayudarte? Usa los botones.')
}

let running = false
let offset = 0

export function startPolling() {
  // Require a DEDICATED Jarvis-bot token — never share the cloud-bot token.
  // Sharing causes two getUpdates loops to compete and eat each other's updates.
  const token = process.env.TELEGRAM_BOT_TOKEN_JARVIS
  if (!token) {
    console.warn('[telegramBot] TELEGRAM_BOT_TOKEN_JARVIS not set — Jarvis bot polling disabled')
    return
  }
  if (running) return
  running = true
  offset = 0
  const chatId = String(process.env.TELEGRAM_CHAT_ID_JARVIS || FALLBACK_CHAT_ID)
  if (!process.env.TELEGRAM_CHAT_ID_JARVIS) {
    console.warn(`[telegramBot] TELEGRAM_CHAT_ID_JARVIS not set — using fallback ${FALLBACK_CHAT_ID}`)
  }
  // Clear any active webhook — if set, getUpdates returns empty forever
  clearWebhook(token, '[telegramBot]').then(() => {
    poll(token, chatId).catch((e) =>
      console.error('[telegramBot] fatal poll error:', e?.message)
    )
    console.log(`[telegramBot] polling started (chat_id filter: ${chatId})`)
  })
}

export function stopPolling() {
  running = false
}

async function poll(token, chatId) {
  const api = `https://api.telegram.org/bot${token}`
  while (running) {
    try {
      const r = await fetch(
        `${api}/getUpdates?offset=${offset}&timeout=30`
      )
      if (!r.ok) {
        console.warn('[telegramBot] getUpdates HTTP error:', r.status)
        await sleep(5000)
        continue
      }
      const data = await r.json()
      if (!data.ok) {
        await sleep(5000)
        continue
      }
      if (data.result.length === 0) {
        await sleep(200)
      }
      for (const update of data.result) {
        offset = update.update_id + 1

        // Handle inline keyboard button presses
        if (update.callback_query) {
          const cb = update.callback_query
          const incomingId = String(cb.message?.chat?.id)
          if (incomingId !== chatId) {
            console.warn(`[telegramBot] callback from unknown chat ${incomingId} (expected ${chatId}) — ignored`)
            continue
          }
          handleCallback(token, chatId, cb.id, cb.data).catch((e) =>
            console.error('[telegramBot] callback error:', e?.message)
          )
          continue
        }

        const msg = update.message
        if (!msg?.text) continue
        const incomingId = String(msg.chat.id)
        if (incomingId !== chatId) {
          console.warn(`[telegramBot] message from unknown chat ${incomingId} (expected ${chatId}) — ignored. Set TELEGRAM_CHAT_ID_JARVIS=${incomingId} in secrets.local.json`)
          continue
        }

        handleMessage(token, chatId, msg.text).catch((e) =>
          console.error('[telegramBot] message error:', e?.message)
        )
      }
    } catch (e) {
      console.error('[telegramBot] poll error:', e?.message)
      await sleep(5000)
    }
  }
  console.log('[telegramBot] polling stopped')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function clearWebhook(token, prefix) {
  try {
    const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
    const { result } = await info.json()
    if (result?.url) {
      console.warn(`${prefix} active webhook detected (${result.url}) — deleting it so getUpdates works`)
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' })
      console.log(`${prefix} webhook deleted`)
    }
  } catch (e) {
    console.warn(`${prefix} could not check/clear webhook:`, e?.message)
  }
}
