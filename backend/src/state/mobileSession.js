import { randomBytes } from 'crypto'

function freshSession() {
  return {
    token: randomBytes(16).toString('hex'),
    expiresAt: Date.now() + 10 * 60 * 1000,
    activated: false,
    connectedAt: null,
    lastSeen: null,
    userAgent: null,
    via: null,
  }
}

let session = freshSession()

export function getSession() {
  return session
}

export function activateSession(userAgent, via) {
  session = {
    ...session,
    activated: true,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    userAgent,
    via,
  }
}

export function resetSession() {
  session = freshSession()
}

export function isExpired() {
  return !session.activated && Date.now() > session.expiresAt
}
