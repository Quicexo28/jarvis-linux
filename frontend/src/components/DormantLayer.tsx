import { useClapDetection } from '../hooks/useClapDetection'
import { getApiBase } from '../api/client'
import { useBootStore } from '../state/bootStore'

export function DormantLayer() {
  const bootState = useBootStore((s) => s.bootState)
  const setBootState = useBootStore((s) => s.setBootState)

  useClapDetection({
    enabled: bootState === 'DORMANT',
    onDoubleClap: () => {
      setBootState('AWAKE')
      // Double clap also counts as a wake: clears VOICE_MUTED on the backend
      // (documented contract — wake word or double clap unmute).
      fetch(`${getApiBase()}/api/jarvis/wake-detected`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confidence: 1, source: 'double_clap' }),
      }).catch(() => {})
    },
  })

  return null
}
