/**
 * WakeWordWizard — first-boot calibration overlay.
 *
 * Shown when GET /api/jarvis/wake-status returns { calibrated: false }.
 * Records 4 short voice samples ("Jarvis") via MediaRecorder, then
 * POST /api/jarvis/wake-calibrate { samples: [base64, ...] }.
 * Dismisses on success.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { getApiBase } from '../../api/client'

type Step = 'checking' | 'idle' | 'recording' | 'done' | 'error'

const TOTAL_SAMPLES = 4
const RECORD_MS = 2000

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function WakeWordWizard() {
  const [visible, setVisible]       = useState(false)
  const [step, setStep]             = useState<Step>('checking')
  const [count, setCount]           = useState(0)           // samples recorded so far
  const [error, setError]           = useState<string>('')
  const samplesRef                  = useRef<string[]>([])
  const mediaRecRef                 = useRef<MediaRecorder | null>(null)
  const chunksRef                   = useRef<Blob[]>([])

  // Check calibration status on mount
  useEffect(() => {
    fetch(`${getApiBase()}/api/jarvis/wake-status`)
      .then(r => r.json())
      .then(d => {
        if (!d.calibrated) { setVisible(true); setStep('idle') }
      })
      .catch(() => {/* silently skip — don't block on network error */})
  }, [])

  const startRecording = useCallback(async () => {
    if (step === 'recording') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const rec = new MediaRecorder(stream, { mimeType })
      mediaRecRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, { type: mimeType })
        const b64  = await blobToBase64(blob)
        samplesRef.current = [...samplesRef.current, b64]
        const newCount = samplesRef.current.length
        setCount(newCount)
        if (newCount >= TOTAL_SAMPLES) {
          await calibrate(samplesRef.current)
        } else {
          setStep('idle')
        }
      }
      setStep('recording')
      rec.start()
      setTimeout(() => { if (rec.state === 'recording') rec.stop() }, RECORD_MS)
    } catch (e) {
      setError('No se pudo acceder al micrófono.')
      setStep('error')
    }
  }, [step])

  async function calibrate(samples: string[]) {
    try {
      const res = await fetch(`${getApiBase()}/api/jarvis/wake-calibrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ samples }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      setStep('done')
      setTimeout(() => setVisible(false), 2000)
    } catch (e) {
      setError('Error al guardar calibración. Intente de nuevo.')
      setStep('error')
      samplesRef.current = []
      setCount(0)
    }
  }

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(2, 6, 14, 0.97)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 32, color: '#ccd6f6', fontFamily: 'monospace',
    }}>
      {/* Title */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: '#38d5ff', fontSize: 14, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 8 }}>
          Calibración de Wake Word
        </div>
        <div style={{ fontSize: 11, color: 'rgba(56,213,255,0.5)', letterSpacing: 1 }}>
          Primera configuración · Solo una vez
        </div>
      </div>

      {/* Step content */}
      {step === 'checking' && (
        <div style={{ fontSize: 12, color: 'rgba(56,213,255,0.4)' }}>Comprobando...</div>
      )}

      {(step === 'idle' || step === 'recording') && (
        <>
          {/* Progress dots */}
          <div style={{ display: 'flex', gap: 10 }}>
            {Array.from({ length: TOTAL_SAMPLES }).map((_, i) => (
              <div key={i} style={{
                width: 12, height: 12, borderRadius: '50%',
                background: i < count ? '#38d5ff' : 'rgba(56,213,255,0.15)',
                border: '1px solid rgba(56,213,255,0.4)',
                transition: 'background 0.3s',
              }} />
            ))}
          </div>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 22, marginBottom: 12, color: '#ffffff' }}>
              {step === 'recording' ? '🎙 Escuchando...' : `Di "Jarvis" · muestra ${count + 1} de ${TOTAL_SAMPLES}`}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(56,213,255,0.45)', marginBottom: 24 }}>
              {step === 'recording'
                ? `Grabando ${RECORD_MS / 1000}s — habla con naturalidad`
                : 'Pulsa el botón y di "Jarvis" en voz alta'}
            </div>
          </div>

          <button
            onClick={startRecording}
            disabled={step === 'recording'}
            style={{
              padding: '14px 40px',
              background: step === 'recording'
                ? 'rgba(56,213,255,0.08)'
                : 'rgba(56,213,255,0.15)',
              border: `1px solid ${step === 'recording' ? 'rgba(56,213,255,0.3)' : '#38d5ff'}`,
              borderRadius: 8, color: '#38d5ff', fontSize: 13, letterSpacing: 2,
              textTransform: 'uppercase', cursor: step === 'recording' ? 'default' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {step === 'recording' ? '...' : 'Grabar'}
          </button>
        </>
      )}

      {step === 'done' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
          <div style={{ color: '#38d5ff', fontSize: 13, letterSpacing: 2 }}>
            Calibración guardada
          </div>
        </div>
      )}

      {step === 'error' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 16 }}>{error}</div>
          <button
            onClick={() => { setStep('idle'); setError('') }}
            style={{
              padding: '10px 28px', background: 'transparent',
              border: '1px solid rgba(255,107,107,0.5)', borderRadius: 6,
              color: '#ff6b6b', cursor: 'pointer', fontSize: 11, letterSpacing: 1,
            }}
          >Reintentar</button>
        </div>
      )}

      {/* Skip link */}
      {step !== 'done' && (
        <button
          onClick={() => setVisible(false)}
          style={{
            position: 'absolute', bottom: 24,
            background: 'transparent', border: 'none',
            color: 'rgba(56,213,255,0.3)', cursor: 'pointer',
            fontSize: 11, letterSpacing: 1,
          }}
        >
          Omitir por ahora
        </button>
      )}
    </div>
  )
}
