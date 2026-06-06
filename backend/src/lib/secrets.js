/**
 * Load local secrets (Telegram bot tokens, etc.) from backend/data/secrets.local.json
 * into process.env at boot. The file is gitignored (backend/data/ is ignored
 * wholesale), so secrets stay out of git and out of the packaged installer.
 *
 * Existing env vars win — env beats file, so the OS-level config (setx) is
 * always authoritative when both are present.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const FILE = join(__dir, '..', '..', 'data', 'secrets.local.json')

export function loadLocalSecrets() {
  if (!existsSync(FILE)) return { loaded: false }
  try {
    const obj = JSON.parse(readFileSync(FILE, 'utf-8'))
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
    return { loaded: true, applied }
  } catch (e) {
    console.warn('[secrets] load failed:', e.message)
    return { loaded: false, error: e.message }
  }
}
