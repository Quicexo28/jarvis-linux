import { useCallback, useEffect, useState } from 'react'
import { getApiBase } from '../api/client'
import { HudBtn } from './HudBtn'
import { useJarvisStore } from '../state/jarvisStore'

interface SpeakerStatusEntry {
  name: string
  samples: number
  threshold: number
  active_refs?: number
  rejected?: number
}

interface SpeakerStatus {
  ready: boolean
  speakers: SpeakerStatusEntry[]
  owner_ready?: boolean
  encoder?: string
  cohort_size?: number
  voice_learning?: boolean
  denoise_mode?: string
}

export function SpeakerIdPanel({ onOpenConfig }: { onOpenConfig: () => void }) {
  const speakerName = useJarvisStore(s => s.speakerName)
  const voiceEnabled = useJarvisStore(s => s.voiceEnabled)
  const [status, setStatus] = useState<SpeakerStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/status`)
      const data = await res.json()
      if (data.ok) {
        setStatus(data as SpeakerStatus)
        setUnreachable(false)
      } else {
        setUnreachable(true)
      }
    } catch {
      setUnreachable(true)
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  // active_refs counts the encrypted seed too, so it is the real "can Jarvis
  // recognize anyone" signal — WAV sample count alone is misleading.
  const totalRefs = status?.speakers.reduce((sum, sp) => sum + (sp.active_refs ?? 0), 0) ?? 0
  const totalRejected = status?.speakers.reduce((sum, sp) => sum + (sp.rejected ?? 0), 0) ?? 0
  // The owner voiceprint is hidden from the speakers list on purpose;
  // owner_ready alone means identification works.
  const noVoices = status != null && (!status.ready || (totalRefs === 0 && !status.owner_ready))

  return (
    // Sin encabezado propio: lo pone la PanelSection que envuelve a este
    // componente ("HABLANTE"). Dos títulos para una sección es ruido.
    <div>

      {unreachable && (
        <div style={{
          fontSize: 10,
          color: '#ff8a80',
          background: 'rgba(255, 82, 82, 0.08)',
          border: '1px solid #ff525244',
          padding: '6px 8px',
          marginBottom: 8,
          borderRadius: 3,
        }}>
          Servicio STT no disponible: sin identificación de voz.
        </div>
      )}

      {voiceEnabled && noVoices && (
        <div style={{
          fontSize: 10,
          color: '#ffb74d',
          background: 'rgba(255, 152, 0, 0.08)',
          border: '1px solid #ff980044',
          padding: '6px 8px',
          marginBottom: 8,
          borderRadius: 3,
        }}>
          Voz activa sin voces enroladas: Jarvis no podrá identificarte y las
          respuestas quedarán bloqueadas. Abre la configuración y usa la sesión
          guiada de grabación.
        </div>
      )}

      {status && !noVoices && (
        <div style={{ fontSize: 10, opacity: 0.75, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>
            {status.owner_ready ? 'Identificación de voz activa' : ''}
            {status.speakers.length > 0
              ? `${status.owner_ready ? ' · ' : ''}${status.speakers.map(sp => `${sp.name}: ${sp.active_refs ?? 0} refs`).join(' · ')}`
              : ''}
            {!status.owner_ready && speakerName ? ` · activo: ${speakerName}` : ''}
          </span>
          <span style={{ opacity: 0.65 }}>
            {status.encoder ?? '—'}
            {' · '}
            <span style={{ color: status.cohort_size ? undefined : '#ff8a80' }}>
              cohort {status.cohort_size ? 'on' : 'OFF'}
            </span>
            {' · '}
            aprendizaje {status.voice_learning ? 'on' : 'off'}
            {totalRejected > 0 ? ` · ${totalRejected} rechazadas` : ''}
          </span>
        </div>
      )}

      <HudBtn onClick={onOpenConfig}>Configurar speakers</HudBtn>
    </div>
  )
}
