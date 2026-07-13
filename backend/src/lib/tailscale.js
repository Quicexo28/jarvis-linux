import { execFile } from 'child_process'
import os from 'os'

export function getTailscaleIp() {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null)
      const ip = stdout.trim().split('\n')[0]
      resolve(ip || null)
    })
  })
}

/**
 * HTTPS URL published by `tailscale serve` for this backend port, or null.
 * Only trusted when the serve config actually proxies our port — a stale
 * serve entry for another service must not hijack the QR URL.
 */
export function getTailscaleServeUrl(port = process.env.PORT ?? '8788') {
  return new Promise((resolve) => {
    execFile('tailscale', ['serve', 'status'], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const m = stdout.match(/https:\/\/[^\s/]+/)
      if (m && stdout.includes(`:${port}`)) return resolve(m[0])
      resolve(null)
    })
  })
}

export function getLanIp() {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}
