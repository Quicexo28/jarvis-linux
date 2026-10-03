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
 * MagicDNS name of this machine (`main-jarvis.tail361fcb.ts.net`), or null.
 * Hace falta cuando el destino tiene un certificado de `tailscale cert`: ese
 * cert solo vale para el nombre, asi que entrar por la IP da aviso de
 * seguridad aunque la conexion sea la misma.
 */
export function getTailscaleHostname() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const dns = JSON.parse(stdout)?.Self?.DNSName
        resolve(dns ? dns.replace(/\.$/, '') : null)
      } catch {
        resolve(null)
      }
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
      resolve(parseServeUrl(stdout, port))
    })
  })
}

/**
 * Pick the serve URL whose OWN block proxies to our port. `serve status`
 * lists one block per published URL; with several (e.g. Vaultwarden on :443
 * and Jarvis on :8443) the first URL in the output is not necessarily ours.
 */
export function parseServeUrl(stdout, port) {
  let current = null
  for (const line of stdout.split('\n')) {
    const head = line.match(/^(https:\/\/[^\s/]+)/)
    if (head) { current = head[1]; continue }
    if (current && new RegExp(`proxy\\s+https?://[^\\s/]+:${port}\\b`).test(line)) return current
  }
  return null
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
