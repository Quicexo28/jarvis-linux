import { useCallback, useEffect, useState } from 'react'
import { getApiBase } from '../api/client'
import { HudBtn } from './HudBtn'
import { useJarvisStore } from '../state/jarvisStore'

interface SpeakerEntry {
  samples: { filename: string; size: number; createdAt: string }[]
}

export function SpeakerIdPanel({ onOpenConfig }: { onOpenConfig: () => void }) {
  const speakerName = useJarvisStore(s => s.speakerName)
  const voiceEnabled = useJarvisStore(s => s.voiceEnabled)
  const [totalSamples, setTotalSamples] = useState(0)

  const fetchSamples = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/api/speaker-id/samples`)
      const data = await res.json()
      if (data.ok && data.speakers) {
        const count = data.speakers.reduce((sum: number, sp: SpeakerEntry) => sum + sp.samples.length, 0)
        setTotalSamples(count)
      }
    } catch {}
  }, [])

  useEffect(() => { fetchSamples() }, [fetchSamples])

  const noSamples = totalSamples === 0

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 9, letterSpacing: '2px', color: 'var(--cyan, #00e5ff)', opacity: 0.7, marginBottom: 8 }}>
        SPEAKER ID
      </div>

      {voiceEnabled && noSamples && (
        <div style={{
          fontSize: 10,
          color: '#ffb74d',
          background: 'rgba(255, 152, 0, 0.08)',
          border: '1px solid #ff980044',
          padding: '6px 8px',
          marginBottom: 8,
          borderRadius: 3,
        }}>
          Voz activa sin muestras registradas: el clasificador no podrá identificarte y todas las respuestas quedarán bloqueadas. Abre la ventana de configuración y graba al menos una muestra.
        </div>
      )}

      <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 8 }}>
        {noSamples
          ? 'Sin muestras de voz registradas.'
          : `${totalSamples} muestra${totalSamples === 1 ? '' : 's'}${speakerName ? ` · usuario: ${speakerName}` : ''}`}
      </div>

      <HudBtn onClick={onOpenConfig}>Configurar speakers</HudBtn>
    </div>
  )
}
