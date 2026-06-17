import { useState, useEffect, useRef, useCallback } from 'react'
import { request, getApiBase } from '../api/client'
import type { SystemTelemetry } from '../types'
import { MobileGestureCamera } from './MobileGestureCamera'

type ChatMessage = { id: number; role: 'user' | 'jarvis'; text: string }
export type VoiceState = 'idle' | 'recording' | 'processing'

export const NAV_VIEWS = ['home', 'house', 'system', 'cloud', 'plan2d', 'plan3d'] as const
export type NavView = typeof NAV_VIEWS[number]

export const QUICK_ACTIONS = [
  { emoji: '💡', label: 'Sala ON',  entity: 'sala', action: 'on'  },
  { emoji: '💡', label: 'Sala OFF', entity: 'sala', action: 'off' },
  { emoji: '📺', label: 'TV ON',    entity: 'tv',   action: 'on'  },
  { emoji: '📺', label: 'TV OFF',   entity: 'tv',   action: 'off' },
  { emoji: '❄️', label: 'AC ON',    entity: 'ac',   action: 'on'  },
  { emoji: '❄️', label: 'AC OFF',   entity: 'ac',   action: 'off' },
]

const BASE: React.CSSProperties = {
  background: 'transparent', border: '1px solid #ffffff22', borderRadius: 3,
  color: '#ccd6f6', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace',
}

