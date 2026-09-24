/**
 * Rendered inside the Tauri "ptt-overlay" window.
 *
 * Just hosts the shared <WaveEqualizer/> (2D canvas, no WebGL) filling the
 * transparent always-on-top window. Window placement is done by Rust.
 *
 * La ventana se crea OCULTA en el arranque (lib.rs) y Rust la muestra sólo
 * mientras dura el PTT. El micro se abre únicamente cuando la ventana es
 * visible: este webview es un PROCESO distinto del principal, así que un
 * getUserMedia aquí durante el boot corría contra el que abre la ventana
 * principal y el cliente PipeWire de WebKitGTK moría con SIGSEGV (~1 s tras
 * arrancar; el WebProcess muerto hace exit(101) y systemd reinicia todo).
 */
import { useEffect, useState } from 'react'
import { WaveEqualizer } from './components/WaveEqualizer'

export function PttOverlayPage() {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')

  useEffect(() => {
    document.body.style.background            = 'transparent'
    document.body.style.margin                = '0'
    document.body.style.overflow              = 'hidden'
    document.documentElement.style.background = 'transparent'

    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  return (
    <WaveEqualizer
      label="Escuchando"
      reactive={visible}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
      }}
    />
  )
}
