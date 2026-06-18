/**
 * Security / portable-unlock endpoints.
 *
 * On a new machine the owner vault (data/jarvis-portable.enc) is locked until
 * the owner enters the password once. Unlocking decrypts the vault (voiceprint
 * + secrets) and writes per-machine keyring caches so subsequent boots are
 * hands-free. The password-derived key is never stored.
 *
 * Linux adaptation: uses linuxKeyring.js (AES-256-GCM + libsecret) instead of
 * Windows DPAPI.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { json, readBody } from '../lib/http.js'
import { open as openVault } from '../lib/portableVault.js'
import { dpapiEncrypt, dpapiEncryptRaw } from '../lib/linuxKeyring.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', '..', 'data')
const SECRETS_ENC = join(DATA_DIR, 'secrets.local.enc')
const PORTABLE = join(DATA_DIR, 'jarvis-portable.enc')
const VOICEPRINT_ENC = join(__dir, '..', '..', 'voice', 'python', 'owner_voiceprint.enc')

const STT_URL = process.env.STT_URL || 'http://127.0.0.1:8790'

function portablePath() {
  if (existsSync(PORTABLE)) return PORTABLE
  return null
}

function isUnlocked() {
  return existsSync(SECRETS_ENC) && !!process.env.JARVIS_CODE_PASSWORD_HASH
}

export function handleSecurityStatus(_req, res) {
  const blob = portablePath()
  return json(res, 200, {
    ok: true,
    hasPortable: !!blob,
    unlocked: isUnlocked(),
    needsUnlock: !!blob && !isUnlocked(),
  })
}

export async function handleSecurityUnlock(req, res) {
  let body
  try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'bad_request' }) }
  const password = body && body.password
  if (!password) return json(res, 400, { ok: false, error: 'missing_password' })

  const blob = portablePath()
  if (!blob) return json(res, 404, { ok: false, error: 'no_vault', spoken: 'No hay bóveda portable para desbloquear, señor.' })

  let data
  try {
    data = openVault(password, readFileSync(blob, 'utf-8'))
  } catch (e) {
    const wrong = e.message === 'wrong_password'
    return json(res, wrong ? 401 : 500, {
      ok: false, error: e.message,
      spoken: wrong ? 'Contraseña incorrecta, señor.' : 'No pude abrir la bóveda, señor.',
    })
  }

  try {
    const secrets = data.secrets || {}
    writeFileSync(SECRETS_ENC, dpapiEncrypt(JSON.stringify(secrets, null, 2)), 'utf-8')
    if (data.voiceprint) {
      writeFileSync(VOICEPRINT_ENC, dpapiEncryptRaw(JSON.stringify(data.voiceprint)))
    }
    for (const [k, v] of Object.entries(secrets)) {
      if (k.startsWith('_') || typeof v !== 'string' || !v) continue
      if (!process.env[k]) process.env[k] = v
    }
    try {
      await fetch(`${STT_URL}/speaker-id/reload`, { method: 'POST' })
    } catch { /* STT may be down; voiceprint loads on its next start */ }

    return json(res, 200, { ok: true, spoken: 'Identidad verificada. Bienvenido, señor.' })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'unlock_apply_failed', detail: e.message })
  }
}
