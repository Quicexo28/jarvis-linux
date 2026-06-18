#!/usr/bin/env node
/**
 * Unlock the portable owner vault on this Linux machine (one-time per machine).
 *
 * Decrypts data/jarvis-portable.enc with the owner password and writes the
 * per-machine keyring caches (secrets.local.enc + owner_voiceprint.enc) so the
 * app boots hands-free afterward. Headless alternative to the in-app unlock
 * modal — useful on a fresh machine before first launch.
 *
 *   node scripts/unlock.js "mi contraseña"
 *   node scripts/unlock.js                 # prompts on stdin
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'
import { dpapiEncrypt, dpapiEncryptRaw } from '../src/lib/linuxKeyring.js'
import { open as openVault } from '../src/lib/portableVault.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', 'data')
const SECRETS_ENC = join(DATA_DIR, 'secrets.local.enc')
const PORTABLE = join(DATA_DIR, 'jarvis-portable.enc')
const VOICEPRINT_ENC = join(__dir, '..', 'voice', 'python', 'owner_voiceprint.enc')

function ask(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (a) => { rl.close(); resolve(a) })
  })
}

async function main() {
  if (!existsSync(PORTABLE)) {
    console.error(`No existe ${PORTABLE} — copia jarvis-portable.enc a backend/data/ primero.`)
    process.exit(1)
  }
  let password = process.argv[2]
  if (!password) password = (await ask('Contraseña de owner: ')).trim()

  let data
  try {
    data = openVault(password, readFileSync(PORTABLE, 'utf-8'))
  } catch (e) {
    console.error(e.message === 'wrong_password' ? 'Contraseña incorrecta.' : `Error: ${e.message}`)
    process.exit(1)
  }

  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(SECRETS_ENC, dpapiEncrypt(JSON.stringify(data.secrets || {}, null, 2)), 'utf-8')
  if (data.voiceprint) writeFileSync(VOICEPRINT_ENC, dpapiEncryptRaw(JSON.stringify(data.voiceprint)))

  console.log('Desbloqueado en esta máquina. Cachés locales escritas.')
  console.log('Inicia Jarvis: systemctl --user start jarvis-backend')
}

main()
