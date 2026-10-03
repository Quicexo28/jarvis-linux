#!/usr/bin/env node
/**
 * Set a permission password on this Linux machine.
 *
 *   (default)  JARVIS_CODE_PASSWORD_HASH — code-change password (codeAuth.js)
 *   --risk     JARVIS_RISK_PASSWORD_HASH — special password for risky actions
 *              requested from the tablet app (riskAuth.js)
 *
 * Stores ONLY a scrypt hash, inside backend/data/secrets.local.json — the file
 * lib/secrets.js actually loads at boot. (This script used to write a
 * keyring-encrypted secrets.local.enc that nothing reads, and DELETE the .json:
 * running it wiped every secret — Telegram, Sunshine, tokens — and the password
 * still didn't load.) The previous file is kept as secrets.local.json.bak.
 *
 * Usage:
 *   node scripts/set-code-password.js            # prompts (preferred: argv lands in shell history)
 *   node scripts/set-code-password.js --risk
 *   node scripts/set-code-password.js "mi contraseña"
 */

import { randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', 'data')
const PLAIN = join(DATA_DIR, 'secrets.local.json')
const SCRYPT_KEYLEN = 64

function hash(plain) {
  const saltHex = randomBytes(16).toString('hex')
  const derived = scryptSync(String(plain), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
  return `scrypt$${saltHex}$${derived.toString('hex')}`
}

function loadSecrets() {
  if (!existsSync(PLAIN)) return {}
  // A parse error must ABORT, not fall back to {}: writing {} back would wipe
  // every secret in the file.
  return JSON.parse(readFileSync(PLAIN, 'utf-8'))
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => { rl.close(); resolve(answer) })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const risk = args.includes('--risk')
  const key = risk ? 'JARVIS_RISK_PASSWORD_HASH' : 'JARVIS_CODE_PASSWORD_HASH'
  const minLen = risk ? 8 : 4
  let password = args.find((a) => a !== '--risk')
  if (!password) {
    password = (await ask(risk ? 'Contraseña especial para acciones de riesgo: ' : 'Nueva contraseña de cambios de código: ')).trim()
  }
  if (!password || password.length < minLen) {
    console.error(`La contraseña debe tener al menos ${minLen} caracteres.`)
    process.exit(1)
  }

  mkdirSync(DATA_DIR, { recursive: true })
  let secrets
  try {
    secrets = loadSecrets()
  } catch (e) {
    console.error(`No pude leer ${PLAIN} (${e.message}). No toco nada.`)
    process.exit(1)
  }
  if (existsSync(PLAIN)) copyFileSync(PLAIN, `${PLAIN}.bak`)
  secrets[key] = hash(password)

  const tmp = `${PLAIN}.tmp`
  writeFileSync(tmp, JSON.stringify(secrets, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, PLAIN)

  console.log(`${key} guardado (hash scrypt) en ${PLAIN}`)
  console.log('Reinicia el backend para que tome efecto: systemctl --user restart jarvis-backend')
}

main()
