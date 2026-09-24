/**
 * Jarvis Remote — the single app for phone and tablet.
 *
 * One shell, four tabs: chat with the brain, house control, the remote-PC
 * panel (distributed agents) and device/system status. The Android companion
 * loads exactly this page in a WebView, so features live here once and the APK
 * only adds what a WebView cannot do (background reporting, native dictation).
 */
import { useCallback, useEffect, useState } from 'react'
import { S, T, dotStyle } from './theme'
import { ChatTab, type ChatMessage } from './ChatTab'
import { HomeTab } from './HomeTab'
import { PcTab } from './PcTab'
import { StatusTab } from './StatusTab'
import { useOnline, useTelemetry, useLocationReporting, usePresenceReporting } from './hooks'
import { sendTurn } from './api'

type TabId = 'chat' | 'casa' | 'pc' | 'estado'

// Inline SVG paths, not emoji or box-drawing glyphs: the Android WebView font
// stack renders several of those as tofu boxes.
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'chat',   label: 'Chat',   icon: 'M4 5h16v11H9l-5 4z' },
  { id: 'casa',   label: 'Casa',   icon: 'M4 11 12 4l8 7v9H4z' },
  { id: 'pc',     label: 'PC',     icon: 'M3 5h18v11H3zM8 20h8' },
  { id: 'estado', label: 'Estado', icon: 'M4 18a8 8 0 1 1 16 0M12 14l4-4' },
]

let msgId = 0

export function RemoteApp() {
  const [tab, setTab]           = useState<TabId>('chat')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending]   = useState(false)
  const [notice, setNotice]     = useState<string | null>(null)

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

  const onSend = useCallback(async (text: string) => {
    push('user', text)
    setSending(true)
    try {
      push('jarvis', await sendTurn(text))
    } catch {
      push('jarvis', 'Sin respuesta del servidor.')
    } finally {
      setSending(false)
    }
  }, [])

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

      <main style={S.content}>
        <div style={S.column}>
          {tab === 'chat'   && <ChatTab messages={messages} sending={sending} onSend={onSend} onNotice={setNotice} />}
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
