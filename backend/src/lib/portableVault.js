/**
 * Portable owner vault — password-derived encryption that works on ANY machine.
 *
 * Holds the owner voiceprint + secrets encrypted with a key DERIVED from the
 * owner password (scrypt) — never stored. The same password unlocks it on any
 * PC; a stolen vault is useless without the password. This is the cross-machine
 * layer; per-PC hands-free boot is a local DPAPI cache written after first
 * unlock (see handlers/security.js).
 *
 * Format (JSON): { v, kdf:{salt,N,r,p,keylen}, iv, tag, ct } — all base64.
 * Cipher: AES-256-GCM (authenticated: a wrong password fails the auth tag, so
 * decryption throws rather than returning garbage).
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const KDF = { N: 1 << 15, r: 8, p: 1, keylen: 32 }  // scrypt → AES-256 key
const SCRYPT_MAXMEM = 256 * 1024 * 1024

function deriveKey(password, salt) {
  return scryptSync(String(password), salt, KDF.keylen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: SCRYPT_MAXMEM })
}

/** Encrypt an object with a password. Returns the vault JSON string. */
export function seal(password, obj) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const pt = Buffer.from(JSON.stringify(obj), 'utf-8')
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    v: 1,
    kdf: { salt: salt.toString('base64'), N: KDF.N, r: KDF.r, p: KDF.p, keylen: KDF.keylen },
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  })
}

/**
 * Decrypt a vault JSON string with a password. Throws 'wrong_password' if the
 * password is wrong (GCM auth failure) or the blob is malformed.
 */
export function open(password, vaultJson) {
  let v
  try { v = JSON.parse(vaultJson) } catch { throw new Error('vault_malformed') }
  if (!v || !v.kdf || !v.iv || !v.tag || !v.ct) throw new Error('vault_malformed')
  const salt = Buffer.from(v.kdf.salt, 'base64')
  const key = scryptSync(String(password), salt, v.kdf.keylen || 32, {
    N: v.kdf.N, r: v.kdf.r, p: v.kdf.p, maxmem: SCRYPT_MAXMEM,
  })
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(v.tag, 'base64'))
  try {
    const pt = Buffer.concat([decipher.update(Buffer.from(v.ct, 'base64')), decipher.final()])
    return JSON.parse(pt.toString('utf-8'))
  } catch {
    throw new Error('wrong_password')
  }
}
