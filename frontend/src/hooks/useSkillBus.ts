/**
 * React hook for the skill bus — keeps a WS connection to the backend open while
 * mounted so self-built skills can drive renderer primitives (camera, etc.).
 *
 * Mounted by AwakeApp, which only renders while AWAKE, so the bus is live
 * exactly when the renderer's camera/permissions are available.
 */

import { useEffect, useRef, useState } from 'react'
import { startSkillBus, type SkillBusSession } from '../skills/skillBus'

export interface UseSkillBusResult {
  connected: boolean
}

export function useSkillBus(enabled = true): UseSkillBusResult {
  const [connected, setConnected] = useState(false)
  const sessionRef = useRef<SkillBusSession | null>(null)

  useEffect(() => {
    if (!enabled) return
    const session = startSkillBus()
    sessionRef.current = session
    const poll = setInterval(() => setConnected(session.isConnected()), 1000)
    return () => {
      clearInterval(poll)
      session.stop()
      sessionRef.current = null
      setConnected(false)
    }
  }, [enabled])

  return { connected }
}
