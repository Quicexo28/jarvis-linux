import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { S, T } from './theme'
import { startDictation } from './native'

export type ChatMessage = { id: number; role: 'user' | 'jarvis'; text: string }

const SUGGESTIONS = ['¿Cómo está el PC?', 'Pon un timer de 10 minutos', 'Resumen del día']

function bubble(role: ChatMessage['role']): CSSProperties {
  const mine = role === 'user'
  return {
    alignSelf: mine ? 'flex-end' : 'flex-start',
    maxWidth: '86%',
    padding: '10px 14px',
    borderRadius: 16,
    borderBottomRightRadius: mine ? 4 : 16,
    borderBottomLeftRadius: mine ? 16 : 4,
    background: mine ? T.surfaceUp : 'rgba(0,229,255,0.10)',
    border: `1px solid ${mine ? T.line : 'rgba(0,229,255,0.28)'}`,
    color: mine ? T.text : T.text,
    fontSize: 15,
    whiteSpace: 'pre-wrap',
  }
}

export function ChatTab({
  messages, sending, onSend, onNotice,
}: {
  messages: ChatMessage[]
  sending: boolean
  onSend: (text: string) => void
  onNotice: (text: string) => void
}) {
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages.length, sending])

  const submit = (text: string) => {
    if (!text.trim() || sending) return
    setInput('')
    onSend(text.trim())
  }

  const mic = () => {
    setListening(true)
    startDictation(
      (text) => { setListening(false); submit(text) },
      (reason) => { setListening(false); onNotice(reason) },
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12 }}>
        {messages.length === 0 && (
          <div style={{ ...S.card, textAlign: 'center', padding: '28px 18px' }}>
            <div style={{ fontSize: 16, marginBottom: 6 }}>Hola.</div>
            <div style={S.hint}>Pregunta, ordena o dicta. Jarvis responde con las mismas herramientas del escritorio.</div>
          </div>
        )}
        {messages.map((m) => <div key={m.id} style={bubble(m.role)}>{m.text}</div>)}
        {sending && <div style={{ ...bubble('jarvis'), color: T.faint }}>pensando…</div>}
        <div ref={endRef} />
      </div>

      {messages.length === 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} style={{ ...S.btnGhost, fontSize: 12 }} onClick={() => submit(s)}>{s}</button>
          ))}
        </div>
      )}

      <div style={{
        position: 'sticky', bottom: 0, display: 'flex', gap: 8,
        background: T.bg, paddingTop: 8,
      }}>
        <input
          style={S.input}
          value={input}
          placeholder="Escribe a Jarvis…"
          enterKeyHint="send"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(input) }}
        />
        <button
          style={{ ...S.btn, width: 48, padding: 0, color: listening ? T.accent : T.dim }}
          aria-label="Dictar"
          onClick={mic}
        >
          {/* Inline SVG, not an emoji: the tablet's font falls back to a box glyph. */}
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ display: 'block', margin: '0 auto' }}>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <button style={{ ...S.btnAccent, width: 56, padding: 0 }} aria-label="Enviar" onClick={() => submit(input)} disabled={sending}>
          →
        </button>
      </div>
    </div>
  )
}
