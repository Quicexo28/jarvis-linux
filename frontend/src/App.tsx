import { useState, useEffect } from 'react'
import { isTauri, tauriInvoke, tauriListen, getWindowLabel } from './platform/tauri'
import { useBootStore } from './state/bootStore'
import { useJarvisStore } from './state/jarvisStore'
import { PttOverlayPage } from './PttOverlayPage'
import { WallPage } from './WallPage'

// Detect if this JS context is running inside the PTT overlay Tauri window.
const IS_OVERLAY = getWindowLabel() === 'ptt-overlay'
// Ventana de la pared: solo el visor 3D sobre el proyector.
// Se mira TAMBIEN la URL y no solo el label: el label depende de que Tauri lo
// resuelva antes de que corra el bundle, y si falla esta ventana renderiza la
// app entera en vez del visor — que es justo el sintoma (ventana visible desde
// el arranque, sin grafico).
const IS_WALL = getWindowLabel() === 'wall' ||
  new URLSearchParams(window.location.search).get('window') === 'wall'
console.log('[boot] label=', getWindowLabel(), 'search=', window.location.search, 'IS_WALL=', IS_WALL)
import { DormantLayer } from './components/DormantLayer'
import { RadialTransition } from './components/RadialTransition'
import { AwakeApp } from './AwakeApp'
import { MobileClient } from './modes/MobileClient'
import { isNativeApp, openNativeSettings } from './modes/remote/native'
import {
  getApiBase,
  setApiBase,
  setMobileToken,
  getMobileToken,
  clearMobileToken,
  clearApiBase,
} from './api/client'
import './App.css'

type MobileState = 'checking' | 'mobile' | 'expired' | 'desktop'

function hasMobileSignal(): boolean {
  const urlToken = new URLSearchParams(window.location.search).get('token')
  return !!(urlToken || localStorage.getItem('jarvis.mobile.token'))
}

