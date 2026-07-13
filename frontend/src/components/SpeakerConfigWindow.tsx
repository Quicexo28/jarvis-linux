import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiBase } from '../api/client'
import { HudBtn } from './HudBtn'
import { useJarvisStore } from '../state/jarvisStore'

interface SampleInfo {
  filename: string
  size: number
  createdAt: string
}

const RECORD_DURATION_S = 6.0
const MIN_VALID_DURATION_S = 3.0
const TICK_MS = 100

const GUIDE_PHRASES: string[] = [
  'Hola, soy {name}. Hoy quiero probar mi voz para que Jarvis me reconozca.',
  'El café se enfría rápido cuando uno pasa demasiado tiempo frente a la pantalla.',
  'Mi color favorito cambia según el día, aunque hoy elegiría el azul cielo.',
  'Cuando termine de grabar, voy a leer las noticias y tomar un poco de agua.',
  'Jarvis, recuérdame revisar la lista de tareas pendientes esta misma tarde.',
  'En el verano me gusta caminar por el parque mientras escucho buena música.',
  'Los libros antiguos huelen distinto y siempre cuentan historias inesperadas.',
  'Si pudiera viajar a cualquier lugar, probablemente elegiría una ciudad costera.',
  'La luna llena de esta semana se ve enorme cuando sale por el horizonte.',
  'Voy a contar despacio: uno, dos, tres, cuatro, cinco, seis y listo.',
]

