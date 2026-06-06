import { useRef, useState } from 'react'
import { getApiBase } from '../api/client'
import { streamTtsAndPlay } from '../audio/streamingTts'

interface Stats {
  bufferedMs: number
  rate: number
  underruns: number
}

export function TtsTestWidget() {
  const [text, setText] = useState('Hola, soy Jarvis. Esta es una prueba de mi voz clonada.')
  const [status, setStatus] = useState<'idle' | 'playing' | 'error'>('idle')
  const [message, setMessage] = useState<string>('')
  const [stats, setStats] = useState<Stats | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const play = async () => {
    const trimmed = text.trim()
    if (!trimmed) {
      setStatus('error')
      setMessage('Escribe algo para probar.')
      return
    }
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStatus('playing')
    setMessage('Conectando…')
    setStats(null)
    try {
      await streamTtsAndPlay({
        url: `${getApiBase()}/api/jarvis/tts/ws`,
        text: trimmed,
        lang: 'es',
        fx: true,
        signal: ctrl.signal,
        onStats: (s) => setStats(s),
      })
      setStatus('idle')
      setMessage('Listo.')
    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        setStatus('idle')
        setMessage('')
        return
      }
      setStatus('error')
      setMessage(`Error: ${(err as Error).message}`)
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus('idle')
    setMessage('Detenido.')
  }

  return (
    <div style={{
      border: '1px solid #ffffff15',
      borderRadius: 4,
      padding: 8,
      marginTop: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ fontSize: 9, color: '#00e5ff', letterSpacing: 1 }}>PRUEBA TTS</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="Texto para probar voz clonada…"
        style={{
          background: '#0a0e14',
          color: '#cfeaff',
          border: '1px solid #ffffff20',
          borderRadius: 3,
          padding: 6,
          fontFamily: 'inherit',
          fontSize: 11,
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={play}
          disabled={status === 'playing'}
          style={{
            flex: 1,
            background: status === 'playing' ? '#00e5ff22' : '#00e5ff15',
            color: '#00e5ff',
            border: '1px solid #00e5ff55',
            borderRadius: 3,
            padding: '4px 8px',
            fontSize: 10,
            cursor: status === 'playing' ? 'wait' : 'pointer',
          }}
        >
          {status === 'playing' ? 'Reproduciendo…' : 'Reproducir'}
        </button>
        {status === 'playing' && (
          <button
            onClick={stop}
            style={{
              background: '#ff556615',
              color: '#ff5566',
              border: '1px solid #ff556655',
              borderRadius: 3,
              padding: '4px 10px',
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            Detener
          </button>
        )}
      </div>
      {message && (
        <div style={{
          fontSize: 9,
          color: status === 'error' ? '#ff5566' : '#cfeaff99',
        }}>
          {message}
        </div>
      )}
      {stats && (
        <div style={{
          fontSize: 9,
          color: '#cfeaff66',
          fontFamily: 'monospace',
          display: 'flex',
          gap: 8,
        }}>
          <span>buf {stats.bufferedMs.toFixed(0)}ms</span>
          <span>rate {stats.rate.toFixed(3)}x</span>
          <span style={{ color: stats.underruns > 0 ? '#ffaa44' : '#cfeaff66' }}>
            under {stats.underruns}
          </span>
        </div>
      )}
    </div>
  )
}
