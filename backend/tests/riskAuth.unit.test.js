/**
 * Autorización reforzada desde la tablet: clave del Keystore (huella/PIN) +
 * contraseña especial ⇒ un ticket de UN turno. Se simula la tablet con una
 * clave EC P-256 generada en Node, firmando igual que SHA256withECDSA (DER).
 */
import { test, expect, beforeEach, afterAll } from 'vitest'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword } from '../src/lib/codeAuth.js'
import {
  enrollDevice, issueChallenge, elevate, consumeTicket, elevationStatus, parsePublicKey, _resetRiskAuth,
} from '../src/lib/riskAuth.js'
import { checkToolRisk, setElevatedTurnProbe } from '../src/lib/toolRisk.js'
import { onlyTurnInFlightTagged } from '../src/lib/claudeCli.js'

const PASS = 'clave-especial-123'
process.env.JARVIS_ELEVATION_KEYS_FILE = join(mkdtempSync(join(tmpdir(), 'elev-')), 'keys.json')

function tablet() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const sign = (challengeB64) => {
    const s = createSign('SHA256')
    s.update(Buffer.from(challengeB64, 'base64'))
    return s.sign(privateKey).toString('base64')
  }
  return { pub, sign }
}

beforeEach(() => {
  _resetRiskAuth()
  process.env.JARVIS_RISK_PASSWORD_HASH = hashPassword(PASS, '00112233445566778899aabbccddeeff')
})
afterAll(() => { delete process.env.JARVIS_RISK_PASSWORD_HASH; setElevatedTurnProbe(null) })

test('sin contraseña configurada no se eleva nada (falla cerrado)', () => {
  delete process.env.JARVIS_RISK_PASSWORD_HASH
  const t = tablet()
  expect(enrollDevice({ publicKey: t.pub, password: PASS }).error).toBe('no_password_set')
  const { challenge } = issueChallenge()
  expect(elevate({ publicKey: t.pub, challenge, signature: t.sign(challenge), password: PASS }).error).toBe('no_password_set')
})

test('flujo completo: inscribir, firmar el reto, ticket de un solo uso', () => {
  const t = tablet()
  expect(elevationStatus(t.pub)).toMatchObject({ configured: true, enrolled: false })
  expect(enrollDevice({ publicKey: t.pub, password: PASS, label: 'tablet' }).ok).toBe(true)
  expect(elevationStatus(t.pub).enrolled).toBe(true)

  const { challenge } = issueChallenge()
  const r = elevate({ publicKey: t.pub, challenge, signature: t.sign(challenge), password: PASS })
  expect(r.ok).toBe(true)
  expect(consumeTicket(r.ticket)).toBe(true)
  expect(consumeTicket(r.ticket)).toBe(false)     // un turno, no dos
})

test('inscribir exige la contraseña: el token solo no basta', () => {
  const t = tablet()
  expect(enrollDevice({ publicKey: t.pub, password: 'otra' }).error).toBe('wrong_password')
  expect(elevationStatus(t.pub).enrolled).toBe(false)
})

test('sin firma válida no hay ticket, aunque la contraseña sea buena', () => {
  const t = tablet()
  const intruso = tablet()
  enrollDevice({ publicKey: t.pub, password: PASS })
  const { challenge } = issueChallenge()
  expect(elevate({ publicKey: t.pub, challenge, signature: intruso.sign(challenge), password: PASS }).error).toBe('bad_signature')
})

test('una clave no inscrita no eleva', () => {
  const t = tablet()
  const { challenge } = issueChallenge()
  expect(elevate({ publicKey: t.pub, challenge, signature: t.sign(challenge), password: PASS }).error).toBe('not_enrolled')
})

test('el reto vale un intento: una firma capturada no se reutiliza', () => {
  const t = tablet()
  enrollDevice({ publicKey: t.pub, password: PASS })
  const { challenge } = issueChallenge()
  const signature = t.sign(challenge)
  expect(elevate({ publicKey: t.pub, challenge, signature, password: 'mal' }).error).toBe('wrong_password')
  expect(elevate({ publicKey: t.pub, challenge, signature, password: PASS }).error).toBe('bad_challenge')
})

test('5 fallos bloquean la elevación', () => {
  const t = tablet()
  enrollDevice({ publicKey: t.pub, password: PASS })
  for (let i = 0; i < 5; i++) {
    const { challenge } = issueChallenge()
    elevate({ publicKey: t.pub, challenge, signature: t.sign(challenge), password: 'mal' })
  }
  const { challenge } = issueChallenge()
  expect(elevate({ publicKey: t.pub, challenge, signature: t.sign(challenge), password: PASS }).error).toBe('locked')
})

test('solo se acepta EC P-256', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
  expect(parsePublicKey(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))).toBeNull()
  expect(parsePublicKey('basura')).toBeNull()
})

test('el gate deja pasar lo destructivo SOLO durante un turno elevado', () => {
  const req = { url: '/api/skills/computer/task', headers: { 'x-jarvis-origin': 'model' } }
  setElevatedTurnProbe(() => false)
  expect(checkToolRisk(req).allowed).toBe(false)
  setElevatedTurnProbe(() => true)
  expect(checkToolRisk(req)).toMatchObject({ allowed: true, reason: 'elevated_turn' })
  setElevatedTurnProbe(null)
  expect(checkToolRisk(req).allowed).toBe(false)
})

test('sin turnos en vuelo no hay turno elevado', () => {
  expect(onlyTurnInFlightTagged('elevated')).toBe(false)
})
