#!/usr/bin/env node
/**
 * Build (or refresh) the portable owner vault on this Linux machine.
 *
 * Bundles the current owner voiceprint + secrets into data/jarvis-portable.enc,
 * encrypted with a key DERIVED from the owner password (scrypt → AES-256-GCM).
 * The same password unlocks it on any machine. Run after re-enrolling voice or
 * rotating the password:
 *
 *   node scripts/make-portable.js "mi contraseña"
 *   node scripts/make-portable.js                 # prompts on stdin
 */

import { randomBytes, scryptSync } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'
import { dpapiEncrypt, dpapiDecrypt, dpapiDecryptRaw } from '../src/lib/linuxKeyring.js'
import { seal } from '../src/lib/portableVault.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dir, '..', 'data')
const SECRETS_ENC = join(DATA_DIR, 'secrets.local.enc')
const SECRETS_PLAIN = join(DATA_DIR, 'secrets.local.json')
const VOICEPRINT_ENC = join(__dir, '..', 'voice', 'python', 'owner_voiceprint.enc')
const PORTABLE = join(DATA_DIR, 'jarvis-portable.enc')
const SCRYPT_KEYLEN = 64

function hashPassword(plain) {
  const saltHex = randomBytes(16).toString('hex')
  const derived = scryptSync(String(plain), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
  return `scrypt$${saltHex}$${derived.toString('hex')}`
}

function loadSecrets() {
  if (existsSync(SECRETS_ENC)) {
    return JSON.parse(dpapiDecrypt(readFileSync(SECRETS_ENC, 'utf-8')).toString('utf-8'))
  }
  if (existsSync(SECRETS_PLAIN)) {
    return JSON.parse(readFileSync(SECRETS_PLAIN, 'utf-8'))
  }
  return {}
}

function loadVoiceprint() {
  if (!existsSync(VOICEPRINT_ENC)) {
    throw new Error(`No existe ${VOICEPRINT_ENC} — graba la huella primero (make_owner_voiceprint.py)`)
  }
  return JSON.parse(dpapiDecryptRaw(readFileSync(VOICEPRINT_ENC)).toString('utf-8'))
}

function ask(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(q, (a) => { rl.close(); resolve(a) })
  })
}

async function main() {
  let password = process.argv[2]
  if (!password) password = (await ask('Contraseña de owner (la misma en toda máquina): ')).trim()
  if (!password || password.length < 4) {
    console.error('La contraseña debe tener al menos 4 caracteres.')
    process.exit(1)
  }

  mkdirSync(DATA_DIR, { recursive: true })
  const secrets = loadSecrets()
  const voiceprint = loadVoiceprint()

  secrets.JARVIS_CODE_PASSWORD_HASH = hashPassword(password)

  writeFileSync(PORTABLE, seal(password, { secrets, voiceprint }), 'utf-8')
  writeFileSync(SECRETS_ENC, dpapiEncrypt(JSON.stringify(secrets, null, 2)), 'utf-8')

  console.log(`Bóveda portable escrita: ${PORTABLE}`)
  console.log('Cópiala a cualquier máquina Linux y ejecuta: node scripts/unlock.js')
}

main()
