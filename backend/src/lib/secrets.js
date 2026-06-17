/**
 * Load local secrets (code-change password hash, Telegram bot tokens, etc.) into
 * process.env at boot.
 *
 * Secrets are stored encrypted at rest (secrets.local.enc) — readable only on
 * this machine (Windows DPAPI / Linux machine-key AES-GCM, see platformCrypto),
 * never plaintext on disk, never in git or the installer. A legacy plaintext
 * secrets.local.json is auto-migrated (encrypt then delete) the first time it is
 * seen. Decryption happens in memory only.
 *
 * Existing env vars win — env beats file, so OS-level config stays authoritative
 * when both are present.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { dpapiEncrypt, dpapiDecrypt } from './platformCrypto.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', '..', 'data')
const PLAIN = join(DATA_DIR, 'secrets.local.json')
const ENC = join(DATA_DIR, 'secrets.local.enc')

function applyToEnv(obj) {
  const env = process['env']
  const applied = []
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue
    if (typeof v !== 'string' || !v) continue
    if (env[k]) continue // existing env wins
    env[k] = v
    applied.push(k)
  }
  if (applied.length) console.log('[secrets] loaded:', applied.join(', '))
  return applied
}

// Encrypt a plaintext secrets file to its .enc sibling, then delete the plaintext.
function migratePlaintext(plainPath, encPath) {
  const raw = readFileSync(plainPath, 'utf-8')
  JSON.parse(raw) // validate before destroying the plaintext
  writeFileSync(encPath, dpapiEncrypt(raw), 'utf-8')
  try { unlinkSync(plainPath) } catch {}
  console.log('[secrets] migrated plaintext -> encrypted, removed plaintext')
  return raw
}

export function loadLocalSecrets() {
  try {
    let raw = null
    if (existsSync(ENC)) {
      raw = dpapiDecrypt(readFileSync(ENC, 'utf-8')).toString('utf-8')
    } else if (existsSync(PLAIN)) {
      raw = migratePlaintext(PLAIN, ENC)
    }
    if (!raw) return { loaded: false }
    return { loaded: true, applied: applyToEnv(JSON.parse(raw)) }
  } catch (e) {
    console.warn('[secrets] load failed:', e.message)
    return { loaded: false, error: e.message }
  }
}