const S: Record<string, React.CSSProperties> = {
  root:         { display: 'flex', flexDirection: 'column', height: '100dvh', background: '#050510', color: '#ccd6f6', fontFamily: 'monospace', fontSize: 12, overflowY: 'auto' },
  header:       { position: 'sticky', top: 0, zIndex: 10, background: '#0a0a1a', borderBottom: '1px solid #00e5ff33', padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  section:      { padding: '12px 16px', borderBottom: '1px solid #ffffff11' },
  label:        { fontSize: 9, letterSpacing: '2px', color: '#00e5ff', opacity: 0.7, marginBottom: 8 },
  inputRow:     { display: 'flex', gap: 8, marginTop: 8 },
  textInput:    { flex: 1, background: 'transparent', border: '1px solid #ffffff33', borderRadius: 3, padding: '6px 10px', color: '#ccd6f6', fontSize: 12, fontFamily: 'monospace' },
  btn:          { ...BASE, border: '1px solid #00e5ff66', color: '#00e5ff', padding: '6px 12px' },
  grid:         { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  actionBtn:    { ...BASE, padding: '14px 6px', fontSize: 13, minHeight: 56, width: '100%', textAlign: 'center' as const },
  navGrid:      { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 8 },
  navBtn:       { ...BASE, padding: '10px 4px', minHeight: 44, width: '100%', textAlign: 'center' as const },
  navBtnActive: { ...BASE, background: '#00e5ff18', border: '1px solid #00e5ff66', color: '#00e5ff', padding: '10px 4px', minHeight: 44, width: '100%', textAlign: 'center' as const },
  ringRow:      { display: 'flex', gap: 8, justifyContent: 'center', marginTop: 6 },
  ringBtn:      { ...BASE, border: '1px solid #ffffff33', padding: '10px 24px', fontSize: 13, minHeight: 44 },
  pttWrap:      { display: 'flex', justifyContent: 'center', padding: '12px 0 4px' },
}

const PTT_BASE: React.CSSProperties = {
  width: 72, height: 72, borderRadius: '50%', border: '2px solid',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'monospace', fontSize: 11, letterSpacing: '1px',
  transition: 'all 0.15s', cursor: 'pointer', userSelect: 'none' as const,
}

function pttStyle(state: VoiceState): React.CSSProperties {
  if (state === 'recording') return { ...PTT_BASE, background: '#00e5ff33', borderColor: '#00e5ff', color: '#00e5ff', animation: 'jarvis-pulse 1s infinite' }
  if (state === 'processing') return { ...PTT_BASE, background: '#ffffff0a', borderColor: '#ffffff33', color: '#ccd6f6', cursor: 'default' }
  return { ...PTT_BASE, background: '#00e5ff22', borderColor: '#00e5ff66', color: '#00e5ff' }
}

function bubble(role: string): React.CSSProperties {
  return {
    background:   role === 'jarvis' ? '#00e5ff18' : '#ffffff14',
    border:       role === 'jarvis' ? '1px solid #00e5ff33' : 'none',
    borderRadius: 4, padding: '6px 10px', marginBottom: 6,
    alignSelf:    role === 'jarvis' ? 'flex-start' : 'flex-end',
    maxWidth:     '85%', lineHeight: 1.5,
  }
}

let msgIdCounter = 0

export function MobileClient() {
  const [messages, setMessages]         = useState<ChatMessage[]>([])
  const [input, setInput]               = useState('')
  const [sending, setSending]           = useState(false)
  const [online, setOnline]             = useState<boolean | null>(null)
  const [telemetry, setTelemetry]       = useState<SystemTelemetry | null>(null)
  const [voiceState, setVoiceState]     = useState<VoiceState>('idle')
  const [currentView, setCurrentView]   = useState<string | null>(null)
  const [disabledKeys, setDisabledKeys] = useState<Set<string>>(new Set())
  const recognitionRef                  = useRef<any>(null)

  const pushMsg = (role: ChatMessage['role'], text: string) =>
    setMessages((prev) => [...prev.slice(-9), { id: ++msgIdCounter, role, text }])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return
    pushMsg('user', text)
    setInput('')
    setSending(true)
    try {
      const res = await request<{ ok: boolean; reply: string }>('/api/jarvis/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, context: { source: 'mobile' } }),
      })
      pushMsg('jarvis', res.reply ?? '...')
    } catch {
      pushMsg('jarvis', 'Sin respuesta del servidor.')
    } finally {
      setSending(false)
    }
  }, [])

  const handleAction = useCallback(async (entity: string, action: string, label: string) => {
    const key = `${entity}:${action}`
    setDisabledKeys(prev => new Set([...prev, key]))
    setTimeout(() => setDisabledKeys(prev => { const s = new Set(prev); s.delete(key); return s }), 500)
    try {
      await request('/api/jarvis/device-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity, action }),
      })
      pushMsg('jarvis', `${label} ejecutado.`)
    } catch {
      pushMsg('jarvis', `Error al ejecutar ${label}.`)
    }
  }, [])

  const handleViewOpen = useCallback(async (view: string) => {
    try {
      await request('/api/skills/view/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ view }),
      })
      setCurrentView(view)
    } catch {}
  }, [])

  const handleRingRotate = useCallback(async (direction: 'left' | 'right') => {
    try {
      await request('/api/skills/ring/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, steps: 1 }),
      })
    } catch {}
  }, [])

  const startVoice = useCallback(() => {
    const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition
    if (!SR) { pushMsg('jarvis', 'Micrófono no disponible.'); return }
    recognitionRef.current?.stop()
    const rec = new SR()
    rec.lang = 'es-CO'
    let gotResult = false
    rec.onresult = (e: any) => {
      gotResult = true
      const transcript = e.results[0][0].transcript
      setVoiceState('processing')
      sendMessage(transcript).finally(() => setVoiceState('idle'))
    }
    rec.onerror = () => { setVoiceState('idle'); pushMsg('jarvis', 'Micrófono no disponible.') }
    rec.onend   = () => { if (!gotResult) setVoiceState('idle') }
    rec.start()
    setVoiceState('recording')
    recognitionRef.current = rec
  }, [sendMessage])

  const stopVoice = useCallback(() => { recognitionRef.current?.stop() }, [])

  useEffect(() => () => { recognitionRef.current?.stop() }, [])

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const res = await request<SystemTelemetry>('/api/system/telemetry')
        if (!cancelled) setTelemetry(res)
      } catch {}
    }
    pull()
    const t = setInterval(pull, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch(`${getApiBase()}/health`)
        if (!cancelled) setOnline(res.ok)
      } catch {
        if (!cancelled) setOnline(false)
      }
    }
    check()
    const t = setInterval(check, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await request<{ ok: boolean; result?: { view?: string } }>('/api/skills/view/current')
        if (!cancelled && res.result?.view) setCurrentView(res.result.view)
      } catch {}
    }
    poll()
    const t = setInterval(poll, 5_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const dotColor = online === null ? '#888' : online ? '#64ffda' : '#ff6b6b'
  const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: '50%', background: dotColor, boxShadow: `0 0 6px ${dotColor}` }

  return (
    <div style={S.root}>
      <style>{`@keyframes jarvis-pulse{0%,100%{box-shadow:0 0 0 0 #00e5ff44}50%{box-shadow:0 0 0 10px #00e5ff00}}`}</style>

      <div style={S.header}>
        <span style={{ fontSize: 10, letterSpacing: '2px', color: '#00e5ff' }}>JARVIS</span>
        <div style={dot} />
      </div>

      {/* Navegación */}
      <div style={S.section}>
        <div style={S.label}>
          NAVEGACIÓN{currentView && <span style={{ color: '#ccd6f6', opacity: 0.5, fontStyle: 'normal' }}> — {currentView}</span>}
        </div>
        <div style={S.navGrid}>
          {NAV_VIEWS.map((v) => (
            <button key={v} style={currentView === v ? S.navBtnActive : S.navBtn} onClick={() => handleViewOpen(v)}>
              {v}
            </button>
          ))}
        </div>
        <div style={S.ringRow}>
          <button style={S.ringBtn} onClick={() => handleRingRotate('left')}>← PREV</button>
          <button style={S.ringBtn} onClick={() => handleRingRotate('right')}>NEXT →</button>
        </div>
      </div>

      {/* Chat */}
      <div style={S.section}>
        <div style={S.label}>CHAT</div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 80 }}>
          {messages.length === 0 && <div style={{ opacity: 0.4, fontSize: 11 }}>Hola. ¿Qué necesitas?</div>}
          {messages.map((m) => <div key={m.id} style={bubble(m.role)}>{m.text}</div>)}
        </div>
        <div style={S.pttWrap}>
          <button
            style={pttStyle(voiceState)}
            onPointerDown={voiceState === 'idle' ? startVoice : undefined}
            onPointerUp={voiceState === 'recording' ? stopVoice : undefined}
            disabled={voiceState === 'processing'}
          >
            {voiceState === 'recording' ? 'ESC...' : voiceState === 'processing' ? '...' : 'MIC'}
          </button>
        </div>
        <div style={S.inputRow}>
          <input
            style={S.textInput}
            value={input}
            placeholder="Escribe a Jarvis..."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !sending) sendMessage(input) }}
          />
          <button style={S.btn} onClick={() => sendMessage(input)} disabled={sending}>
            {sending ? '...' : 'ok'}
          </button>
        </div>
      </div>

      {/* Acciones rápidas */}
      <div style={S.section}>
        <div style={S.label}>ACCIONES RÁPIDAS</div>
        <div style={S.grid}>
          {QUICK_ACTIONS.map((a) => {
            const key = `${a.entity}:${a.action}`
            const disabled = disabledKeys.has(key)
            return (
              <button
                key={a.label}
                style={{ ...S.actionBtn, opacity: disabled ? 0.5 : 1 }}
                onClick={() => handleAction(a.entity, a.action, a.label)}
                disabled={disabled}
              >
                {a.emoji} {a.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Cámara gestos */}
      <MobileGestureCamera />

      {/* Sistema */}
      <div style={S.section}>
        <div style={S.label}>SISTEMA</div>
        {online === false ? (
          <div style={{ opacity: 0.4 }}>Sin conexión — reintentando...</div>
        ) : telemetry ? (
          <div style={{ display: 'flex', gap: 16, opacity: 0.7 }}>
            <span>CPU {(telemetry.host?.cpu?.usagePct ?? 0).toFixed(0)}%</span>
            <span>RAM {(telemetry.host?.memory?.usedGB ?? 0).toFixed(1)}/{(telemetry.host?.memory?.totalGB ?? 0).toFixed(0)} GB</span>
            <span>GPU {(telemetry.host?.gpu?.avgUtilizationPct ?? 0).toFixed(0)}%</span>
          </div>
        ) : (
          <div style={{ opacity: 0.4 }}>Cargando...</div>
        )}
      </div>
    </div>
  )
}
