import { useEffect, useState } from 'react'
import { apiFetch } from '../api/client'
import type { SystemTelemetry } from '../types'

/**
 * Telemetría del host. `enabled` lo manda el backend (JARVIS_TELEMETRY_ENABLED);
 * solo se consulta mientras `active` (panel System abierto), cada 2 s.
 */
export function useSystemTelemetry(active: boolean) {
  const [enabled, setEnabled] = useState(false)
  const [data, setData] = useState<SystemTelemetry | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/system/config`)
      .then(r => r.json() as Promise<{ telemetryEnabled?: boolean }>)
      .then(c => { if (!cancelled) setEnabled(Boolean(c.telemetryEnabled)) })
      .catch(() => { /* backend caído: queda apagada */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!enabled || !active) return
    let cancelled = false
    const pull = async () => {
      try {
        const res = await apiFetch(`/api/system/telemetry`)
        const json = await res.json() as SystemTelemetry
        if (!cancelled) setData(json)
      } catch { /* se conserva el último dato */ }
    }
    pull()
    const timer = setInterval(pull, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [enabled, active])

  return { enabled, data }
}
