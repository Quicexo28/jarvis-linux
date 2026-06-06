import { useEffect, useRef, useState } from 'react'
import { HudPanel } from './HudPanel'
import { HudBtn } from './HudBtn'
import { TimerDial } from './TimerDial'
import { useTimerStore, formatHms, startTimerTicker, type TimerEntry } from '../state/timerStore'
import type { CSSProperties } from 'react'

interface TimerPanelProps {
  exiting?: boolean
  style?: CSSProperties
}

const ADD_PRESETS_MS: ReadonlyArray<{ label: string; delta: number }> = [
  { label: '+1 min', delta: 60_000 },
  { label: '+5 min', delta: 5 * 60_000 },
  { label: '+10 min', delta: 10 * 60_000 },
]

const NEW_PRESETS_MIN: ReadonlyArray<number> = [1, 3, 5, 10, 15, 20, 30, 45, 60]

export function TimerPanel({ exiting, style }: TimerPanelProps) {
  useEffect(() => { startTimerTicker() }, [])
  const timers = useTimerStore((s) => s.timers)
  const create = useTimerStore((s) => s.create)
  const pause = useTimerStore((s) => s.pause)
  const resume = useTimerStore((s) => s.resume)
  const add = useTimerStore((s) => s.add)
  const reset = useTimerStore((s) => s.reset)
  const cancel = useTimerStore((s) => s.cancel)

  const [showForm, setShowForm] = useState<boolean>(timers.length === 0)
  const [label, setLabel] = useState('')
  const [minutes, setMinutes] = useState(5)
  const labelInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showForm && labelInputRef.current) labelInputRef.current.focus()
  }, [showForm])

  const submit = () => {
    const ms = Math.max(1, Math.round(minutes * 60_000))
    create({ label, durationMs: ms })
    setLabel('')
    setMinutes(5)
    setShowForm(false)
  }

  return (
    <HudPanel mode="Temporizador" exiting={exiting} className="mode-panel mode-panel--wide" style={style}>
      <div className="timer-panel">
        {timers.length === 0 && !showForm && (
          <div className="timer-empty">
            <div className="timer-empty-title">SIN TEMPORIZADORES</div>
            <div className="timer-empty-subtitle">Inicia uno manualmente o pídeselo a Jarvis.</div>
            <HudBtn onClick={() => setShowForm(true)}>Nuevo temporizador</HudBtn>
          </div>
        )}

        {timers.length > 0 && (
          <div className="timer-list">
            {timers.map((t) => (
              <TimerCard
                key={t.id}
                entry={t}
                onPause={() => pause(t.id)}
                onResume={() => resume(t.id)}
                onAdd={(delta) => add(t.id, delta)}
                onReset={() => reset(t.id)}
                onCancel={() => cancel(t.id)}
              />
            ))}
            {!showForm && (
              <HudBtn onClick={() => setShowForm(true)}>+ Nuevo temporizador</HudBtn>
            )}
          </div>
        )}

        {showForm && (
          <div className="timer-form">
            <div className="timer-form-row">
              <label className="timer-form-label">ETIQUETA</label>
              <input
                ref={labelInputRef}
                className="timer-input"
                placeholder="Pasta, horno, descanso…"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                maxLength={32}
              />
            </div>
            <div className="timer-form-row">
              <label className="timer-form-label">MINUTOS</label>
              <input
                className="timer-input timer-input--number"
                type="number"
                min={1}
                max={600}
                value={minutes}
                onChange={(e) => setMinutes(Math.max(1, Math.min(600, Number(e.target.value) || 1)))}
              />
            </div>
            <div className="timer-presets">
              {NEW_PRESETS_MIN.map((m) => (
                <button
                  key={m}
                  className={`timer-chip${minutes === m ? ' timer-chip--active' : ''}`}
                  onClick={() => setMinutes(m)}
                >
                  {m}m
                </button>
              ))}
            </div>
            <div className="timer-form-actions">
              <HudBtn onClick={submit}>Iniciar</HudBtn>
              {timers.length > 0 && <HudBtn onClick={() => setShowForm(false)}>Cancelar</HudBtn>}
            </div>
          </div>
        )}
      </div>
    </HudPanel>
  )
}

interface TimerCardProps {
  entry: TimerEntry
  onPause: () => void
  onResume: () => void
  onAdd: (deltaMs: number) => void
  onReset: () => void
  onCancel: () => void
}

function TimerCard({ entry, onPause, onResume, onAdd, onReset, onCancel }: TimerCardProps) {
  const progress = entry.durationMs > 0 ? entry.remainingMs / entry.durationMs : 0
  return (
    <div className={`timer-card${entry.status === 'done' ? ' timer-card--done' : ''}`}>
      <div className="timer-card-dial">
        <TimerDial
          progress={progress}
          display={formatHms(entry.remainingMs)}
          label={entry.label}
          status={entry.status}
        />
      </div>
      <div className="timer-card-actions">
        <div className="timer-presets">
          {ADD_PRESETS_MS.map((p) => (
            <button key={p.label} className="timer-chip" onClick={() => onAdd(p.delta)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="timer-card-buttons">
          {entry.status === 'running' && <HudBtn onClick={onPause}>Pausa</HudBtn>}
          {entry.status === 'paused' && <HudBtn onClick={onResume}>Reanudar</HudBtn>}
          {entry.status === 'done' && <HudBtn onClick={() => onAdd(60_000)}>+1 min</HudBtn>}
          <HudBtn onClick={onReset}>Reiniciar</HudBtn>
          <HudBtn onClick={onCancel}>Cancelar</HudBtn>
        </div>
      </div>
    </div>
  )
}
