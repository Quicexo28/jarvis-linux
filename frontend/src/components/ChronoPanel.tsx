import { useEffect, useState } from 'react'
import { HudPanel } from './HudPanel'
import { HudBtn } from './HudBtn'
import { useChronoStore, formatChrono, startChronoTicker, type ChronoEntry } from '../state/chronoStore'
import type { CSSProperties } from 'react'

interface ChronoPanelProps {
  exiting?: boolean
  style?: CSSProperties
}

export function ChronoPanel({ exiting, style }: ChronoPanelProps) {
  useEffect(() => { startChronoTicker() }, [])
  const chronos = useChronoStore((s) => s.chronos)
  const create = useChronoStore((s) => s.create)
  const start = useChronoStore((s) => s.start)
  const pause = useChronoStore((s) => s.pause)
  const reset = useChronoStore((s) => s.reset)
  const lap = useChronoStore((s) => s.lap)
  const cancel = useChronoStore((s) => s.cancel)

  const [showForm, setShowForm] = useState(chronos.length === 0)
  const [label, setLabel] = useState('')

  const submit = () => {
    create({ label, autoStart: true })
    setLabel('')
    setShowForm(false)
  }

  return (
    <HudPanel mode="Cronómetro" exiting={exiting} className="mode-panel mode-panel--wide" style={style}>
      <div className="timer-panel">
        {chronos.length === 0 && !showForm && (
          <div className="timer-empty">
            <div className="timer-empty-title">SIN CRONÓMETROS</div>
            <div className="timer-empty-subtitle">Inicia uno manualmente o pídeselo a Jarvis.</div>
            <HudBtn onClick={() => setShowForm(true)}>Nuevo cronómetro</HudBtn>
          </div>
        )}

        {chronos.length > 0 && (
          <div className="timer-list">
            {chronos.map((c) => (
              <ChronoCard
                key={c.id}
                entry={c}
                onStart={() => start(c.id)}
                onPause={() => pause(c.id)}
                onReset={() => reset(c.id)}
                onLap={() => lap(c.id)}
                onCancel={() => cancel(c.id)}
              />
            ))}
            {!showForm && (
              <HudBtn onClick={() => setShowForm(true)}>+ Nuevo cronómetro</HudBtn>
            )}
          </div>
        )}

        {showForm && (
          <div className="timer-form">
            <div className="timer-form-row">
              <label className="timer-form-label">ETIQUETA</label>
              <input
                className="timer-input"
                placeholder="Carrera, sesión, llamada…"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                maxLength={32}
                autoFocus
              />
            </div>
            <div className="timer-form-actions">
              <HudBtn onClick={submit}>Iniciar</HudBtn>
              {chronos.length > 0 && <HudBtn onClick={() => setShowForm(false)}>Cancelar</HudBtn>}
            </div>
          </div>
        )}
      </div>
    </HudPanel>
  )
}

interface ChronoCardProps {
  entry: ChronoEntry
  onStart: () => void
  onPause: () => void
  onReset: () => void
  onLap: () => void
  onCancel: () => void
}

function ChronoCard({ entry, onStart, onPause, onReset, onLap, onCancel }: ChronoCardProps) {
  const display = formatChrono(entry.elapsedMs)
  const statusLabel = entry.status === 'running' ? 'EN CURSO' : entry.status === 'paused' ? 'EN PAUSA' : 'LISTO'
  const ringColor = entry.status === 'running' ? '#00f0ff' : entry.status === 'paused' ? '#ffd700' : 'rgba(200,244,255,0.4)'
  return (
    <div className="timer-card">
      <div className="chrono-card-display">
        <div className="chrono-card-label">{entry.label}</div>
        <div
          className="chrono-card-time"
          style={{ color: ringColor, textShadow: `0 0 12px ${ringColor}66` }}
        >
          {display}
        </div>
        <div className="chrono-card-status">{statusLabel}</div>
      </div>
      <div className="timer-card-actions">
        <div className="timer-card-buttons">
          {entry.status !== 'running' && <HudBtn onClick={onStart}>{entry.status === 'paused' ? 'Reanudar' : 'Iniciar'}</HudBtn>}
          {entry.status === 'running' && <HudBtn onClick={onPause}>Pausa</HudBtn>}
          {entry.status === 'running' && <HudBtn onClick={onLap}>Vuelta</HudBtn>}
          <HudBtn onClick={onReset}>Reiniciar</HudBtn>
          <HudBtn onClick={onCancel}>Cancelar</HudBtn>
        </div>
        {entry.laps.length > 0 && (
          <div className="chrono-laps">
            {entry.laps.slice(-6).reverse().map((ms, i) => {
              const idx = entry.laps.length - i
              const prev = idx >= 2 ? entry.laps[idx - 2] : 0
              const split = ms - prev
              return (
                <div key={idx} className="chrono-lap-row">
                  <span className="chrono-lap-idx">#{idx}</span>
                  <span className="chrono-lap-split">{formatChrono(split)}</span>
                  <span className="chrono-lap-total">{formatChrono(ms)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
