import { useEffect, useState } from 'react'
import { useGestureStore } from '../state/gestureStore'

export function GestureMonitor() {
  const enabled = useGestureStore(s => s.enabled)
  const output = useGestureStore(s => s.output)
  const [clickFlash, setClickFlash] = useState(false)
  const [backFlash, setBackFlash] = useState(false)

  useEffect(() => {
    if (output.click) { setClickFlash(true); setTimeout(() => setClickFlash(false), 300) }
  }, [output.click])

  useEffect(() => {
    if (output.back) { setBackFlash(true); setTimeout(() => setBackFlash(false), 300) }
  }, [output.back])

  const { debug } = output
  const anyActive = output.grab.active || output.point.active || output.pinch.active
  const zoomPct = ((output.pinch.zoom - 0.5) / 2.5) * 100
  const crossSize = 56

  const grabCx = crossSize / 2 + Math.max(-1, Math.min(1, output.grab.deltaX)) * (crossSize / 2 - 4)
  const grabCy = crossSize / 2 + Math.max(-1, Math.min(1, output.grab.deltaY)) * (crossSize / 2 - 4)

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 9, letterSpacing: '2px', color: 'var(--primary, #00f0ff)', opacity: 0.7, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        GESTOS
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: !enabled ? '#555' : anyActive ? '#64ffda' : '#00f0ff44',
          boxShadow: anyActive ? '0 0 6px #64ffda' : 'none',
          display: 'inline-block',
        }} />
      </div>

      {!enabled ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', opacity: 0.7 }}>Gestos desactivados.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Hand detection status */}
          <div style={{ display: 'flex', gap: 16 }}>
            <HandIndicator label="IZQUIERDA" detected={debug.leftDetected} gesture={debug.leftGesture} />
            <HandIndicator label="DERECHA" detected={debug.rightDetected} gesture={debug.rightGesture} />
          </div>

          {/* Active gesture badges */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {(['grab', 'point', 'peace_sep', 'peace_close'] as const).map(g => {
              const active = debug.leftGesture === g
              return (
                <GestureBadge key={`L:${g}`} label={`L:${g.replace('_', ' ')}`} active={active} />
              )
            })}
            <GestureBadge label="R:pinch" active={debug.rightGesture === 'pinch'} />
          </div>

          {/* Zoom bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 8, color: 'var(--text-dim)', width: 34 }}>ZOOM</span>
            <div style={{ flex: 1, height: 8, background: '#ffffff11', borderRadius: 4, position: 'relative', overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${Math.max(0, Math.min(100, zoomPct))}%`,
                background: output.pinch.paused ? '#ffd700' : 'linear-gradient(90deg, #00f0ff, #64ffda)',
                borderRadius: 4,
                transition: 'width 0.08s linear',
              }} />
            </div>
            <span style={{ fontSize: 9, color: 'var(--text-dim)', width: 32, textAlign: 'right', fontFamily: 'monospace' }}>
              {output.pinch.zoom.toFixed(2)}
            </span>
            {output.pinch.paused && (
              <span style={{ fontSize: 7, color: '#ffd700', letterSpacing: '0.1em', border: '1px solid #ffd70044', padding: '1px 4px', borderRadius: 2 }}>PAUSED</span>
            )}
          </div>

          {/* Crosshairs + discrete events row */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            {/* Grab crosshair */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 7, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>GRAB</span>
              <svg width={crossSize} height={crossSize} style={{ border: '1px solid #ffffff15', borderRadius: 4, background: '#00000033' }}>
                <line x1={crossSize / 2} y1={0} x2={crossSize / 2} y2={crossSize} stroke="#ffffff15" strokeWidth={0.5} />
                <line x1={0} y1={crossSize / 2} x2={crossSize} y2={crossSize / 2} stroke="#ffffff15" strokeWidth={0.5} />
                <circle cx={crossSize / 2} cy={crossSize / 2} r={crossSize / 2 - 2} fill="none" stroke="#ffffff08" strokeWidth={0.5} />
                {output.grab.active && (
                  <>
                    <circle cx={grabCx} cy={grabCy} r={4} fill="#00f0ff" opacity={0.8} />
                    <circle cx={grabCx} cy={grabCy} r={7} fill="none" stroke="#00f0ff" strokeWidth={0.5} opacity={0.4} />
                  </>
                )}
              </svg>
            </div>

            {/* Point crosshair */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 7, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>POINT</span>
              <svg width={crossSize} height={crossSize} style={{ border: '1px solid #ffffff15', borderRadius: 4, background: '#00000033' }}>
                <line x1={crossSize / 2} y1={0} x2={crossSize / 2} y2={crossSize} stroke="#ffffff15" strokeWidth={0.5} />
                <line x1={0} y1={crossSize / 2} x2={crossSize} y2={crossSize / 2} stroke="#ffffff15" strokeWidth={0.5} />
                <circle cx={crossSize / 2} cy={crossSize / 2} r={crossSize / 2 - 2} fill="none" stroke="#ffffff08" strokeWidth={0.5} />
                {output.point.active && (
                  <circle
                    cx={crossSize / 2 + output.point.screenX * (crossSize / 2 - 4)}
                    cy={crossSize / 2 + output.point.screenY * (crossSize / 2 - 4)}
                    r={4} fill="#64ffda" opacity={0.8}
                  />
                )}
              </svg>
            </div>

            {/* Discrete events */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginLeft: 4, justifyContent: 'center', paddingTop: 14 }}>
              <EventBadge label="CLICK" active={clickFlash} color="#64ffda" />
              <EventBadge label="BACK" active={backFlash} color="#ffd700" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function HandIndicator({ label, detected, gesture }: { label: string; detected: boolean; gesture: string }) {
  return (
    <div style={{
      flex: 1, padding: '6px 10px', borderRadius: 4,
      border: `1px solid ${detected ? '#00f0ff33' : '#ffffff11'}`,
      background: detected ? 'rgba(0,240,255,0.04)' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: detected ? '#64ffda' : '#ff5252',
          boxShadow: detected ? '0 0 4px #64ffda' : '0 0 4px #ff5252',
          display: 'inline-block',
        }} />
        <span style={{ fontSize: 8, letterSpacing: '0.12em', color: detected ? '#c8f4ff' : 'var(--text-dim)' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 10, color: detected ? '#00f0ff' : 'var(--text-dim)', fontFamily: 'monospace', letterSpacing: '0.05em' }}>
        {detected ? gesture.toUpperCase() : '---'}
      </div>
    </div>
  )
}

function GestureBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span style={{
      fontSize: 8, letterSpacing: '0.08em', padding: '2px 6px',
      border: `1px solid ${active ? '#00f0ff' : '#ffffff18'}`,
      borderRadius: 3,
      color: active ? '#00f0ff' : 'var(--text-dim)',
      background: active ? 'rgba(0,240,255,0.1)' : 'transparent',
      textTransform: 'uppercase',
      transition: 'all 0.1s',
    }}>
      {label}
    </span>
  )
}

function EventBadge({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <div style={{
      fontSize: 8, letterSpacing: '0.1em', padding: '4px 10px',
      borderRadius: 3, textAlign: 'center',
      border: `1px solid ${active ? color : '#ffffff11'}`,
      color: active ? color : 'var(--text-dim)',
      background: active ? `${color}18` : 'transparent',
      transition: 'all 0.12s',
    }}>
      {label}
    </div>
  )
}
