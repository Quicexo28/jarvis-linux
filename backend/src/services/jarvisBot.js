/**
 * Jarvis Telegram Bot — standalone service.
 * Runs independently from Jarvis (registered as a systemd user service).
 * Handles: /qr, /recordatorios, inline keyboard, cancel callbacks, silence/unsilence.
 */

import { loadLocalSecrets } from '../lib/secrets.js'
loadLocalSecrets()

import { startPolling, stopPolling } from '../lib/telegramBot.js'

const BOT_NAME = 'JarvisBot'
const RESTART_DELAY_MS = 10_000

// ─── Telegram alert (outbound only, no polling loop) ─────────────────────────

async function sendAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN_JARVIS
  const chatId = process.env.TELEGRAM_CHAT_ID_JARVIS || '2017358997'
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch {}
}

// ─── Error handling ───────────────────────────────────────────────────────────

process.on('uncaughtException', async (err) => {
  const msg = `❌ [${BOT_NAME}] Error fatal:\n${err?.message}\n${err?.stack?.slice(0, 400) ?? ''}`
  console.error(msg)
  await sendAlert(msg).catch(() => {})
  process.exit(1)
})

process.on('unhandledRejection', async (reason) => {
  const msg = `⚠️ [${BOT_NAME}] Promesa rechazada:\n${reason?.message ?? String(reason)}`
  console.error(msg)
  await sendAlert(msg).catch(() => {})
})

// ─── Heartbeat ────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
setInterval(() => {
  sendAlert(`💓 [${BOT_NAME}] Activo — ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`).catch(() => {})
}, HEARTBEAT_INTERVAL_MS)

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN_JARVIS
  if (!token) {
    console.error(`[${BOT_NAME}] TELEGRAM_BOT_TOKEN_JARVIS not set — exiting`)
    process.exit(0) // exit 0 so systemd doesn't retry pointlessly
  }

  console.log(`[${BOT_NAME}] starting...`)
  await sendAlert(`✅ [${BOT_NAME}] Iniciado — ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`)
  startPolling()
  console.log(`[${BOT_NAME}] polling active`)
}

process.on('SIGTERM', async () => {
  console.log(`[${BOT_NAME}] SIGTERM — stopping`)
  stopPolling()
  await sendAlert(`🛑 [${BOT_NAME}] Detenido (SIGTERM)`)
  process.exit(0)
})

main().catch(async (err) => {
  const msg = `❌ [${BOT_NAME}] Fallo al iniciar:\n${err?.message}`
  console.error(msg)
  await sendAlert(msg).catch(() => {})
  process.exit(1)
})
