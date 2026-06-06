interface TimerDialProps {
  progress: number          // 0..1 where 1 = full remaining, 0 = done
  size?: number
  label?: string
  display: string           // formatted time, e.g. "05:23"
  status: 'running' | 'paused' | 'done'
}

export function TimerDial({ progress, size = 220, label, display, status }: TimerDialProps) {
  const stroke = 8
  const r = (size - stroke * 2) / 2
  const cx = size / 2
  const cy = size / 2
  const circumference = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(1, progress))
  const dash = circumference * clamped
  const ringColor = status === 'done' ? '#ff8a00' : status === 'paused' ? '#ffd700' : '#00f0ff'

  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <radialGradient id="dial-bg" cx="50%" cy="50%" r="50%">
            <stop offset="60%" stopColor="rgba(0,240,255,0.02)" />
            <stop offset="100%" stopColor="rgba(0,240,255,0.10)" />
          </radialGradient>
          <filter id="dial-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle cx={cx} cy={cy} r={r} fill="url(#dial-bg)" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(0,240,255,0.10)" strokeWidth={stroke} />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={ringColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: 'stroke-dasharray 0.25s linear, stroke 0.2s' }}
          filter="url(#dial-glow)"
        />
        {Array.from({ length: 60 }).map((_, i) => {
          const a = (i / 60) * Math.PI * 2 - Math.PI / 2
          const inner = r - stroke / 2 - 6
          const outer = inner + (i % 5 === 0 ? 8 : 4)
          const x1 = cx + Math.cos(a) * inner
          const y1 = cy + Math.sin(a) * inner
          const x2 = cx + Math.cos(a) * outer
          const y2 = cy + Math.sin(a) * outer
          return (
            <line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="rgba(0,240,255,0.25)"
              strokeWidth={i % 5 === 0 ? 1.2 : 0.5}
            />
          )
        })}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, zIndex: 1 }}>
        {label && (
          <div style={{ fontSize: 10, letterSpacing: '0.2em', color: 'rgba(200,244,255,0.55)', textTransform: 'uppercase' }}>
            {label}
          </div>
        )}
        <div
          style={{
            fontSize: size * 0.22,
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 300,
            letterSpacing: '0.04em',
            color: ringColor,
            textShadow: `0 0 12px ${ringColor}88`,
            lineHeight: 1,
          }}
        >
          {display}
        </div>
        <div style={{ fontSize: 9, letterSpacing: '0.3em', color: 'rgba(200,244,255,0.4)', textTransform: 'uppercase' }}>
          {status === 'done' ? 'FINALIZADO' : status === 'paused' ? 'EN PAUSA' : 'EN CURSO'}
        </div>
      </div>
    </div>
  )
}
