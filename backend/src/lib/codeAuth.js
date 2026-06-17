/**
 * Code-change permission gate.
 *
 * Before Jarvis runs any self-coding action (run_command / checkpoint /
 * rollback / restart) it must be authorized with the owner's password. The
 * password is never stored in plaintext: only a scrypt hash lives in
 * secrets.local.json under JARVIS_CODE_PASSWORD_HASH (set via
 * scripts/set-code-password.js).
 *
 * On the first gated action the backend asks the renderer to show a password
 * modal (skill-bus verb `request_passphrase`), verifies the answer, and then
 * keeps a short in-memory unlock window so a multi-step edit doesn't prompt on
 * every command. Fails CLOSED: no hash, no renderer, or wrong password => denied.
 */

import { scryptSync, timingSafeEqual } from 'crypto'
import { json } from './http.js'
import { requestClient as skillBusRequest, hasClient as skillBusHasClient } from './skillBus.js'

const UNLOCK_WINDOW_MS = 5 * 60 * 1000  // 5 min
const SCRYPT_KEYLEN = 64

let unlockedUntil = 0

/** Format used by scripts/set-code-password.js: "scrypt$<saltHex>$<hashHex>". */
export function hashPassword(plain, saltHex) {
  const salt = Buffer.from(saltHex, 'hex')
  const derived = scryptSync(String(plain), salt, SCRYPT_KEYLEN)
  return `scrypt$${saltHex}$${derived.toString('hex')}`
}

function verifyPassword(plain) {
  const stored = process.env.JARVIS_CODE_PASSWORD_HASH
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, saltHex, hashHex] = parts
  let expected, actual
  try {
    expected = Buffer.from(hashHex, 'hex')
    actual = scryptSync(String(plain), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
  } catch {
    return false
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function isUnlocked() {
  return Date.now() < unlockedUntil
}

/** Manually clear the unlock window (e.g. on lock command). */
export function lock() {
  unlockedUntil = 0
}

/**
 * Ensure the current action is authorized. Returns true if it BLOCKED the
 * request (and already wrote an HTTP response) — callers must `return` then.
 * Returns false when authorized; the caller proceeds.
 */
export async function requireCodeAuth(res, reason = 'Autorice un cambio en el código de Jarvis.') {
  if (isUnlocked()) return false

  if (!process.env.JARVIS_CODE_PASSWORD_HASH) {
    json(res, 403, {
      ok: false, error: 'no_password_set',
      spoken: 'No hay contraseña configurada para cambios de código, señor. Debe fijarla primero.',
    })
    return true
  }

  if (!skillBusHasClient()) {
    json(res, 403, {
      ok: false, error: 'renderer_not_connected',
      spoken: 'No puedo pedir la contraseña: la interfaz no está activa, señor.',
    })
    return true
  }

  let answer
  try {
    const result = await skillBusRequest('request_passphrase', { reason }, 120000)
    answer = result && result.passphrase
  } catch {
    json(res, 401, { ok: false, error: 'passphrase_cancelled', spoken: 'Autorización cancelada, señor.' })
    return true
  }

  if (!verifyPassword(answer)) {
    json(res, 401, { ok: false, error: 'wrong_password', spoken: 'Contraseña incorrecta, señor. Acción denegada.' })
    return true
  }

  unlockedUntil = Date.now() + UNLOCK_WINDOW_MS
  return false
}
