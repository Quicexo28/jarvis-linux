import { useClapDetection } from '../hooks/useClapDetection'
import { useBootStore } from '../state/bootStore'

export function DormantLayer() {
  const bootState = useBootStore((s) => s.bootState)
  const setBootState = useBootStore((s) => s.setBootState)

  useClapDetection({
    enabled: bootState === 'DORMANT',
    onDoubleClap: () => setBootState('AWAKE'),
  })

  return null
}
