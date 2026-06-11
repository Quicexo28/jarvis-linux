import { useState, useEffect } from 'react'
import { useBootStore } from './state/bootStore'
import { DormantLayer } from './components/DormantLayer'
import { RadialTransition } from './components/RadialTransition'
import { AwakeApp } from './AwakeApp'
import { PipLayer } from './components/PipLayer'
import { MobileClient } from './modes/MobileClient'
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
  const bootState = useBootStore((s) => s.bootState)
  const [transitionDone, setTransitionDone] = useState(false)
  const [awakeVisible, setAwakeVisible]     = useState(false)
  const [mobileState, setMobileState]       = useState<MobileState>(
    hasMobileSignal() ? 'checking' : 'desktop'
  )

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
        const url = new URL(window.location.href)
        url.searchParams.delete('token')
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

  if (mobileState === 'mobile') return <MobileClient />

  if (mobileState === 'expired') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#050510', color: '#ccd6f6', fontFamily: 'monospace', gap: 12 }}>
        <div style={{ color: '#ff6b6b', fontSize: 14 }}>QR expirado</div>
        <div style={{ fontSize: 11, opacity: 0.6 }}>Pide al PC que genere un nuevo codigo QR.</div>
      </div>
    )
  }

  return (
    <>
      <DormantLayer />
      {bootState === 'PIP' && <PipLayer />}
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
