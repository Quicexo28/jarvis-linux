/**
 * Standalone Telegram notification process.
 *
 * Intentionally self-contained — imports NOTHING from backend/src/lib/.
 * Reads secrets + reminders.json directly, fires Telegram notifications,
 * and survives independent of backend restarts.
 *
 * Run as a systemd user service alongside the backend.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', '..', 'data')
const STORE = join(DATA_DIR, 'reminders.json')
const SECRETS_FILE = join(DATA_DIR, 'secrets.local.json')

// Bogotá offset for recurring_at weekday calculations
const BOGOTA_OFFSET_H = -5

// Inline keyboard sent with every notification — mirrors the Jarvis bot menu
const JARVIS_KEYBOARD = JSON.stringify({
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
})

function loadSecrets() {
  try {
    if (!existsSync(SECRETS_FILE)) return {}
    return JSON.parse(readFileSync(SECRETS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function loadReminders() {
  try {
    if (!existsSync(STORE)) return []
    return JSON.parse(readFileSync(STORE, 'utf-8'))
  } catch {
    return []
  }
}

function saveReminders(list) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(STORE, JSON.stringify(list, null, 2), 'utf-8')
}

function nextFire(entry, now) {
  const type = entry.type || 'once_at'

  if (type === 'once_at' || type === 'once_after') return null

  if (type === 'recurring_every') {
    const { intervalMs } = entry.schedule
    let t = new Date(entry.fireAt).getTime()
    do { t += intervalMs } while (t <= now)
    return new Date(t).toISOString()
  }

  if (type === 'recurring_at') {
    const { days, hour, minute } = entry.schedule
    const utcHour = hour - BOGOTA_OFFSET_H
    const base = new Date(now)
    const todayFire = new Date(Date.UTC(
      base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
      utcHour, minute, 0, 0
    ))
    for (let delta = 0; delta < 8; delta++) {
      const candidate = new Date(todayFire.getTime() + delta * 86400000)
      if (candidate.getTime() <= now) continue
      const bogotaMs = candidate.getTime() + BOGOTA_OFFSET_H * 3600000
      const dow = new Date(bogotaMs).getUTCDay()
      if (days.includes(dow)) return candidate.toISOString()
    }
    return null
  }

  const REPEAT_MS = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3 }
  if (entry.repeat && REPEAT_MS[entry.repeat]) {
    const step = REPEAT_MS[entry.repeat]
    let t = new Date(entry.fireAt).getTime()
    do { t += step } while (t <= now)
    return new Date(t).toISOString()
  }

  return null
}

async function sendTelegram(token, chatId, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: JARVIS_KEYBOARD,
      }),
    })
    return r.ok
  } catch {
    return false
  }
}

async function tick(token, chatId) {
  const now = Date.now()
  const list = loadReminders()
  const due = list.filter((r) => new Date(r.fireAt).getTime() <= now)
  if (!due.length) return

  const kept = []
  for (const r of list) {
    if (new Date(r.fireAt).getTime() > now) { kept.push(r); continue }
    const next = nextFire(r, now)
    if (next) kept.push({ ...r, fireAt: next })
  }
  saveReminders(kept)

  for (const r of due) {
    const ok = await sendTelegram(token, chatId, `⏰ Recordatorio: ${r.text}`)
    console.log(`[notifier] fired "${r.text}" — telegram: ${ok ? 'ok' : 'fail'}`)
  }
}

function start() {
  const secrets = loadSecrets()
  for (const [k, v] of Object.entries(secrets)) {
    if (!process.env[k]) process.env[k] = v
  }

  const token = process.env.TELEGRAM_BOT_TOKEN_JARVIS || process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID_JARVIS || '2017358997'

  if (!token) {
    console.warn('[notifier] No Telegram token configured — notifications disabled')
    setInterval(() => {}, 60000)
    return
  }

  console.log('[notifier] scheduler started, checking every 30s')
  tick(token, chatId).catch((e) => console.error('[notifier] tick error:', e?.message))
  setInterval(() => {
    tick(token, chatId).catch((e) => console.error('[notifier] tick error:', e?.message))
  }, 30000)
}

start()
