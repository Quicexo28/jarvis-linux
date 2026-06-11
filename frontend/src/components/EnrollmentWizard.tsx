/**
 * EnrollmentWizard — first-boot speaker enrollment overlay (Siri/Alexa style).
 *
 * Shown when GET /api/speaker-id/speakers returns no speaker with samples.
 * Asks for a name, then guides 4 recordings of specific phrases (phonetically
 * varied, natural Jarvis commands) so resemblyzer can recognize the speaker
 * from then on. On finish: POST /api/speaker-id/reload + localStorage flag.
 * Skipping persists only for the session — it reappears on next boot until
 * enrollment completes (without it, every voice turn is ignored).
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { getApiBase } from '../api/client'
import { startWavRecording, type WavRecording } from '../audio/wavRecorder'
import { useJarvisStore } from '../state/jarvisStore'

const DONE_KEY = 'jarvis.enrollment.done.v1'
const SKIP_KEY = 'jarvis.enrollment.skipped'
const MAX_RECORD_MS = 8000

const PHRASES = [
  'Jarvis, enciende las luces de la sala y dime qué hora es',
  'Quiero revisar el clima de mañana antes de salir de casa',
  'Recuérdame llamar al doctor el viernes a las nueve de la mañana',
  'Abre el plano de la casa y muéstrame el estado del sistema',
]

type Phase = 'checking' | 'name' | 'phrase' | 'recording' | 'uploading' | 'finishing' | 'done' | 'error'

const cyan = '#38d5ff'

export function EnrollmentWizard() {
  const [visible, setVisible] = useState(false)
  const [phase, setPhase] = useState<Phase>('checking')
  const [idx, setIdx] = useState(0)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const recRef = useRef<WavRecording | null>(null)
  const autoStopRef = useRef<number | null>(null)
  const setSpeakerName = useJarvisStore((s) => s.setSpeakerName)

  useEffect(() => {
    try {
      if (localStorage.getItem(DONE_KEY) === '1' || sessionStorage.getItem(SKIP_KEY) === '1') return
    } catch { /* storage unavailable — still try the network check */ }
    fetch(`${getApiBase()}/api/speaker-id/speakers`)
      .then((r) => r.json())
      .then((d) => {
        const enrolled = Array.isArray(d?.speakers)
          && d.speakers.some((s: { samples?: number }) => (s.samples ?? 0) > 0)
        if (enrolled) {
          try { localStorage.setItem(DONE_KEY, '1') } catch { /* non-fatal */ }
        } else {
          setVisible(true)
          setPhase('name')
        }
      })
      .catch(() => { /* STT/backend down — don't block the UI, retry next boot */ })
  }, [])

  const beginPhrases = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/speakers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      setSpeakerName(trimmed)
      setPhase('phrase')
    } catch {
      setError('No se pudo crear el perfil. ¿Está el backend activo?')
      setPhase('error')
    }
  }, [name, setSpeakerName])

  const stopAndUpload = useCallback(async () => {
    const rec = recRef.current
    if (!rec) return
    recRef.current = null
    if (autoStopRef.current !== null) { window.clearTimeout(autoStopRef.current); autoStopRef.current = null }
    setPhase('uploading')
    try {
      const wav = rec.stop()
      const res = await fetch(
        `${getApiBase()}/api/speaker-id/samples?speaker=${encodeURIComponent(name.trim())}`,
        { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav },
      )
      if (!res.ok) throw new Error(`status ${res.status}`)
      const next = idx + 1
      if (next >= PHRASES.length) {
        setPhase('finishing')
        await fetch(`${getApiBase()}/api/speaker-id/reload`, { method: 'POST' }).catch(() => {})
        try { localStorage.setItem(DONE_KEY, '1') } catch { /* non-fatal */ }
        setPhase('done')
        setTimeout(() => setVisible(false), 3500)
      } else {
        setIdx(next)
        setPhase('phrase')
      }
    } catch {
      setError('No se pudo guardar la muestra. Intenta de nuevo.')
      setPhase('error')
    }
  }, [idx, name])

  const startRecording = useCallback(async () => {
    try {
      recRef.current = await startWavRecording()
      setPhase('recording')
      autoStopRef.current = window.setTimeout(() => { void stopAndUpload() }, MAX_RECORD_MS)
    } catch {
      setError('No se pudo acceder al micrófono. Revisa los permisos.')
      setPhase('error')
    }
  }, [stopAndUpload])

  const skip = useCallback(() => {
    recRef.current?.cancel()
    recRef.current = null
    try { sessionStorage.setItem(SKIP_KEY, '1') } catch { /* non-fatal */ }
    setVisible(false)
  }, [])

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9100,
      background: 'rgba(2, 6, 14, 0.97)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 28, color: '#ccd6f6', fontFamily: 'monospace',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: cyan, fontSize: 14, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 8 }}>
          Reconocimiento de voz
        </div>
        <div style={{ fontSize: 11, color: 'rgba(56,213,255,0.5)', letterSpacing: 1 }}>
          Primera configuración · Jarvis aprenderá tu voz
        </div>
      </div>

      {phase === 'name' && (
        <>
          <div style={{ fontSize: 13, maxWidth: 420, textAlign: 'center', lineHeight: 1.7 }}>
            Para que Jarvis te reconozca y solo te obedezca a ti, grabarás
            {` ${PHRASES.length} `}frases cortas. Primero, ¿cómo te llamas?
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void beginPhrases() }}
            placeholder="Tu nombre"
            autoFocus
            style={{
              padding: '12px 18px', fontSize: 14, width: 240, textAlign: 'center',
              background: 'rgba(56,213,255,0.06)', border: `1px solid rgba(56,213,255,0.4)`,
              borderRadius: 8, color: '#fff', outline: 'none', fontFamily: 'monospace',
            }}
          />
          <button
            onClick={() => void beginPhrases()}
            disabled={!name.trim()}
            style={{
              padding: '14px 40px', background: name.trim() ? 'rgba(56,213,255,0.15)' : 'rgba(56,213,255,0.05)',
              border: `1px solid ${name.trim() ? cyan : 'rgba(56,213,255,0.2)'}`,
              borderRadius: 8, color: cyan, fontSize: 13, letterSpacing: 2,
              textTransform: 'uppercase', cursor: name.trim() ? 'pointer' : 'default',
            }}
          >Comenzar</button>
        </>
      )}

      {(phase === 'phrase' || phase === 'recording' || phase === 'uploading') && (
        <>
          <div style={{ display: 'flex', gap: 10 }}>
            {PHRASES.map((_, i) => (
              <div key={i} style={{
                width: 12, height: 12, borderRadius: '50%',
                background: i < idx ? cyan : i === idx && phase === 'recording' ? '#ff6b6b' : 'rgba(56,213,255,0.15)',
                border: '1px solid rgba(56,213,255,0.4)', transition: 'background 0.3s',
              }} />
            ))}
          </div>

          <div style={{ textAlign: 'center', maxWidth: 520 }}>
            <div style={{ fontSize: 11, color: 'rgba(56,213,255,0.45)', marginBottom: 14, letterSpacing: 1 }}>
              Frase {idx + 1} de {PHRASES.length} — pulsa Grabar y léela con tu voz natural
            </div>
            <div style={{ fontSize: 19, color: '#ffffff', lineHeight: 1.6 }}>
              “{PHRASES[idx]}”
            </div>
          </div>

          <button
            onClick={() => { phase === 'recording' ? void stopAndUpload() : void startRecording() }}
            disabled={phase === 'uploading'}
            style={{
              padding: '14px 40px',
              background: phase === 'recording' ? 'rgba(255,107,107,0.15)' : 'rgba(56,213,255,0.15)',
              border: `1px solid ${phase === 'recording' ? '#ff6b6b' : cyan}`,
              borderRadius: 8, color: phase === 'recording' ? '#ff6b6b' : cyan,
              fontSize: 13, letterSpacing: 2, textTransform: 'uppercase',
              cursor: phase === 'uploading' ? 'default' : 'pointer',
            }}
          >
            {phase === 'recording' ? '■ Terminar' : phase === 'uploading' ? 'Guardando…' : '🎙 Grabar'}
          </button>
        </>
      )}

      {phase === 'finishing' && (
        <div style={{ fontSize: 12, color: 'rgba(56,213,255,0.5)' }}>Calculando tu huella de voz…</div>
      )}

      {phase === 'done' && (
        <div style={{ textAlign: 'center', maxWidth: 460 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
          <div style={{ color: cyan, fontSize: 13, letterSpacing: 2, marginBottom: 14 }}>
            Listo, {name.trim()}. Jarvis te reconocerá a partir de ahora.
          </div>
          <div style={{ fontSize: 11, color: 'rgba(56,213,255,0.45)', lineHeight: 1.7 }}>
            Para acceso de propietario completo, fija JARVIS_OWNER_SPEAKER={name.trim()} en
            el servicio jarvis-backend.
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 16 }}>{error}</div>
          <button
            onClick={() => { setError(''); setPhase(name.trim() ? 'phrase' : 'name') }}
            style={{
              padding: '10px 28px', background: 'transparent',
              border: '1px solid rgba(255,107,107,0.5)', borderRadius: 6,
              color: '#ff6b6b', cursor: 'pointer', fontSize: 11, letterSpacing: 1,
            }}
          >Reintentar</button>
        </div>
      )}

      {phase !== 'done' && phase !== 'checking' && (
        <button
          onClick={skip}
          style={{
            position: 'absolute', bottom: 24,
            background: 'transparent', border: 'none',
            color: 'rgba(56,213,255,0.3)', cursor: 'pointer',
            fontSize: 11, letterSpacing: 1,
          }}
        >
          Configurar más tarde
        </button>
      )}
    </div>
  )
}
