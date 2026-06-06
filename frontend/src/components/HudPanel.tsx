import type { ReactNode, CSSProperties } from 'react'

interface HudPanelProps {
  mode: string
  children: ReactNode
  className?: string
  style?: CSSProperties
  exiting?: boolean
}

export function HudPanel({ mode, children, className = '', style, exiting }: HudPanelProps) {
  const cls = `hud-panel${className ? ` ${className}` : ''}${exiting ? ' hud-panel--exiting' : ''}`
  return (
    <div className={cls} style={style}>
      <div className="hud-border-top" />
      <div className="hud-border-right" />
      <div className="hud-border-bottom" />
      <div className="hud-border-left" />
      {mode && (
        <>
          <div className="hud-panel-header">
            <span>◈</span>
            <span>{mode.toUpperCase()}</span>
          </div>
          <div className="hud-panel-sep" />
        </>
      )}
      <div className="hud-panel-content">
        {children}
      </div>
    </div>
  )
}
