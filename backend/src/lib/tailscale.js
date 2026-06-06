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
