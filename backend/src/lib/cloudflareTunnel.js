import { spawn } from 'child_process'

let tunnelUrl = null
let child = null

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export function startCloudflareTunnel(port) {
  if (child) return
  try {
    child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return // cloudflared not installed — silent
  }

  function onData(chunk) {
    const text = chunk.toString()
    const match = text.match(URL_RE)
    if (match && !tunnelUrl) {
      tunnelUrl = match[0]
      console.log('[cloudflare] tunnel ready:', tunnelUrl)
    }
  }

  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  child.on('exit', (code) => {
    console.log('[cloudflare] process exited:', code)
    tunnelUrl = null
    child = null
  })

  child.on('error', () => {
    // cloudflared not found or not executable
    tunnelUrl = null
    child = null
  })
}

export function getTunnelUrl() {
  return tunnelUrl
}

export function stopCloudflareTunnel() {
  child?.kill()
  child = null
  tunnelUrl = null
}
