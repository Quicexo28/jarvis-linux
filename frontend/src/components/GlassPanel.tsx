import type { ReactNode, CSSProperties } from 'react'

interface Props {
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function GlassPanel({ children, className = '', style }: Props) {
  return (
    <div className={`glass ${className}`} style={style}>
      {children}
    </div>
  )
}
