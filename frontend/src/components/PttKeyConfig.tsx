/**
 * PttKeyConfig — System-panel control to customize the push-to-talk combo.
 *
 * Click "Cambiar" and press the desired combination; it must include at least
 * one modifier (Ctrl/Alt/Shift/Super) because PTT mirrors a system-wide
 * shortcut — a bare key would fire while typing. Stored in jarvisStore
 * (`jarvis.ptt.key.v1`) as 'Ctrl+Alt+KeyV'. The global Hyprland bind is
 * separate (hyprland-jarvis.conf); keep both on the same combo.
 */

import { useEffect, useState } from 'react'
import { useJarvisStore } from '../state/jarvisStore'
import { HudBtn } from './HudBtn'

function prettyPart(part: string): string {
  if (part === 'Space') return 'Espacio'
  if (part.startsWith('Key')) return part.slice(3)
  if (part.startsWith('Digit')) return part.slice(5)
  if (part === 'Meta' || part === 'Super') return 'Super'
  return part
}

export function prettyCombo(spec: string): string {
  return spec.split('+').map(prettyPart).join('+')
}

export function PttKeyConfig() {
  const pttEnabled = useJarvisStore((s) => s.pttEnabled)
  const setPttEnabled = useJarvisStore((s) => s.setPttEnabled)
  const pttKey = useJarvisStore((s) => s.pttKey)
  const setPttKey = useJarvisStore((s) => s.setPttKey)
  const [capturing, setCapturing] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(false)
        setHint('')
        return
      }
      // Wait for a non-modifier key — modifiers alone don't end the capture.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
      const mods = [
        e.ctrlKey ? 'Ctrl' : '',
        e.altKey ? 'Alt' : '',
        e.shiftKey ? 'Shift' : '',
        e.metaKey ? 'Super' : '',
      ].filter(Boolean)
      if (!mods.length) {
        setHint('Debe incluir Ctrl, Alt, Shift o Super')
        return
      }
      setPttKey([...mods, e.code].join('+'))
      setCapturing(false)
      setHint('')
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, setPttKey])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '6px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-stat" style={{ flex: 1 }}>
          Push-to-talk · {capturing ? 'Pulsa la combinación…' : prettyCombo(pttKey)}
        </span>
        <HudBtn active={pttEnabled} onClick={() => setPttEnabled(!pttEnabled)}>
          {pttEnabled ? 'On' : 'Off'}
        </HudBtn>
        <HudBtn active={capturing} onClick={() => { setCapturing(!capturing); setHint('') }}>
          {capturing ? 'Cancelar' : 'Cambiar'}
        </HudBtn>
      </div>
      {(hint || capturing) && (
        <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
          {hint || 'Esc para cancelar. Debe incluir un modificador (Ctrl/Alt/Shift/Super).'}
        </div>
      )}
      <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>
        El atajo global (fuera de la app) se define en hyprland-jarvis.conf — mantenlos iguales.
      </div>
    </div>
  )
}
