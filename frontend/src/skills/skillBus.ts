/**
 * Skill bus client (renderer side).
 *
 * Connects to the backend WS /api/skills/bus while AWAKE. The backend pushes
 * primitive commands { id, verb, payload }; we run the matching primitive and
 * reply { id, ok, result } | { id, ok: false, error }.
 *
 * Auto-reconnecting, mirroring the resilient pattern in audio/localStt.ts.
 */

import { getApiBase } from '../api/client'
import { runPrimitive } from './primitives'

export interface SkillBusSession {
  stop: () => void
  isConnected: () => boolean
}

interface BusCommand {
  id: string
  verb: string
  payload?: unknown
}

/**
 * Open the skill bus. Returns a handle with stop() to close it.
 */
export function startSkillBus(): SkillBusSession {
  const wsUrl = `${getApiBase().replace(/^http/, 'ws')}/api/skills/bus`
  let active = true
  let ws: WebSocket | null = null
  let open = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoffMs = 500

  function connect() {
    if (!active) return
    open = false
    const sock = new WebSocket(wsUrl)
    ws = sock

    sock.onopen = () => {
      console.log('[skill-bus] connected ->', wsUrl)
      open = true
      backoffMs = 500
    }

    sock.onmessage = async (evt) => {
      let cmd: BusCommand
      try { cmd = JSON.parse(evt.data) } catch { return }
      if (!cmd || !cmd.id || !cmd.verb) return
      try {
        const result = await runPrimitive(cmd.verb, cmd.payload)
        reply({ id: cmd.id, ok: true, result })
      } catch (e) {
        reply({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }

    sock.onerror = (e) => console.warn('[skill-bus] error', e)

    sock.onclose = (e) => {
      open = false
      if (!active) return
      console.log(`[skill-bus] closed ${e.code} — reconnect in ${backoffMs}ms`)
      reconnectTimer = setTimeout(connect, backoffMs)
      backoffMs = Math.min(backoffMs * 2, 5000)
    }
  }

  function reply(msg: { id: string; ok: boolean; result?: unknown; error?: string }) {
    if (open && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  connect()

  return {
    stop() {
      if (!active) return
      active = false
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      try { ws?.close() } catch { /* ignore */ }
    },
    isConnected: () => open,
  }
}
