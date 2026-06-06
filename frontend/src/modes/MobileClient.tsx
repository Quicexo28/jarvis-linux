import { useState, useEffect, useRef, useCallback } from 'react'
import { request, getApiBase } from '../api/client'
import type { SystemTelemetry } from '../types'

type ChatMessage = { id: number; role: 'user' | 'jarvis'; text: string }

const QUICK_ACTIONS = [
  { label: 'Sala ON',  entity: 'sala', action: 'on'  },
  { label: 'Sala OFF', entity: 'sala', action: 'off' },
  { label: 'TV ON',    entity: 'tv',   action: 'on'  },
  { label: 'TV OFF',   entity: 'tv',   action: 'off' },
  { label: 'AC ON',    entity: 'ac',   action: 'on'  },
  { label: 'AC OFF',   entity: 'ac',   action: 'off' },
]

const S: Record<string, React.CSSProperties> = {
  root:      { display: 'flex', flexDirection: 'column', height: '100dvh', background: '#050510', color: '#ccd6f6', fontFamily: 'monospace', fontSize: 12, overflowY: 'auto' },
  header:    { position: 'sticky', top: 0, zIndex: 10, background: '#0a0a1a', borderBottom: '1px solid #00e5ff33', padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  section:   { padding: '12px 16px', borderBottom: '1px solid #ffffff11' },
  label:     { fontSize: 9, letterSpacing: '2px', color: '#00e5ff', opacity: 0.7, marginBottom: 8 },
  inputRow:  { display: 'flex', gap: 8, marginTop: 8 },
  textInput: { flex: 1, background: 'transparent', border: '1px solid #ffffff33', borderRadius: 3, padding: '6px 10px', color: '#ccd6f6', fontSize: 12, fontFamily: 'monospace' },
  btn:       { background: 'transparent', border: '1px solid #00e5ff66', borderRadius: 3, color: '#00e5ff', padding: '6px 12px', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace' },
  grid:      { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  actionBtn: { background: 'transparent', border: '1px solid #ffffff22', borderRadius: 3, padding: '10px 6px', color: '#ccd6f6', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace' },
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
  const [messages, setMessages]   = useState<ChatMessage[]>([])
  const [input, setInput]         = useState('')
  const [sending, setSending]     = useState(false)
  const [online, setOnline]       = useState<boolean | null>(null)
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null)
  const recognitionRef            = useRef<any>(null)

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

  const startVoice = useCallback(() => {
    const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition
    if (!SR) { pushMsg('jarvis', 'Micrófono no disponible.'); return }
    recognitionRef.current?.stop()
    const rec = new SR()
    rec.lang = 'es-CO'
    rec.onresult = (e: any) => sendMessage(e.results[0][0].transcript)
    rec.onerror  = () => pushMsg('jarvis', 'Micrófono no disponible.')
    rec.start()
    recognitionRef.current = rec
  }, [sendMessage])

  // Cleanup voice recognition on unmount
  useEffect(() => () => { recognitionRef.current?.stop() }, [])

  // Poll telemetry every 30s
  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const res = await request<SystemTelemetry>('/api/system/telemetry')
        if (!cancelled) setTelemetry(res)
      } catch {}
    }
    pull()
    const timer = setInterval(pull, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  // Heartbeat every 15s for connection indicator
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
    const timer = setInterval(check, 15_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const dotColor = online === null ? '#888' : online ? '#64ffda' : '#ff6b6b'
  const dot: React.CSSProperties = { width: 8, height: 8, borderRadius: '50%', background: dotColor, boxShadow: `0 0 6px ${dotColor}` }

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={{ fontSize: 10, letterSpacing: '2px', color: '#00e5ff' }}>JARVIS</span>
        <div style={dot} />
      </div>

      {/* Jarvis chat */}
      <div style={S.section}>
        <div style={S.label}>CHAT</div>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 80 }}>
          {messages.length === 0 && <div style={{ opacity: 0.4, fontSize: 11 }}>Hola. ¿Qué necesitas?</div>}
          {messages.map((m) => <div key={m.id} style={bubble(m.role)}>{m.text}</div>)}
        </div>
        <div style={S.inputRow}>
          <input
            style={S.textInput}
            value={input}
            placeholder="Escribe a Jarvis..."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !sending) sendMessage(input) }}
          />
          <button style={S.btn} onClick={startVoice}>mic</button>
          <button style={S.btn} onClick={() => sendMessage(input)} disabled={sending}>
            {sending ? '...' : 'ok'}
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div style={S.section}>
        <div style={S.label}>ACCIONES RAPIDAS</div>
        <div style={S.grid}>
          {QUICK_ACTIONS.map((a) => (
            <button key={a.label} style={S.actionBtn} onClick={() => handleAction(a.entity, a.action, a.label)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {/* System stats */}
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
