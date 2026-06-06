import type { ReactNode, CSSProperties } from 'react'

interface HudBtnProps {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
}

export function HudBtn({ children, onClick, active = false, disabled = false, className = '', style }: HudBtnProps) {
  return (
    <button
      className={`hud-btn${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      <span className="hud-btn-ind">{active ? '◆' : '◇'}</span>
      <span className="hud-btn-label">{children}</span>
      <span className="hud-btn-arrow">→</span>
    </button>
  )
}