export default function App() {
  // Render the standalone overlay page when running in the ptt-overlay Tauri window
  if (IS_OVERLAY) return <PttOverlayPage />
  if (IS_WALL) return <WallPage />

  const bootState = useBootStore((s) => s.bootState)
  const setBootState = useBootStore((s) => s.setBootState)
  const setPttActive = useJarvisStore((s) => s.setPttActive)
  const pttActive    = useJarvisStore((s) => s.pttActive)
  const [transitionDone, setTransitionDone] = useState(false)
  const [awakeVisible, setAwakeVisible]     = useState(false)
  const [mobileState, setMobileState]       = useState<MobileState>(
    hasMobileSignal() ? 'checking' : 'desktop'
  )
  // Modo web completo: ?ui=full en la URL del token persiste la GUI de
  // escritorio (AwakeApp) para este navegador remoto; ?ui=mobile la revierte.
  const [fullUi, setFullUi] = useState(() => localStorage.getItem('jarvis.ui.mode') === 'full')

  useEffect(() => {
    if (mobileState !== 'checking') return
    async function detect() {
      const urlToken    = new URLSearchParams(window.location.search).get('token')
      const storedToken = getMobileToken()
      const tokenToTry  = urlToken ?? storedToken
      if (!tokenToTry) { setMobileState('desktop'); return }

      if (urlToken) {
        setApiBase(window.location.origin)
        setMobileToken(urlToken)
        const uiParam = new URLSearchParams(window.location.search).get('ui')
        if (uiParam === 'full') {
          localStorage.setItem('jarvis.ui.mode', 'full')
          setFullUi(true)
        } else if (uiParam === 'mobile') {
          localStorage.removeItem('jarvis.ui.mode')
          setFullUi(false)
        }
        const url = new URL(window.location.href)
        url.searchParams.delete('token')
        url.searchParams.delete('ui')
        window.history.replaceState({}, '', url.toString())
      }

      try {
        const res = await fetch(`${getApiBase()}/api/mobile/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tokenToTry }),
        })
        if (res.ok) {
          setMobileState('mobile')
        } else {
          clearMobileToken()
          clearApiBase()
          setMobileState(urlToken ? 'expired' : 'desktop')
        }
      } catch {
        clearMobileToken()
        clearApiBase()
        setMobileState('desktop')
      }
    }
    detect()
  }, [mobileState])

  // Super+J global shortcut from Tauri wakes from DORMANT.
  // Two paths: Tauri event IPC and direct eval() fallback via window.__jarvisWake.
  useEffect(() => {
    const unlisten = tauriListen('jarvis:wake', () => setBootState('AWAKE'))
    ;(window as any).__jarvisWake = () => setBootState('AWAKE')
    return () => {
      unlisten.then(fn => fn())
      delete (window as any).__jarvisWake
    }
  }, [setBootState])

  // Super+W / killactive → Rust intercepts close, hides window, emits jarvis:sleep
  useEffect(() => {
    const unlisten = tauriListen('jarvis:sleep', () => setBootState('DORMANT'))
    return () => { unlisten.then(fn => fn()) }
  }, [setBootState])

  // Modo web completo remoto: sin Super+J ni clap con que despertar — arranca
  // directo en AWAKE una vez autenticado.
  useEffect(() => {
    if (!isTauri() && mobileState === 'mobile' && fullUi) setBootState('AWAKE')
  }, [mobileState, fullUi, setBootState])

  // PTT bus: the NitroSense key (Hyprland code:425 → POST /api/skills/voice/ptt-start|stop)
  // broadcasts ptt_start/ptt_stop here. Persistent WS with reconnect, mirroring the
  // wake-bus in DormantLayer. Drives pttActive → STT gate + ptt-overlay window.
  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      if (stopped) return
      ws = new WebSocket(`${getApiBase().replace(/^http/, 'ws')}/api/jarvis/ptt-bus`)
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'ptt_start') setPttActive(true)
          else if (msg.type === 'ptt_stop') setPttActive(false)
        } catch {}
      }
      ws.onclose = () => { if (!stopped) timer = setTimeout(connect, 3000) }
      ws.onerror = () => ws?.close()
    }
    connect()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [setPttActive])

  // Show/hide the Tauri ptt-overlay window when the PTT key is held. Lives here
  // (always mounted) — not in AwakeApp — so the overlay works cross-workspace even
  // while DORMANT, when AwakeApp is unmounted.
  useEffect(() => {
    tauriInvoke('set_ptt_overlay', { visible: pttActive }).catch(() => {})
  }, [pttActive])

  // F12 → open Tauri devtools
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F12') tauriInvoke('open_devtools').catch(() => {})
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // When DORMANT, move to special:jarvis workspace (stays visible to WebKit so JS keeps
  // running for wake-bus WS and clap detection, but hidden from the user's screen).
  useEffect(() => {
    if (bootState === 'DORMANT') {
      tauriInvoke('dormant_window').catch(() => {})
    }
  }, [bootState])

  useEffect(() => {
    if (bootState !== 'AWAKE') { setTransitionDone(false); setAwakeVisible(false) }
  }, [bootState])

  useEffect(() => {
    if (bootState !== 'AWAKE' || transitionDone) return
    const t = setTimeout(() => setAwakeVisible(true), 600)
    return () => clearTimeout(t)
  }, [bootState, transitionDone])

  if (mobileState === 'checking') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050510', color: '#00e5ff', fontFamily: 'monospace', fontSize: 12 }}>
        Conectando...
      </div>
    )
  }

  if (mobileState === 'mobile' && !fullUi) return <MobileClient />

  if (mobileState === 'expired') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050510', color: '#ccd6f6', fontFamily: 'monospace', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ color: '#ff6b6b', fontSize: 14 }}>Token no válido</div>
        <div style={{ fontSize: 11, opacity: 0.6, maxWidth: 320, lineHeight: 1.6 }}>
          {isNativeApp()
            ? 'El token guardado no sirve para la GUI (el de ingesta no vale). Pega en Ajustes el enlace del QR del escritorio.'
            : 'Pide al PC que genere un nuevo código QR.'}
        </div>
        {isNativeApp() && (
          <button
            style={{ minHeight: 44, padding: '0 18px', borderRadius: 10, background: 'rgba(0,229,255,0.12)', border: '1px solid rgba(0,229,255,0.45)', color: '#00e5ff', fontFamily: 'inherit', fontSize: 14 }}
            onClick={openNativeSettings}
          >
            Volver a emparejar
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      <DormantLayer />
      {bootState === 'AWAKE' && !transitionDone && (
        <RadialTransition onComplete={() => setTransitionDone(true)} />
      )}
      {bootState === 'AWAKE' && (
        <div style={{ opacity: awakeVisible ? 1 : 0, transition: 'opacity 0.2s ease', position: 'fixed', inset: 0, background: 'radial-gradient(ellipse at 50% 55%, #040d1a 0%, #03080d 55%, #010507 100%)' }}>
          <AwakeApp />
        </div>
      )}
    </>
  )
}
