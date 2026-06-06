import { useEffect } from 'react'
import type { SavedPlan } from '../types'

interface PlanSelectorOverlayProps {
  plans: SavedPlan[]
  onSelect: (key: string) => void
  onSkip: () => void
}

export function PlanSelectorOverlay({ plans, onSelect, onSkip }: PlanSelectorOverlayProps) {
  useEffect(() => {
    if (plans.length === 0) onSkip()
  }, [plans.length, onSkip])

  if (plans.length === 0) return null

  return (
    <div className="plan-selector-backdrop">
      <div className="glass plan-selector-panel jarvis-hud-enter">
        <div style={{ fontSize: 9, letterSpacing: '2px', color: 'var(--primary)', opacity: 0.7, marginBottom: 4 }}>
          SELECCIONAR PLANO
        </div>
        <div className="plan-selector-list">
          {plans.slice(0, 8).map(p => {
            const key = `${p.room}::${p.name}`
            return (
              <button key={key} className="hud-btn" onClick={() => onSelect(key)}>
                <span className="hud-btn-ind">●</span>
                <span className="hud-btn-label">{p.room} · {p.name}</span>
              </button>
            )
          })}
        </div>
        <button className="hud-btn" onClick={onSkip} style={{ marginTop: 8 }}>
          <span className="hud-btn-label">Continuar sin plano</span>
        </button>
      </div>
    </div>
  )
}
