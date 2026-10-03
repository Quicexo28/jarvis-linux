/**
 * Step-up authorization for RISKY actions requested from the tablet/phone app.
 *
 * A typed chat turn (/api/jarvis/turn) has no speaker identity, so the risk
 * gate (toolRisk.js) treats it like an unrecognised voice: it may look, not
 * touch, and never do anything destructive. This module lets the owner lift
 * that for ONE turn with two independent factors:
 *
 *   1. Possession + biometric/PIN — an EC P-256 key generated inside the
 *      tablet's Android Keystore with "user authentication required on every
 *      use". The private key never leaves the secure hardware and can only sign
 *      after the fingerprint or the device PIN. The backend sends a fresh
 *      challenge; a valid signature over it proves THAT tablet AND its unlock.
 *      (A biometric check done only in JavaScript would be theatre: anyone with
 *      the web token could skip it and call the endpoint directly.)
 *   2. Knowledge — a special password, stored only as a scrypt hash in
 *      secrets.local.json (JARVIS_RISK_PASSWORD_HASH, set with
 *      `node scripts/set-code-password.js --risk`).
 *
 * Both together mint a one-shot ticket that is consumed by exactly one chat
 * turn. Enrolling a new device key also requires the password, so a stolen web
 * token alone can neither enroll its own key nor elevate.
 *
 * Fails CLOSED: no password configured ⇒ nothing can be elevated. Repeated
 * failures lock elevation for a while (global, not per IP: there is one owner).
 */

