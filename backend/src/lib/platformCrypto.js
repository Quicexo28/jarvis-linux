/**
 * Platform-portable "DPAPI" abstraction.
 *
 * On Windows this is real DPAPI (CurrentUser scope) via PowerShell ProtectedData,
 * byte-for-byte compatible with the original dpapi.js it replaces. On Linux (and
 * any non-win32 platform) there is no DPAPI, so we emulate the same at-rest
 * protection with AES-256-GCM keyed by a per-machine key file.
 *
 * The exported names (dpapiEncrypt / dpapiDecrypt / dpapiEncryptRaw /
 * dpapiDecryptRaw) are kept identical so importers don't change.
 *
 * ── Linux container format (RAW blob bytes) ───────────────────────────────────
 *     0x01            1-byte version
 *     iv              12 bytes  (random per encryption)
 *     ciphertext      N bytes
 *     authTag         16 bytes  (GCM tag, appended last)
 *
 * Cipher: AES-256-GCM. Key = 32 bytes read from the machine key file.
 *
 * MACHINE KEY FILE: <homedir>/.config/jarvis/machine.key
 *   If missing: the dir is created (mode 0700), 32 random bytes are generated
 *   and written with mode 0600.
 *
 * Node's GCM exposes ciphertext and tag separately (cipher.getAuthTag(), 16
 * bytes), so on write we concatenate as `ct || tag`; on read we split the last
 * 16 bytes back off as the tag. Python's `cryptography` AESGCM returns
 * `ct || tag` already concatenated, so the format maps directly between the two
 * — this is what lets Node write the owner voiceprint .enc that the Python STT
 * service reads (and vice-versa).
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const IS_WINDOWS = process.platform === 'win32'

// ──────────────────────────────────────────────────────────── Windows (DPAPI) ──

const ENC_SCRIPT = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b64=[Console]::In.ReadToEnd()
$bytes=[Convert]::FromBase64String($b64)
$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($enc))`

const DEC_SCRIPT = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b64=[Console]::In.ReadToEnd()
$bytes=[Convert]::FromBase64String($b64)
$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($dec))`

function runPs(script, inputB64) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: inputB64, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, windowsHide: true },
  ).trim()
}

function winEncrypt(plain) {
  const inB64 = Buffer.from(plain).toString('base64')
  return runPs(ENC_SCRIPT, inB64)
}

function winDecrypt(cipherB64) {
  const outB64 = runPs(DEC_SCRIPT, String(cipherB64).trim())
  return Buffer.from(outB64, 'base64')
}

// ──────────────────────────────────────────────────────────── Linux (AES-GCM) ──

const VERSION = 0x01
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

function machineKeyPath() {
  return join(homedir(), '.config', 'jarvis', 'machine.key')
}

// Read the per-machine AES key, generating it on first use. The key dir is
// created mode 0700 and the key file mode 0600 so only this user can read it.
function loadMachineKey() {
  const keyPath = machineKeyPath()
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath)
    if (key.length === KEY_LEN) return key
    // A corrupt/short key would silently break decryption — fail loudly.
    throw new Error(`machine key at ${keyPath} is ${key.length} bytes, expected ${KEY_LEN}`)
  }
  const dir = join(homedir(), '.config', 'jarvis')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = randomBytes(KEY_LEN)
  writeFileSync(keyPath, key, { mode: 0o600 })
  return key
}

function linuxEncryptRaw(plain) {
  const key = loadMachineKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const pt = Buffer.isBuffer(plain) ? plain : Buffer.from(plain)
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  // version || iv || ct || tag
  return Buffer.concat([Buffer.from([VERSION]), iv, ct, tag])
}

function linuxDecryptRaw(blobBuf) {
  const blob = Buffer.isBuffer(blobBuf) ? blobBuf : Buffer.from(blobBuf)
  if (blob.length < 1 + IV_LEN + TAG_LEN) throw new Error('blob_too_short')
  if (blob[0] !== VERSION) throw new Error(`unsupported blob version ${blob[0]}`)
  const key = loadMachineKey()
  const iv = blob.subarray(1, 1 + IV_LEN)
  const ct = blob.subarray(1 + IV_LEN, blob.length - TAG_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

// ───────────────────────────────────────────────────────────── public API ──

/** Encrypt a Buffer/string. Returns base64 ciphertext (store this). */
export function dpapiEncrypt(plain) {
  if (IS_WINDOWS) return winEncrypt(plain)
  return linuxEncryptRaw(plain).toString('base64')
}

/** Decrypt base64 ciphertext produced by dpapiEncrypt. Returns a Buffer. */
export function dpapiDecrypt(cipherB64) {
  if (IS_WINDOWS) return winDecrypt(cipherB64)
  return linuxDecryptRaw(Buffer.from(String(cipherB64).trim(), 'base64'))
}

/**
 * Encrypt to a RAW blob Buffer (not base64). This is the on-disk format the
 * Python side (dpapi_util) expects, so Node can write a voiceprint blob the STT
 * service reads. On Windows it's a DPAPI blob; on Linux it's the AES-256-GCM
 * container documented in the header — both are cross-language for that platform.
 */
export function dpapiEncryptRaw(plain) {
  if (IS_WINDOWS) return Buffer.from(winEncrypt(plain), 'base64')
  return linuxEncryptRaw(plain)
}

/** Decrypt a RAW blob Buffer (e.g. a Python-written voiceprint .enc). */
export function dpapiDecryptRaw(blobBuf) {
  if (IS_WINDOWS) return winDecrypt(Buffer.from(blobBuf).toString('base64'))
  return linuxDecryptRaw(blobBuf)
}
