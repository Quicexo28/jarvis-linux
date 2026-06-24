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
    <div className="holo-overlay">
      <div className="glass wake-wizard">
        <span className="holo-corner tl" />
        <span className="holo-corner tr" />
        <span className="holo-corner bl" />
        <span className="holo-corner br" />

        {/* Title */}
        <div>
          <div className="wake-wizard__title">Calibración de Wake Word</div>
          <div className="wake-wizard__sub">Primera configuración · Solo una vez</div>
        </div>

        {/* Step content */}
        {step === 'checking' && (
          <div className="wake-wizard__hint">Comprobando...</div>
        )}

        {(step === 'idle' || step === 'recording') && (
          <>
            <div className={`wake-pulse ${step === 'recording' ? 'wake-pulse--active' : ''}`}>
              <span className="wake-pulse__ring" />
              <span className="wake-pulse__ring" />
              <span className="wake-pulse__core" />
            </div>

            {/* Progress dots */}
            <div className="wake-dots">
              {Array.from({ length: TOTAL_SAMPLES }).map((_, i) => (
                <span key={i} className={`wake-dot ${i < count ? 'wake-dot--filled' : ''}`} />
              ))}
            </div>

            <div>
              <div className="wake-wizard__prompt">
                {step === 'recording' ? 'Escuchando...' : `Di "Jarvis" · muestra ${count + 1} de ${TOTAL_SAMPLES}`}
              </div>
              <div className="wake-wizard__hint">
                {step === 'recording'
                  ? `Grabando ${RECORD_MS / 1000}s — habla con naturalidad`
                  : 'Pulsa el botón y di "Jarvis" en voz alta'}
              </div>
            </div>

            <button className="holo-btn" onClick={startRecording} disabled={step === 'recording'}>
              {step === 'recording' ? 'Grabando...' : 'Grabar'}
            </button>
          </>
        )}

        {step === 'done' && (
          <div>
            <div className="wake-wizard__check">✓</div>
            <div className="wake-wizard__prompt" style={{ color: 'var(--primary)' }}>
              Calibración guardada
            </div>
          </div>
        )}

        {step === 'error' && (
          <div>
            <div className="wake-wizard__error">{error}</div>
            <button className="holo-btn holo-btn--danger" onClick={() => { setStep('idle'); setError('') }}>
              Reintentar
            </button>
          </div>
        )}

        {/* Skip link */}
        {step !== 'done' && (
          <button className="holo-btn holo-btn--ghost" onClick={() => setVisible(false)}>
            Omitir por ahora
          </button>
        )}
      </div>
    </div>
  )
}
