/**
 * Jarvis Remote — the single app for phone and tablet.
 *
 * One shell, six tabs: chat with the brain, a direct PC remote (media,
 * volume, windows, clipboard), the projector keystone (native screen), the machines
 * panel (distributed agents + remote desktop), house control and device/system
 * status. The Android companion loads exactly this page in a WebView, so
 * features live here once and the APK only adds what a WebView cannot do
 * (background reporting, native dictation).
 */
import { useCallback, useEffect, useState } from 'react'
import { S, T, dotStyle } from './theme'
import { ChatTab, type ChatMessage } from './ChatTab'
import { HomeTab } from './HomeTab'
import { PcTab } from './PcTab'
import { StatusTab } from './StatusTab'
import { MandoTab } from './MandoTab'
import { ProyectorTab } from './ProyectorTab'
import { useOnline, useTelemetry, useLocationReporting, usePresenceReporting } from './hooks'
import { sendTurn } from './api'
import { AuthSheet } from './AuthSheet'

type TabId = 'chat' | 'mando' | 'proyector' | 'pc' | 'casa' | 'estado'

// Inline SVG paths, not emoji or box-drawing glyphs: the Android WebView font
// stack renders several of those as tofu boxes.
const TABS: { id: TabId; label: string; icon: string }[] = [
  // Orden = frecuencia de uso desde el móvil: hablar con Jarvis y manejar el
  // PC primero; equipos, casa y estado son consulta ocasional.
  { id: 'chat',   label: 'Jarvis', icon: 'M4 5h16v11H9l-5 4z' },
  { id: 'mando',  label: 'Mando',  icon: 'M6 8h12a4 4 0 0 1 0 8H6a4 4 0 0 1 0-8zM8 11v2M7 12h2M15.5 12h.01M17.5 12h.01' },
  { id: 'proyector', label: 'Proyector',  icon: 'M3 11h18v7H3zM14 14.5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 14.5h5M7 11 5 5M12 11V5M17 11l2-6' },
  { id: 'pc',     label: 'Equipos', icon: 'M3 5h18v11H3zM8 20h8' },
  { id: 'casa',   label: 'Casa',   icon: 'M4 11 12 4l8 7v9H4z' },
  { id: 'estado', label: 'Estado', icon: 'M4 18a8 8 0 1 1 16 0M12 14l4-4' },
]

let msgId = 0

export function RemoteApp() {
  const [tab, setTab]           = useState<TabId>('chat')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending]   = useState(false)
  const [notice, setNotice]     = useState<string | null>(null)
  // Message whose turn hit the risk gate, waiting for fingerprint + password.
  const [pendingAuth, setPendingAuth] = useState<string | null>(null)

  const online    = useOnline()
  const telemetry = useTelemetry()
  const geo       = useLocationReporting()
  usePresenceReporting()

  // Toasts auto-dismiss; a stuck banner on a phone is worse than no banner.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 3200)
    return () => clearTimeout(timer)
  }, [notice])

  const push = (role: ChatMessage['role'], text: string) =>
    setMessages((prev) => [...prev.slice(-19), { id: ++msgId, role, text }])

  const onSend = useCallback(async (text: string, elevation?: string) => {
    if (!elevation) push('user', text)
    setSending(true)
    try {
      const turn = await sendTurn(text, elevation)
      push('jarvis', turn.reply)
      // The risk gate refused a tool: offer step-up auth and resend the SAME
      // message with a one-shot ticket. An elevated turn never re-prompts.
      if (turn.authRequired && !elevation) setPendingAuth(text)
    } catch {
      push('jarvis', 'Sin respuesta del servidor.')
    } finally {
      setSending(false)
    }
  }, [])

  const onTicket = (ticket: string) => {
    const text = pendingAuth
    setPendingAuth(null)
    if (!text) return
    push('user', `[autorizado] ${text}`)
    onSend(text, ticket)
  }

  const statusColor = online === null ? T.faint : online ? T.ok : T.bad
  const statusText  = online === null ? 'conectando' : online ? 'en línea' : 'sin conexión'

  return (
    <div style={S.screen}>
      <header style={S.header}>
        <div style={S.bar}>
          <span style={S.wordmark}>JARVIS</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Only worth words when it is NOT the happy path. */}
            {online !== true && <span style={{ ...S.hint, color: T.faint }}>{statusText}</span>}
            <span style={dotStyle(statusColor)} title={statusText} />
          </span>
        </div>
      </header>

      {notice && (
        <div style={{ ...S.bar, padding: '10px 16px 0' }}>
          <div style={{
            width: '100%', padding: '10px 14px', borderRadius: 10,
            background: 'rgba(0,229,255,0.10)', border: `1px solid rgba(0,229,255,0.28)`,
            color: T.text, fontSize: 13,
          }}>
            {notice}
          </div>
        </div>
      )}

      {pendingAuth && <AuthSheet message={pendingAuth} onTicket={onTicket} onCancel={() => setPendingAuth(null)} />}

      <main style={S.content}>
        <div style={S.column}>
          {tab === 'chat'   && <ChatTab messages={messages} sending={sending} onSend={(t) => onSend(t)} onNotice={setNotice} />}
          {tab === 'mando'  && <MandoTab onNotice={setNotice} />}
          {tab === 'proyector' && <ProyectorTab onNotice={setNotice} />}
          {tab === 'casa'   && <HomeTab onNotice={setNotice} />}
          {tab === 'pc'     && <PcTab onNotice={setNotice} />}
          {tab === 'estado' && <StatusTab online={online} telemetry={telemetry} geo={geo} />}
        </div>
      </main>

      <nav style={S.nav}>
        <div style={S.navInner}>
          {TABS.map((t) => {
            const active = t.id === tab
            return (
              <button
                key={t.id}
                style={{ ...S.navItem, color: active ? T.accent : T.faint }}
                aria-current={active ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={t.icon} />
                </svg>
                <span>{t.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
