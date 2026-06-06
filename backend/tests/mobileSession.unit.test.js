import { test, expect, beforeEach } from 'vitest'
import {
  getSession,
  activateSession,
  resetSession,
  isExpired,
} from '../src/state/mobileSession.js'

beforeEach(() => {
  resetSession()
})

test('getSession returns a token of 32 hex chars', () => {
  const s = getSession()
  expect(s.token).toMatch(/^[0-9a-f]{32}$/)
})

test('getSession returns activated=false and expiresAt ~10min from now', () => {
  const before = Date.now()
  const s = getSession()
  expect(s.activated).toBe(false)
  expect(s.expiresAt).toBeGreaterThan(before + 9 * 60 * 1000)
  expect(s.expiresAt).toBeLessThan(before + 11 * 60 * 1000)
})

test('isExpired returns false for a fresh session', () => {
  expect(isExpired()).toBe(false)
})

test('activateSession marks session activated with via and userAgent', () => {
  activateSession('Mozilla/5.0', 'tailscale')
  const s = getSession()
  expect(s.activated).toBe(true)
  expect(s.via).toBe('tailscale')
  expect(s.userAgent).toBe('Mozilla/5.0')
  expect(s.connectedAt).toBeGreaterThan(0)
})

test('isExpired returns false after activation even when expiresAt has passed', () => {
  activateSession('Mozilla/5.0', 'lan')
  getSession().expiresAt = Date.now() - 1
  expect(isExpired()).toBe(false)
})

test('resetSession generates a new token', () => {
  const first = getSession().token
  resetSession()
  const second = getSession().token
  expect(second).not.toBe(first)
  expect(second).toMatch(/^[0-9a-f]{32}$/)
})

test('resetSession clears activated state', () => {
  activateSession('ua', 'lan')
  resetSession()
  expect(getSession().activated).toBe(false)
})
