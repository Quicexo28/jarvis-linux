/**
 * Linux machine-scoped encryption — functional equivalent of Windows DPAPI.
 *
 * Stores a random 32-byte AES key in the Linux Secret Service (via secret-tool
 * CLI, part of libsecret). Falls back to ~/.config/jarvis/machine.key (chmod
 * 600) if secret-tool is unavailable (headless servers, no keyring daemon).
 *
 * Encrypted blobs: base64(iv[12] || ciphertext || tag[16]) — AES-256-GCM.
 * A stolen blob is useless without the machine key.
 *
 * Exported names match dpapi.js so callers are drop-in compatible.
 */

import { execFileSync } from 'child_process'
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const KEY_SERVICE = 'jarvis-linux'
const KEY_ACCOUNT = 'machine-key'
const FALLBACK_KEY_PATH = join(homedir(), '.config', 'jarvis', 'machine.key')

function loadOrCreateKey() {
  // Try secret-tool (libsecret) first
  try {
    const hex = execFileSync(
      'secret-tool', ['lookup', 'service', KEY_SERVICE, 'account', KEY_ACCOUNT],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    if (hex.length === 64) return Buffer.from(hex, 'hex')
  } catch {}

  // Try fallback key file
  if (existsSync(FALLBACK_KEY_PATH)) {
    try {
      const hex = readFileSync(FALLBACK_KEY_PATH, 'utf8').trim()
      if (hex.length === 64) return Buffer.from(hex, 'hex')
    } catch {}
  }

  // Generate fresh key and persist it
  const key = randomBytes(32)
  const hex = key.toString('hex')

  try {
    execFileSync(
      'secret-tool',
      ['store', '--label=Jarvis machine key', 'service', KEY_SERVICE, 'account', KEY_ACCOUNT],
      { input: hex, encoding: 'utf8', timeout: 5000 }
    )
    console.log('[linuxKeyring] machine key stored in Secret Service')
  } catch {
    // No keyring daemon — fall back to key file with restricted permissions
    mkdirSync(join(homedir(), '.config', 'jarvis'), { recursive: true })
    writeFileSync(FALLBACK_KEY_PATH, hex, 'utf8')
    chmodSync(FALLBACK_KEY_PATH, 0o600)
    console.log('[linuxKeyring] machine key stored in file (secret-tool unavailable)')
  }

  return key
}

// Lazy-loaded on first use — avoids blocking startup if keyring daemon is slow.
let _key = null
function getMachineKey() {
  if (!_key) _key = loadOrCreateKey()
  return _key
}

/** Encrypt plain (Buffer | string). Returns base64 ciphertext (store this). */
export function dpapiEncrypt(plain) {
  const key = getMachineKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const pt = Buffer.isBuffer(plain) ? plain : Buffer.from(plain)
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag]).toString('base64')
}

/** Decrypt base64 ciphertext produced by dpapiEncrypt. Returns a Buffer. */
export function dpapiDecrypt(cipherB64) {
  const key = getMachineKey()
  const blob = Buffer.from(String(cipherB64).trim(), 'base64')
  if (blob.length < 28) throw new Error('invalid_ciphertext')
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(blob.length - 16)
  const ct = blob.subarray(12, blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** Encrypt to a raw blob Buffer (same API surface as DPAPI raw variant). */
export function dpapiEncryptRaw(plain) {
  return Buffer.from(dpapiEncrypt(plain), 'base64')
}

/** Decrypt a raw blob Buffer. */
export function dpapiDecryptRaw(blobBuf) {
  return dpapiDecrypt(Buffer.from(blobBuf).toString('base64'))
}