import { createHash, createPublicKey, createVerify, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { verifyScrypt } from './codeAuth.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DEFAULT_KEYS_FILE = resolve(__dir, '..', '..', 'data', 'elevation-keys.json')
const keysFile = () => process['env']['JARVIS_ELEVATION_KEYS_FILE'] || DEFAULT_KEYS_FILE

const CHALLENGE_TTL_MS = 2 * 60e3     // covers the time to type the password + touch the sensor
const TICKET_TTL_MS = 2 * 60e3        // ticket must be spent on the very next turn
const MAX_FAILURES = 5
const LOCKOUT_MS = 15 * 60e3

/** @type {Map<string, number>} challenge(base64) → expiry */
const challenges = new Map()
/** @type {Map<string, number>} ticket id → expiry */
const tickets = new Map()
let failures = 0
let lockedUntil = 0

function now() { return Date.now() }

function prune(map) {
  const t = now()
  for (const [k, exp] of map) if (exp <= t) map.delete(k)
}

export function riskPasswordConfigured() {
  return !!process['env']['JARVIS_RISK_PASSWORD_HASH']
}

function loadKeys() {
  try { return JSON.parse(readFileSync(keysFile(), 'utf-8')) } catch { return {} }
}

function saveKeys(keys) {
  const file = keysFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(keys, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * Parse a base64 SPKI public key. Only EC P-256 is accepted — it is what the
 * Android side generates, and pinning the curve removes a class of downgrade.
 * @returns {{ key: import('crypto').KeyObject, keyId: string } | null}
 */
export function parsePublicKey(b64) {
  try {
    const der = Buffer.from(String(b64 || ''), 'base64')
    if (der.length < 60 || der.length > 200) return null
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null
    // The id is derived from the key itself: nothing for the client to spoof.
    const keyId = createHash('sha256').update(der).digest('hex').slice(0, 16)
    return { key, keyId }
  } catch {
    return null
  }
}

function lockoutState() {
  if (lockedUntil > now()) {
    return { ok: false, error: 'locked', retryInS: Math.ceil((lockedUntil - now()) / 1000) }
  }
  return null
}

function fail(error) {
  failures += 1
  if (failures >= MAX_FAILURES) {
    lockedUntil = now() + LOCKOUT_MS
    failures = 0
    console.warn(`[risk-auth] ${MAX_FAILURES} fallos seguidos — elevación bloqueada ${LOCKOUT_MS / 60e3} min`)
  }
  return { ok: false, error }
}

/** What the app needs to know before showing the prompt. */
export function elevationStatus(publicKeyB64) {
  const parsed = publicKeyB64 ? parsePublicKey(publicKeyB64) : null
  return {
    ok: true,
    configured: riskPasswordConfigured(),
    enrolled: parsed ? !!loadKeys()[parsed.keyId] : false,
    locked: lockedUntil > now(),
  }
}

/** Register this device's Keystore public key. Requires the special password. */
export function enrollDevice({ publicKey, password, label } = {}) {
  if (!riskPasswordConfigured()) return { ok: false, error: 'no_password_set' }
  const locked = lockoutState()
  if (locked) return locked
  const parsed = parsePublicKey(publicKey)
  if (!parsed) return { ok: false, error: 'bad_public_key' }
  if (!verifyScrypt(password, process['env']['JARVIS_RISK_PASSWORD_HASH'])) return fail('wrong_password')
  failures = 0
  const keys = loadKeys()
  keys[parsed.keyId] = {
    publicKey: String(publicKey),
    label: String(label || 'dispositivo').slice(0, 60),
    enrolledAt: new Date().toISOString(),
  }
  saveKeys(keys)
  console.log(`[risk-auth] dispositivo inscrito: ${parsed.keyId} (${keys[parsed.keyId].label})`)
  return { ok: true, keyId: parsed.keyId }
}

export function issueChallenge() {
  prune(challenges)
  const challenge = randomBytes(32).toString('base64')
  challenges.set(challenge, now() + CHALLENGE_TTL_MS)
  return { ok: true, challenge, ttlS: CHALLENGE_TTL_MS / 1000 }
}

/**
 * Verify both factors and mint a one-shot ticket.
 * @param {{ publicKey: string, challenge: string, signature: string, password: string }} p
 */
export function elevate({ publicKey, challenge, signature, password } = {}) {
  if (!riskPasswordConfigured()) return { ok: false, error: 'no_password_set' }
  const locked = lockoutState()
  if (locked) return locked

  prune(challenges)
  // Consume the challenge FIRST, whatever happens next: a challenge is good for
  // one attempt, so a captured signature cannot be replayed.
  const ch = String(challenge || '')
  if (!challenges.has(ch)) return { ok: false, error: 'bad_challenge' }
  challenges.delete(ch)

  const parsed = parsePublicKey(publicKey)
  if (!parsed) return { ok: false, error: 'bad_public_key' }
  if (!loadKeys()[parsed.keyId]) return { ok: false, error: 'not_enrolled' }

  let sigOk = false
  try {
    // Android's SHA256withECDSA emits a DER signature, which is Node's default
    // encoding for EC verify.
    const v = createVerify('SHA256')
    v.update(Buffer.from(ch, 'base64'))
    sigOk = v.verify(parsed.key, Buffer.from(String(signature || ''), 'base64'))
  } catch {
    sigOk = false
  }
  if (!sigOk) return fail('bad_signature')
  if (!verifyScrypt(password, process['env']['JARVIS_RISK_PASSWORD_HASH'])) return fail('wrong_password')

  failures = 0
  prune(tickets)
  const ticket = randomBytes(24).toString('hex')
  tickets.set(ticket, now() + TICKET_TTL_MS)
  console.log(`[risk-auth] elevación concedida a ${parsed.keyId} (un turno)`)
  return { ok: true, ticket, ttlS: TICKET_TTL_MS / 1000 }
}

/** Spend a ticket. True exactly once per valid, unexpired ticket. */
export function consumeTicket(ticket) {
  prune(tickets)
  const t = String(ticket || '')
  if (!tickets.has(t)) return false
  tickets.delete(t)
  return true
}

/** Test helper: forget every in-memory challenge, ticket and failure count. */
export function _resetRiskAuth() {
  challenges.clear()
  tickets.clear()
  failures = 0
  lockedUntil = 0
}
