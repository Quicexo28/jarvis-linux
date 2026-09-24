#!/usr/bin/env node
/**
 * Set the password that authorizes Jarvis to change its own code.
 *
 *   node scripts/set-code-password.js            # prompts (hidden input)
 *   node scripts/set-code-password.js "mi clave" # non-interactive
 *
 * Writes JARVIS_CODE_PASSWORD_HASH into backend/data/secrets.local.json (the
 * file secrets.js loads into process.env at boot). Only the scrypt hash is
 * stored — never the plaintext. Restart jarvis-backend afterwards.
 *
 * With a hash set, every /api/skills/code/* action pops a password modal in the
 * renderer (codeAuth.js) and unlocks for 5 minutes. Without one, the gate fails
 * closed unless JARVIS_CODE_TRUST_LOCAL=1 is set in the service file.
 */

import { randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __dir = dirname(fileURLToPath(import.meta.url))
const SECRETS = resolve(__dir, '..', 'backend', 'data', 'secrets.local.json')
const KEY = 'JARVIS_CODE_PASSWORD_HASH'
const SCRYPT_KEYLEN = 64

function hash(plain) {
  const saltHex = randomBytes(16).toString('hex')
  const derived = scryptSync(String(plain), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
  return `scrypt$${saltHex}$${derived.toString('hex')}`
}

function ask(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    // Hide typed characters: the terminal echo is muted while the prompt is open.
    const onData = (char) => {
      if (['\n', '\r', ''].includes(String(char))) process.stdin.removeListener('data', onData)
      else process.stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length))
    }
    process.stdin.on('data', onData)
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); res(answer) })
  })
}

async function main() {
  let plain = process.argv[2]
  if (!plain) {
    plain = await ask('Contraseña para cambios de código: ')
    const again = await ask('Repítela: ')
    if (plain !== again) {
      console.error('No coinciden. Nada guardado.')
      process.exit(1)
    }
  }
  if (!plain || plain.length < 4) {
    console.error('Contraseña demasiado corta (mínimo 4 caracteres). Nada guardado.')
    process.exit(1)
  }

  let obj = {}
  if (existsSync(SECRETS)) {
    try { obj = JSON.parse(readFileSync(SECRETS, 'utf-8')) } catch {
      console.error(`No pude leer ${SECRETS} (JSON inválido). Arréglalo antes de continuar.`)
      process.exit(1)
    }
  } else {
    mkdirSync(dirname(SECRETS), { recursive: true })
  }

  obj[KEY] = hash(plain)
  writeFileSync(SECRETS, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  console.log(`✅ Hash guardado en ${SECRETS}`)
  console.log('   Reinicia el backend:  systemctl --user restart jarvis-backend')
  console.log('   (y quita JARVIS_CODE_TRUST_LOCAL=1 del .service si quieres exigir la contraseña)')
}

main().catch((e) => { console.error(e); process.exit(1) })
