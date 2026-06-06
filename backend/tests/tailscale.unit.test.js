import { test, expect } from 'vitest'
import { getLanIp } from '../src/lib/tailscale.js'

test('getLanIp returns a non-loopback IPv4 address', () => {
  const ip = getLanIp()
  expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)
  expect(ip).not.toBe('127.0.0.1')
})
