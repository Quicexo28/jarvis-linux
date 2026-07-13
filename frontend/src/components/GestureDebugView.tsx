// Panel de debug de gestos v2: consume el pipeline COMPARTIDO (video +
// landmarks del gestureStore, publicados por useGesturePipeline cuando este
// panel está abierto). No abre segunda cámara ni segundo landmarker — la v1
// duplicaba la inferencia y el stream PipeWire.
import { useEffect, useRef, useState, useCallback } from 'react'
import { useGestureStore } from '../state/gestureStore'
import { getGestureVideo } from '../gestures/cameraFeed'
import type { Vec3 } from '../gestures/types'

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

export function GestureDebugView({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)

  const enabled = useGestureStore(s => s.enabled)
  const setEnabled = useGestureStore(s => s.setEnabled)
  const status = useGestureStore(s => s.status)
  const statusDetail = useGestureStore(s => s.statusDetail)
  const fps = useGestureStore(s => s.fps)
  const output = useGestureStore(s => s.output)
  const [snapshots, setSnapshots] = useState<string[]>([])

  // Video + esqueletos en un solo canvas, espejado para que se sienta selfie.
  // Los landmarks vienen post-swap: left = mano IZQUIERDA física.
  useEffect(() => {
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const video = getGestureVideo()
      ctx.save()
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
      if (video && video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      } else {
        ctx.fillStyle = '#0a0e14'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }

      const frame = useGestureStore.getState().debugFrame
      const drawHand = (landmarks: Vec3[] | null, color: string) => {
        if (!landmarks) return
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        for (const [a, b] of CONNECTIONS) {
          const pa = landmarks[a]
          const pb = landmarks[b]
          if (!pa || !pb) continue
          ctx.beginPath()
          ctx.moveTo(pa.x * canvas.width, pa.y * canvas.height)
          ctx.lineTo(pb.x * canvas.width, pb.y * canvas.height)
          ctx.stroke()
        }
        for (let i = 0; i < landmarks.length; i++) {
          const p = landmarks[i]
          ctx.beginPath()
          ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2)
          ctx.fillStyle = i === 0 ? '#fff' : color
          ctx.fill()
        }
      }
      drawHand(frame?.left ?? null, '#00f0ff')
      drawHand(frame?.right ?? null, '#64ffda')
      ctx.restore()
    }
    draw()
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  const captureSnapshot = useCallback(() => {
    const snap = JSON.stringify({
      timestamp: new Date().toISOString(),
      debugFrame: useGestureStore.getState().debugFrame,
      output: useGestureStore.getState().output,
    }, null, 2)
    setSnapshots(prev => [...prev, snap])
    navigator.clipboard.writeText(snap).catch(() => {})
  }, [])

  const exportAll = useCallback(() => {
    const blob = new Blob([snapshots.join('\n---\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gesture-debug-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [snapshots])

  const statusText =
    status === 'running' ? `Activo · ${statusDetail} · ${fps} fps`
    : status === 'starting' ? (statusDetail || 'Iniciando…')
    : status === 'error' ? `Error: ${statusDetail}`
    : 'Pipeline apagado'

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0e14', zIndex: 9999, overflow: 'auto', fontFamily: "'Space Grotesk', monospace" }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid #ffffff15' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, letterSpacing: '2px', color: '#00f0ff' }}>GESTURE DEBUG</span>
          <span style={{ fontSize: 10, color: status === 'running' ? '#64ffda' : status === 'error' ? '#ff5252' : '#ffd700' }}>
            {statusText}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!enabled && (
            <button onClick={() => setEnabled(true)} style={btnStyle('#64ffda')}>ACTIVAR GESTOS</button>
          )}
          <button onClick={captureSnapshot} style={btnStyle('#00f0ff')}>CAPTURAR ({snapshots.length})</button>
          {snapshots.length > 0 && (
            <button onClick={exportAll} style={btnStyle('#64ffda')}>EXPORTAR</button>
          )}
          <button onClick={onClose} style={btnStyle('#ff5252')}>CERRAR</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, padding: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 480px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ position: 'relative', width: 480, height: 270, borderRadius: 8, overflow: 'hidden', border: '1px solid #ffffff22', background: '#000' }}>
            <canvas ref={canvasRef} width={480} height={270} style={{ width: '100%', height: '100%' }} />
            <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6 }}>
              <DetectBadge label="IZQ" detected={output.debug.leftDetected} />
              <DetectBadge label="DER" detected={output.debug.rightDetected} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <GestureBig label="IZQUIERDA" gesture={output.debug.leftGesture} detected={output.debug.leftDetected} />
            <GestureBig label="DERECHA" gesture={output.debug.rightGesture} detected={output.debug.rightDetected} />
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <DataPanel title="OUTPUT" data={{
            grab: output.grab,
            point: output.point,
            pinch: output.pinch,
            click: output.click,
            back: output.back,
          }} />
          <div style={{ fontSize: 9, color: '#8899aa', lineHeight: 1.6 }}>
            Mano IZQUIERDA física: puño = arrastrar/rotar · índice = cursor · V abierta y soltar = click · V cerrada y soltar = back.<br />
            Mano DERECHA física: pinch pulgar-índice = zoom (abrir acerca, cerrar aleja; abre la mano para soltar).
          </div>
        </div>
      </div>
    </div>
  )
}

function DetectBadge({ label, detected }: { label: string; detected: boolean }) {
  return (
    <span style={{
      fontSize: 9, letterSpacing: '0.1em', padding: '2px 8px', borderRadius: 3,
      background: detected ? '#64ffda22' : '#ff525222',
      color: detected ? '#64ffda' : '#ff5252',
      border: `1px solid ${detected ? '#64ffda55' : '#ff525255'}`,
    }}>
      {label}
    </span>
  )
}

function GestureBig({ label, gesture, detected }: { label: string; gesture: string; detected: boolean }) {
  return (
    <div style={{ flex: 1, padding: '10px 14px', borderRadius: 6, border: '1px solid #ffffff18', background: detected ? 'rgba(0,240,255,0.05)' : 'transparent' }}>
      <div style={{ fontSize: 8, letterSpacing: '0.15em', color: '#8899aa', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontFamily: 'monospace', color: detected ? '#00f0ff' : '#445566' }}>
        {detected ? gesture.toUpperCase() : '---'}
      </div>
    </div>
  )
}

function DataPanel({ title, data }: { title: string; data: unknown }) {
  return (
    <div style={{ border: '1px solid #ffffff15', borderRadius: 6, padding: 10 }}>
      <div style={{ fontSize: 9, letterSpacing: '0.15em', color: '#00f0ff', marginBottom: 6 }}>{title}</div>
      <pre style={{ fontSize: 10, color: '#a8c0d0', margin: 0, whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(data, (_k, v) => typeof v === 'number' ? Number(v.toFixed(4)) : v, 2)}
      </pre>
    </div>
  )
}

function btnStyle(color: string): React.CSSProperties {
  return {
    fontSize: 10, letterSpacing: '0.1em', padding: '6px 12px',
    background: 'transparent', border: `1px solid ${color}66`,
    color, borderRadius: 4, cursor: 'pointer',
  }
}
