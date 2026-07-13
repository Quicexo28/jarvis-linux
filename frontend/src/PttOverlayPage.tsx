/**
 * Rendered inside the Tauri "ptt-overlay" window.
 *
 * Just hosts the shared <WaveEqualizer/> (2D canvas, no WebGL) filling the
 * transparent always-on-top window. Window placement is done by Rust.
 */
import { useEffect } from 'react'
import { WaveEqualizer } from './components/WaveEqualizer'

export function PttOverlayPage() {
  useEffect(() => {
    document.body.style.background            = 'transparent'
    document.body.style.margin                = '0'
    document.body.style.overflow              = 'hidden'
    document.documentElement.style.background = 'transparent'
  }, [])

  return (
    <WaveEqualizer
      label="Escuchando"
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
      }}
    />
  )
}
