import { useEffect, useRef } from 'react'
import { useClapDetection } from '../hooks/useClapDetection'
import { useBootStore } from '../state/bootStore'
import { getApiBase } from '../api/client'
import { tauriInvoke } from '../platform/tauri'

const RECONNECT_DELAY_MS = 3000


export function DormantLayer() {
  const bootState = useBootStore((s) => s.bootState)
  const setBootState = useBootStore((s) => s.setBootState)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useClapDetection({
    enabled: bootState === 'DORMANT',
    // Despierta desde CUALQUIER workspace: un wake word que sólo funciona si ya
    // estás mirando la pantalla de Jarvis no sirve de nada. Antes esto llamaba a
    // `show_if_workspace(1)`, que devolvía false en cualquier otro workspace y
    // dejaba el aplauso detectado sin efecto visible (parecía fallo del detector).
    onDoubleClap: () => {
      tauriInvoke('focus_window')
        .then(() => setBootState('AWAKE'))
        .catch((err) => console.warn('[clap] focus_window falló', err))
    },
  })

  // Keep a persistent WS connection to the backend wake bus. When the backend
  // broadcasts a wake signal (triggered by the Hyprland Super+J keybind calling
  // POST /api/skills/system/wake), show the Tauri window and transition to AWAKE.
  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false

    function connect() {
      if (stopped) return
      ws = new WebSocket(`${getApiBase().replace(/^http/, 'ws')}/api/jarvis/wake-bus`)

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'wake') {
            tauriInvoke('focus_window').catch(() => {})
            setBootState('AWAKE')
          }
        } catch {}
      }

      ws.onclose = () => {
        if (!stopped) {
          timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS)
        }
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      stopped = true
      if (timerRef.current) clearTimeout(timerRef.current)
      ws?.close()
    }
  }, [setBootState])

  return null
}