function pickPhrase(speakerName: string, exclude?: string): string {
  const fillName = (p: string) => p.replace('{name}', speakerName.trim() || 'tu usuario')
  const pool = exclude ? GUIDE_PHRASES.filter(p => fillName(p) !== exclude) : GUIDE_PHRASES
  const raw = pool[Math.floor(Math.random() * pool.length)] ?? GUIDE_PHRASES[0]
  return fillName(raw)
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = samples.length * (bitsPerSample / 8)
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

interface SpeakerProfile {
  name: string
  samples: number
  threshold: number
  active_refs?: number
  rejected?: number
}

interface SpeakerSystemStatus {
  ready: boolean
  owner_ready?: boolean
  encoder?: string
  default_threshold?: number
  match_margin?: number
  cohort_size?: number
  wake_templates?: number
  trust_active?: boolean
  voice_learning?: boolean
  learn_threshold?: number
  denoise_mode?: string
  whisper_model?: string
  whisper_device?: string
}

const DEFAULT_THRESHOLD = 0.55
const THRESHOLD_MIN = 0.30
const THRESHOLD_MAX = 0.95

// Guided enrollment: one sample per acoustic condition, mirroring
// scripts/record-voice-sample.sh --session. Multi-condition references make
// identification robust to distance/volume/noise changes.
const SESSION_CONDITIONS = [
  {
    title: 'Voz normal · cerca',
    desc: 'Habla a tu distancia habitual del micrófono (30–50 cm), con tono natural.',
  },
  {
    title: 'Lejos · 2–3 metros',
    desc: 'Aléjate 2–3 metros del micrófono y habla con volumen normal.',
  },
  {
    title: 'Voz baja',
    desc: 'Habla suave, casi susurrando, como hablando de noche.',
  },
  {
    title: 'Voz alta',
    desc: 'Habla fuerte y con energía, como llamando desde otra habitación.',
  },
  {
    title: 'Con ruido de fondo',
    desc: 'Pon música o TV a volumen moderado y habla con tono normal.',
  },
]

export function SpeakerConfigWindow({ onClose }: { onClose: () => void }) {
  const speakerName = useJarvisStore(s => s.speakerName)
  const setSpeakerName = useJarvisStore(s => s.setSpeakerName)
  const voiceEnabled = useJarvisStore(s => s.voiceEnabled)

  const [speakers, setSpeakers] = useState<SpeakerProfile[]>([])
  const [activeSpeaker, setActiveSpeaker] = useState(
    speakerName && speakerName !== 'default' ? speakerName : ''
  )
  const [newSpeakerDraft, setNewSpeakerDraft] = useState('')
  const [samples, setSamples] = useState<SampleInfo[]>([])
  const [rejected, setRejected] = useState<SampleInfo[]>([])
  const [sysStatus, setSysStatus] = useState<SpeakerSystemStatus | null>(null)
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [remaining, setRemaining] = useState(RECORD_DURATION_S)
  const [phrase, setPhrase] = useState(() => pickPhrase(speakerName))
  const [sessionStep, setSessionStep] = useState<number | null>(null)
  const sessionStepRef = useRef<number | null>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const pcmChunksRef = useRef<Float32Array[]>([])
  const startTimeRef = useRef<number>(0)
  const tickIntervalRef = useRef<number | null>(null)
  const autoStopTimeoutRef = useRef<number | null>(null)
  const stopGuardRef = useRef(false)

  const fetchSpeakers = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/speakers`)
      const data = await res.json()
      if (data.ok && data.speakers) {
        setSpeakers(data.speakers)
        // No visible profiles → drop any stale selection (e.g. a persisted
        // name that now maps to the hidden owner voiceprint).
        if (data.speakers.length === 0) {
          setActiveSpeaker('')
          setSpeakerName('')
        }
      }
    } catch {}
  }, [setSpeakerName])

  const fetchSamples = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/samples?speaker=${encodeURIComponent(activeSpeaker)}`)
      const data = await res.json()
      if (data.ok) setSamples(data.samples ?? [])
    } catch {}
  }, [activeSpeaker])

  const fetchRejected = useCallback(async () => {
    if (!activeSpeaker) { setRejected([]); return }
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/rejected?speaker=${encodeURIComponent(activeSpeaker)}`)
      const data = await res.json()
      if (data.ok) setRejected(data.samples ?? [])
    } catch {}
  }, [activeSpeaker])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/status`)
      const data = await res.json()
      if (data.ok) setSysStatus(data as SpeakerSystemStatus)
    } catch {}
  }, [])

  useEffect(() => {
    fetchSpeakers()
    fetchStatus()
  }, [fetchSpeakers, fetchStatus])

  useEffect(() => { fetchSamples(); fetchRejected() }, [fetchSamples, fetchRejected])

  // Keep a valid active speaker selected and sync the threshold slider to it.
  // Per-speaker thresholds arrive already persisted from the backend.
  useEffect(() => {
    if (speakers.length === 0) return
    const current = speakers.find(s => s.name === activeSpeaker)
    if (!current) {
      const first = speakers[0]
      setActiveSpeaker(first.name)
      setSpeakerName(first.name)
      setThreshold(first.threshold ?? DEFAULT_THRESHOLD)
    } else {
      setThreshold(current.threshold ?? DEFAULT_THRESHOLD)
    }
  }, [speakers, activeSpeaker, setSpeakerName])

  const createSpeaker = async () => {
    const name = newSpeakerDraft.trim()
    if (!name) return
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/speakers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (data.ok) {
        setNewSpeakerDraft('')
        setActiveSpeaker(data.name)
        setSpeakerName(data.name)
        fetchSpeakers()
      }
    } catch {}
  }

  const deleteSpeaker = async (name: string) => {
    const ok = window.confirm(`Eliminar perfil "${name}" y TODAS sus muestras. ¿Continuar?`)
    if (!ok) return
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/speakers?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (res.status === 403) {
        setMessage('Ese nombre corresponde a la huella owner protegida — no se puede eliminar desde aquí.')
        return
      }
      // Clear local selection immediately; the sync effect picks a new one.
      if (activeSpeaker === name) {
        setActiveSpeaker('')
        setSpeakerName('')
        setSamples([])
      }
      setSpeakers(prev => prev.filter(s => s.name !== name))
      fetchSpeakers()
    } catch {}
  }

  const cleanupRecording = useCallback(() => {
    processorRef.current?.disconnect()
    sourceRef.current?.disconnect()
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close().catch(() => {})
    if (tickIntervalRef.current != null) {
      window.clearInterval(tickIntervalRef.current)
      tickIntervalRef.current = null
    }
    if (autoStopTimeoutRef.current != null) {
      window.clearTimeout(autoStopTimeoutRef.current)
      autoStopTimeoutRef.current = null
    }
    streamRef.current = null
    processorRef.current = null
    sourceRef.current = null
    audioCtxRef.current = null
  }, [])

  useEffect(() => () => { cleanupRecording() }, [cleanupRecording])

  const uploadSample = useCallback(async (blob: Blob) => {
    setStatus('loading')
    setMessage('Subiendo muestra...')
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/samples?speaker=${encodeURIComponent(activeSpeaker)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: blob,
      })
      const data = await res.json()
      if (data.ok) {
        fetchSamples()
        fetchSpeakers()
        const step = sessionStepRef.current
        if (step != null) {
          const next = step + 1
          if (next >= SESSION_CONDITIONS.length) {
            sessionStepRef.current = null
            setSessionStep(null)
            setMessage('Sesión completa: 5/5 condiciones grabadas. Re-calibrando Speaker ID...')
            try {
              await fetch(`${getApiBase()}/api/speaker-id/reload`, { method: 'POST' })
              setMessage('Sesión completa (5/5) y Speaker ID re-calibrado. Pide asignar estas muestras como huella base (owner) cuando quieras fijarlas.')
              fetchSpeakers()
            } catch {
              setMessage('Sesión completa (5/5), pero falló la re-calibración. Pulsa "Re-calibrar Speaker ID".')
            }
          } else {
            sessionStepRef.current = next
            setSessionStep(next)
            setPhrase(p => pickPhrase(activeSpeaker, p))
            setMessage(`Paso ${step + 1}/5 guardado. Siguiente: ${SESSION_CONDITIONS[next].title}`)
          }
        } else {
          setMessage(`Muestra guardada: ${data.filename}`)
        }
      } else {
        setMessage('Error al guardar muestra')
      }
    } catch {
      setMessage('Error de conexión')
    }
    setStatus('idle')
  }, [fetchSamples, fetchSpeakers, fetchStatus, activeSpeaker])

  const stopRecording = useCallback((reason: 'auto' | 'manual') => {
    if (stopGuardRef.current) return
    stopGuardRef.current = true

    const elapsedMs = Date.now() - startTimeRef.current
    const elapsedS = elapsedMs / 1000

    const chunks = pcmChunksRef.current
    let merged: Float32Array | null = null
    if (chunks.length > 0) {
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
      merged = new Float32Array(totalLen)
      let offset = 0
      for (const c of chunks) { merged.set(c, offset); offset += c.length }
    }

    cleanupRecording()
    pcmChunksRef.current = []
    setRecording(false)
    setRemaining(RECORD_DURATION_S)

    const shouldUpload = merged && (reason === 'auto' || elapsedS >= MIN_VALID_DURATION_S)
    if (shouldUpload && merged) {
      const wav = encodeWav(merged, 16000)
      uploadSample(wav)
    } else if (reason === 'manual' && elapsedS < MIN_VALID_DURATION_S) {
      setMessage(`Grabación muy corta, se descartó (mínimo ${MIN_VALID_DURATION_S.toFixed(0)} s)`)
    } else {
      setMessage('')
    }
  }, [cleanupRecording, uploadSample])

  const startRecording = useCallback(async () => {
    if (!activeSpeaker) {
      setMessage('Crea o selecciona un perfil antes de grabar.')
      return
    }
    try {
      // Enrollment capture: keep browser noise suppression ON so the reference
      // voiceprint is built from clean near-field voice (live STT uses the AEC
      // source instead). echoCancellation off — no TTS playing during enroll.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: false, noiseSuppression: true }
      })
      const ctx = new AudioContext({ sampleRate: 16000 })
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)

      pcmChunksRef.current = []
      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0)
        pcmChunksRef.current.push(new Float32Array(data))
      }

      source.connect(processor)
      processor.connect(ctx.destination)

      audioCtxRef.current = ctx
      sourceRef.current = source
      processorRef.current = processor
      streamRef.current = stream
      startTimeRef.current = Date.now()
      stopGuardRef.current = false

      setRecording(true)
      setRemaining(RECORD_DURATION_S)
      setMessage('')

      tickIntervalRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        const rem = Math.max(0, RECORD_DURATION_S - elapsed)
        setRemaining(rem)
      }, TICK_MS)

      autoStopTimeoutRef.current = window.setTimeout(() => {
        stopRecording('auto')
      }, RECORD_DURATION_S * 1000)
    } catch {
      setMessage('Error: no se pudo acceder al micrófono')
    }
  }, [stopRecording, activeSpeaker])

  const startSession = () => {
    if (!activeSpeaker) {
      setMessage('Crea o selecciona un perfil antes de grabar.')
      return
    }
    sessionStepRef.current = 0
    setSessionStep(0)
    setPhrase(p => pickPhrase(activeSpeaker, p))
    setMessage('Sesión guiada iniciada: 5 condiciones, una muestra por cada una.')
  }

  const skipSessionStep = () => {
    const step = sessionStepRef.current
    if (step == null) return
    const next = step + 1
    if (next >= SESSION_CONDITIONS.length) {
      sessionStepRef.current = null
      setSessionStep(null)
      setMessage('Sesión terminada. Pulsa "Re-calibrar Speaker ID" si grabaste muestras.')
    } else {
      sessionStepRef.current = next
      setSessionStep(next)
      setPhrase(p => pickPhrase(activeSpeaker, p))
      setMessage(`Paso saltado. Siguiente: ${SESSION_CONDITIONS[next].title}`)
    }
  }

  const cancelSession = () => {
    sessionStepRef.current = null
    setSessionStep(null)
    setMessage('Sesión guiada cancelada. Las muestras ya grabadas se conservan.')
  }

  const deleteSample = async (filename: string) => {
    try {
      await fetch(`${getApiBase()}/api/speaker-id/samples?file=${encodeURIComponent(filename)}&speaker=${encodeURIComponent(activeSpeaker)}`, { method: 'DELETE' })
      fetchSamples()
      fetchSpeakers()
    } catch {}
  }

  const restoreRejected = async (filename: string) => {
    try {
      const res = await fetch(
        `${getApiBase()}/api/speaker-id/rejected/restore?file=${encodeURIComponent(filename)}&speaker=${encodeURIComponent(activeSpeaker)}`,
        { method: 'POST' }
      )
      const data = await res.json()
      setMessage(data.ok
        ? `Muestra restaurada: ${filename}. El filtro puede re-rechazarla si sigue inconsistente.`
        : `Error: ${data.error ?? 'restore_failed'}`)
      fetchSamples()
      fetchRejected()
      fetchSpeakers()
    } catch {
      setMessage('Error de conexión')
    }
  }

  const deleteRejected = async (filename: string) => {
    try {
      await fetch(
        `${getApiBase()}/api/speaker-id/rejected?file=${encodeURIComponent(filename)}&speaker=${encodeURIComponent(activeSpeaker)}`,
        { method: 'DELETE' }
      )
      fetchRejected()
      fetchSpeakers()
    } catch {}
  }

  const reload = async () => {
    setStatus('loading')
    setMessage('Re-calibrando...')
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/reload`, { method: 'POST' })
      const data = await res.json()
      setMessage(data.ok ? 'Speaker ID recalibrado' : `Error: ${data.error}`)
      // Thresholds are preserved by the backend; refresh to reflect any changes.
      fetchSpeakers()
      fetchStatus()
      fetchRejected()
    } catch {
      setMessage('Error de conexión')
    }
    setStatus('idle')
  }

  const resetEnrollment = async () => {
    if (!activeSpeaker) return
    const ok = window.confirm(
      `Re-enrolar "${activeSpeaker}" desde cero.\n\n` +
      'Borra TODAS las muestras grabadas de este perfil. La huella owner ' +
      'cifrada NO se toca (se gestiona aparte). Después graba muestras ' +
      'nuevas y pulsa "Re-calibrar Speaker ID".\n\n¿Continuar?'
    )
    if (!ok) return
    setStatus('loading')
    setMessage('Borrando huella vieja...')
    try {
      const res = await fetch(
        `${getApiBase()}/api/speaker-id/reset?speaker=${encodeURIComponent(activeSpeaker)}`,
        { method: 'POST' }
      )
      const data = await res.json()
      if (data.ok) {
        setMessage(
          `Listo: ${data.samplesRemoved} muestra(s) borradas (huella owner intacta). ` +
          'Graba muestras nuevas y pulsa "Re-calibrar Speaker ID".'
        )
        fetchSamples()
        fetchSpeakers()
        fetchStatus()
        fetchRejected()
      } else {
        setMessage(`Error: ${data.error ?? 'reset_failed'}`)
      }
    } catch {
      setMessage('Error de conexión')
    }
    setStatus('idle')
  }

  const updateThreshold = async (val: number) => {
    if (!activeSpeaker) return
    setThreshold(val)
    setSpeakers(prev => prev.map(s => s.name === activeSpeaker ? { ...s, threshold: val } : s))
    try {
      await fetch(`${getApiBase()}/api/speaker-id/threshold`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: activeSpeaker, threshold: val }),
      })
    } catch {}
  }

  const elapsed = RECORD_DURATION_S - remaining
  const progressPct = Math.min(100, (elapsed / RECORD_DURATION_S) * 100)
  const noSamples = speakers.every(sp => sp.samples === 0)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0a0e14',
        zIndex: 9999,
        overflow: 'auto',
        fontFamily: "'Space Grotesk', monospace",
        color: '#e0e0e0',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 20px',
          borderBottom: '1px solid #ffffff15',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, letterSpacing: '2px', color: '#00f0ff' }}>SPEAKER ID · CONFIGURACIÓN</span>
          {voiceEnabled && noSamples && (
            <span style={{ fontSize: 9, color: '#ffb74d' }}>· enrolamiento pendiente</span>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: '1px solid #ff525244',
            color: '#ff5252',
            padding: '4px 12px',
            fontSize: 10,
            letterSpacing: '2px',
            cursor: 'pointer',
            borderRadius: 3,
          }}
        >
          CERRAR ✕
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 20,
          padding: 20,
          maxWidth: 1100,
          margin: '0 auto',
        }}
      >
        {/* Columna izq: Perfiles + Grabación */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Section title="PERFILES DE VOZ">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {speakers.map(sp => (
                <button
                  key={sp.name}
                  onClick={() => { setActiveSpeaker(sp.name); setSpeakerName(sp.name) }}
                  style={{
                    background: sp.name === activeSpeaker ? 'rgba(0,229,255,0.15)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${sp.name === activeSpeaker ? '#00e5ff' : '#ffffff22'}`,
                    color: sp.name === activeSpeaker ? '#00f0ff' : '#e0e0e0',
                    padding: '5px 10px',
                    fontSize: 11,
                    borderRadius: 4,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {sp.name}
                  <span style={{ fontSize: 9, opacity: 0.5 }}>({sp.samples})</span>
                </button>
              ))}
              {speakers.length === 0 && (
                <span style={{ fontSize: 10, opacity: 0.5 }}>Sin perfiles — crea uno abajo</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                value={newSpeakerDraft}
                onChange={(e) => setNewSpeakerDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createSpeaker() }}
                placeholder="Nuevo perfil (ej. Santiago)"
                style={{
                  flex: 1,
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid #00e5ff44',
                  color: '#e0e0e0',
                  padding: '5px 8px',
                  fontSize: 11,
                  borderRadius: 3,
                  outline: 'none',
                }}
              />
              <HudBtn onClick={createSpeaker}>Crear</HudBtn>
            </div>
            {activeSpeaker && (
              <button
                onClick={() => deleteSpeaker(activeSpeaker)}
                style={{
                  marginTop: 8,
                  background: 'none',
                  border: '1px solid #ff525266',
                  color: '#ff5252',
                  fontSize: 9,
                  padding: '3px 8px',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                Eliminar perfil "{activeSpeaker}"
              </button>
            )}
          </Section>

          <Section title={`GRABAR MUESTRA · ${activeSpeaker}`}>
            {sessionStep != null && (
              <div
                style={{
                  background: 'rgba(255,215,0,0.05)',
                  border: '1px solid #ffd70044',
                  borderRadius: 6,
                  padding: '10px 12px',
                  marginBottom: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, letterSpacing: '2px', color: '#ffd700' }}>
                    SESIÓN GUIADA · PASO {sessionStep + 1}/{SESSION_CONDITIONS.length}
                  </span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {SESSION_CONDITIONS.map((_, i) => (
                      <div
                        key={i}
                        style={{
                          width: 14,
                          height: 4,
                          borderRadius: 2,
                          background: i < sessionStep ? '#00e5ff' : i === sessionStep ? '#ffd700' : '#ffffff22',
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: '#ffe082', marginBottom: 3 }}>
                  {SESSION_CONDITIONS[sessionStep].title}
                </div>
                <div style={{ fontSize: 10, opacity: 0.7, lineHeight: 1.4 }}>
                  {SESSION_CONDITIONS[sessionStep].desc}
                </div>
              </div>
            )}
            <div
              style={{
                background: 'rgba(0, 229, 255, 0.06)',
                border: `1px solid ${recording ? '#00e5ff' : '#00e5ff33'}`,
                borderRadius: 6,
                padding: 16,
                minHeight: 110,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
              }}
            >
              <div style={{ fontSize: 9, opacity: 0.5, letterSpacing: '2px', marginBottom: 8 }}>
                FRASE GUÍA · léela en voz alta
              </div>
              <div
                style={{
                  fontSize: 16,
                  lineHeight: 1.4,
                  color: recording ? '#00f0ff' : '#c8f4ff',
                  fontFamily: "'Space Grotesk', sans-serif",
                }}
              >
                {phrase}
              </div>
            </div>

            {/* Timer + progreso */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginTop: 12,
                opacity: recording ? 1 : 0.5,
              }}
            >
              <div
                style={{
                  fontSize: 28,
                  fontVariantNumeric: 'tabular-nums',
                  color: recording ? '#00f0ff' : '#5a7a85',
                  minWidth: 80,
                }}
              >
                {remaining.toFixed(1)}s
              </div>
              <div
                style={{
                  flex: 1,
                  height: 8,
                  background: 'rgba(255,255,255,0.06)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  border: '1px solid #ffffff15',
                }}
              >
                <div
                  style={{
                    width: `${progressPct}%`,
                    height: '100%',
                    background: recording
                      ? 'linear-gradient(90deg, #00e5ff, #00f0ff)'
                      : '#00e5ff44',
                    transition: 'width 0.1s linear',
                  }}
                />
              </div>
            </div>

            {/* Acciones */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {recording ? (
                <HudBtn active onClick={() => stopRecording('manual')}>Detener</HudBtn>
              ) : sessionStep != null ? (
                <>
                  <HudBtn onClick={() => startRecording()}>
                    Grabar paso {sessionStep + 1} (6 s)
                  </HudBtn>
                  <HudBtn onClick={() => setPhrase(p => pickPhrase(activeSpeaker, p))}>Otra frase</HudBtn>
                  <HudBtn onClick={skipSessionStep}>Saltar paso</HudBtn>
                  <HudBtn onClick={cancelSession}>Cancelar sesión</HudBtn>
                </>
              ) : (
                <>
                  <HudBtn onClick={startSession}>Sesión guiada (5 condiciones)</HudBtn>
                  <HudBtn onClick={() => startRecording()}>Grabación suelta (6 s)</HudBtn>
                  <HudBtn onClick={() => setPhrase(p => pickPhrase(activeSpeaker, p))}>Otra frase</HudBtn>
                </>
              )}
            </div>

            <div style={{ fontSize: 9, opacity: 0.45, marginTop: 8 }}>
              Mínimo 3 s para guardar. Por debajo se descarta. Duración total: 6 s.
              {sessionStep == null && ' La sesión guiada graba una muestra por condición acústica (recomendado para enrolar).'}
            </div>
          </Section>

        </div>

        {/* Columna der: Muestras + calibración */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Section title={`MUESTRAS · ${activeSpeaker} · ${samples.length}`}>
            {samples.length === 0 ? (
              <div style={{ fontSize: 11, opacity: 0.5 }}>Sin muestras de voz para este perfil.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {samples.map(s => (
                  <div
                    key={s.filename}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      background: 'rgba(255,255,255,0.02)',
                      borderRadius: 3,
                    }}
                  >
                    <span style={{ fontSize: 11, flex: 1, opacity: 0.85, wordBreak: 'break-all' }}>{s.filename}</span>
                    <span style={{ fontSize: 9, opacity: 0.5, minWidth: 40, textAlign: 'right' }}>
                      {(s.size / 1024).toFixed(0)}KB
                    </span>
                    <button
                      onClick={() => deleteSample(s.filename)}
                      style={{
                        background: 'none',
                        border: '1px solid #ff5252',
                        color: '#ff5252',
                        fontSize: 10,
                        padding: '2px 7px',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                      aria-label={`Borrar ${s.filename}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {(() => {
              const sp = speakers.find(s => s.name === activeSpeaker)
              if (!sp || sp.active_refs == null) return null
              return (
                <div style={{ fontSize: 9, opacity: 0.5, marginTop: 8 }}>
                  Referencias activas en memoria: {sp.active_refs}
                  {sp.active_refs !== sp.samples ? ' (incluye huella base / excluye filtradas)' : ''}
                </div>
              )
            })()}
          </Section>

          {rejected.length > 0 && (
            <Section title={`RECHAZADAS (FILTRO DE CONSISTENCIA) · ${rejected.length}`}>
              <div style={{ fontSize: 9, opacity: 0.5, marginBottom: 8 }}>
                Muestras en cuarentena: sonaban a eco/ruido, no a la voz del perfil.
                Restaurar las devuelve al set activo (el filtro puede volver a rechazarlas).
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {rejected.map(s => (
                  <div
                    key={s.filename}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      background: 'rgba(255,82,82,0.04)',
                      border: '1px solid #ff525222',
                      borderRadius: 3,
                    }}
                  >
                    <span style={{ fontSize: 11, flex: 1, opacity: 0.75, wordBreak: 'break-all' }}>{s.filename}</span>
                    <span style={{ fontSize: 9, opacity: 0.5, minWidth: 40, textAlign: 'right' }}>
                      {(s.size / 1024).toFixed(0)}KB
                    </span>
                    <button
                      onClick={() => restoreRejected(s.filename)}
                      style={{
                        background: 'none',
                        border: '1px solid #00e5ff66',
                        color: '#00e5ff',
                        fontSize: 9,
                        padding: '2px 7px',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                    >
                      Restaurar
                    </button>
                    <button
                      onClick={() => deleteRejected(s.filename)}
                      style={{
                        background: 'none',
                        border: '1px solid #ff5252',
                        color: '#ff5252',
                        fontSize: 10,
                        padding: '2px 7px',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                      aria-label={`Borrar ${s.filename}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title={`CALIBRACIÓN · ${activeSpeaker || '—'}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 10, opacity: 0.6, minWidth: 50 }}>Umbral</span>
              <input
                type="range"
                min={THRESHOLD_MIN}
                max={THRESHOLD_MAX}
                step={0.01}
                value={threshold}
                disabled={!activeSpeaker}
                onChange={(e) => updateThreshold(Number(e.target.value))}
                style={{ flex: 1, height: 4, accentColor: '#00e5ff', opacity: activeSpeaker ? 1 : 0.4 }}
              />
              <span style={{ fontSize: 12, color: '#00e5ff', minWidth: 40, textAlign: 'right' }}>
                {threshold.toFixed(2)}
              </span>
            </div>
            <div style={{ fontSize: 9, opacity: 0.45, marginBottom: 12 }}>
              Umbral por perfil · menor = más permisivo · mayor = más estricto.
            </div>
            <HudBtn onClick={reload} active={status === 'loading'}>Re-calibrar Speaker ID</HudBtn>
            {activeSpeaker && (
              <button
                onClick={resetEnrollment}
                style={{
                  marginTop: 10,
                  width: '100%',
                  background: 'rgba(255,82,82,0.06)',
                  border: '1px solid #ff525266',
                  color: '#ff8a80',
                  fontSize: 10,
                  letterSpacing: '1px',
                  padding: '6px 8px',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                Re-enrolar desde cero (borra huella vieja)
              </button>
            )}
            <div style={{ fontSize: 9, opacity: 0.45, marginTop: 8 }}>
              Re-enrolar borra las muestras del perfil; la huella owner cifrada no se toca.
              Para fijar muestras nuevas como huella owner, pide a Jarvis regenerar el
              voiceprint (scripts/create-voiceprint.sh).
            </div>
          </Section>

          <Section title="MOTOR DE RECONOCIMIENTO">
            {sysStatus ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 12px', fontSize: 10 }}>
                <StatusRow
                  label="Huella owner"
                  value={sysStatus.owner_ready ? 'activa (oculta)' : 'NO CARGADA'}
                  highlight={!!sysStatus.owner_ready}
                  warn={!sysStatus.owner_ready}
                />
                <StatusRow label="Encoder" value={sysStatus.encoder ?? '—'} highlight />
                <StatusRow label="Denoise (solo Whisper)" value={sysStatus.denoise_mode ?? '—'} />
                <StatusRow
                  label="Cohort anti-ruido"
                  value={sysStatus.cohort_size ? `activo · ${sysStatus.cohort_size} anclas` : 'INACTIVO'}
                  warn={!sysStatus.cohort_size}
                />
                <StatusRow
                  label="Ancla de voz"
                  value={sysStatus.wake_templates ? 'activa (oculta)' : 'inactiva'}
                  highlight={!!sysStatus.wake_templates}
                />
                <StatusRow
                  label="Aprendizaje online"
                  value={sysStatus.voice_learning
                    ? `activo · confianza ≥ ${sysStatus.learn_threshold?.toFixed(2) ?? '—'}`
                    : 'desactivado'}
                />
                <StatusRow label="Umbral por defecto" value={sysStatus.default_threshold?.toFixed(2) ?? '—'} />
                <StatusRow label="Margen anti-confusión" value={sysStatus.match_margin?.toFixed(2) ?? '—'} />
                <StatusRow
                  label="Whisper"
                  value={`${sysStatus.whisper_model ?? '—'} · ${sysStatus.whisper_device ?? '—'}`}
                />
              </div>
            ) : (
              <div style={{ fontSize: 10, opacity: 0.5 }}>Servicio STT no disponible.</div>
            )}
            <div style={{ fontSize: 9, opacity: 0.45, marginTop: 10 }}>
              Speaker-ID usa audio crudo; el denoise solo alimenta la transcripción.
              El cohort rechaza ruido puro que imita el canal del micrófono.
            </div>
          </Section>

          {message && (
            <div
              style={{
                fontSize: 11,
                color: '#ffd700',
                opacity: 0.95,
                padding: 10,
                border: '1px solid #ffd70033',
                background: 'rgba(255,215,0,0.05)',
                borderRadius: 4,
              }}
            >
              {message}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusRow({ label, value, highlight, warn }: {
  label: string; value: string; highlight?: boolean; warn?: boolean
}) {
  return (
    <>
      <span style={{ opacity: 0.55 }}>{label}</span>
      <span style={{ color: warn ? '#ff8a80' : highlight ? '#00f0ff' : '#c8f4ff' }}>{value}</span>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid #ffffff15',
        borderRadius: 6,
        padding: 14,
        background: 'rgba(255,255,255,0.015)',
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: '2px', color: '#00e5ff', opacity: 0.7, marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  )
}
