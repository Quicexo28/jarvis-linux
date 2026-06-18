#!/usr/bin/env node
/**
 * Set the code-change permission password on this Linux machine.
 *
 * Stores ONLY a scrypt hash of the password inside the keyring-encrypted secrets
 * file (backend/data/secrets.local.enc). The plaintext password is read from
 * argv/stdin and never written anywhere.
 *
 * Usage:
 *   node scripts/set-code-password.js "mi contraseña"
 *   node scripts/set-code-password.js            # prompts on stdin
 */

import { randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'
import { dpapiEncrypt, dpapiDecrypt } from '../src/lib/linuxKeyring.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', 'data')
const PLAIN = join(DATA_DIR, 'secrets.local.json')
const ENC = join(DATA_DIR, 'secrets.local.enc')
const SCRYPT_KEYLEN = 64

function hash(plain) {
  const saltHex = randomBytes(16).toString('hex')
  const derived = scryptSync(String(plain), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
  return `scrypt$${saltHex}$${derived.toString('hex')}`
}

function loadSecrets() {
  if (existsSync(ENC)) {
    try { return JSON.parse(dpapiDecrypt(readFileSync(ENC, 'utf-8')).toString('utf-8')) } catch { return {} }
  }
  if (existsSync(PLAIN)) {
    try { return JSON.parse(readFileSync(PLAIN, 'utf-8')) } catch { return {} }
  }
  return {}
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => { rl.close(); resolve(answer) })
  })
}

async function main() {
  let password = process.argv[2]
  if (!password) password = (await ask('Nueva contraseña de cambios de código: ')).trim()
  if (!password || password.length < 4) {
    console.error('La contraseña debe tener al menos 4 caracteres.')
    process.exit(1)
  }

  mkdirSync(DATA_DIR, { recursive: true })
  const secrets = loadSecrets()
  secrets.JARVIS_CODE_PASSWORD_HASH = hash(password)

  writeFileSync(ENC, dpapiEncrypt(JSON.stringify(secrets, null, 2)), 'utf-8')
  if (existsSync(PLAIN)) { try { unlinkSync(PLAIN) } catch {} }

  console.log(`Contraseña guardada (hash scrypt, cifrada con keyring local) en ${ENC}`)
  console.log('Reinicia el backend para que tome efecto.')
}

main()
