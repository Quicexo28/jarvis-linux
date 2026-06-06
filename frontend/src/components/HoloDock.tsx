import { useState, useEffect, useCallback } from 'react'
import { useJarvisStore } from '../state/jarvisStore'
import { modeMeta } from '../constants'
import type { Mode } from '../types'
import { GlassPanel } from './GlassPanel'

const DOCK_MODES: Mode[] = ['home', 'house', 'plan2d', 'plan3d', 'space', 'cloud', 'system']

const MODE_ICONS: Record<Mode, string> = {
  home:   '◎',
  house:  '⌂',
  plan2d: '▦',
  plan3d: '⬡',
  space:  '◈',
  cloud:  '☁',
  system: '⚙',
  mobile: '◻',
  utils:  '◐',
  timer:  '⏱',
  chrono: '⏲',
}

export function HoloDock() {
  const mode = useJarvisStore((s) => s.mode)
  const setMode = useJarvisStore((s) => s.setMode)
  const [visible, setVisible] = useState(false)

  const handleMouseMove = useCallback((e: MouseEvent) => {
    setVisible(e.clientY > window.innerHeight - 80)
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [handleMouseMove])

  const hidden = mode === 'space' || !visible

  return (
    <GlassPanel className={`holo-dock ${hidden ? 'hidden' : ''}`}>
      {DOCK_MODES.map((m) => (
        <button
          key={m}
          className={`dock-item ${m === mode ? 'active' : ''}`}
          onClick={() => setMode(m)}
          title={modeMeta[m].label}
        >
          <span className="dock-icon">{MODE_ICONS[m]}</span>
          <span className="dock-label">{modeMeta[m].label}</span>
        </button>
      ))}
    </GlassPanel>
  )
}
