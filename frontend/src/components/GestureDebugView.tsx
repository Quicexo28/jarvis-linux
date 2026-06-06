import { useEffect, useRef, useState, useCallback } from 'react'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { GesturePipeline, type PipelineDebugFrame } from '../gestures/pipeline'
import type { Vec3 } from '../gestures/types'

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17],
]

export function GestureDebugView({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const pipelineRef = useRef<GesturePipeline | null>(null)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)

  const [frame, setFrame] = useState<PipelineDebugFrame | null>(null)
  const [status, setStatus] = useState<string>('Iniciando...')
  const [snapshots, setSnapshots] = useState<string[]>([])
  const [screenLandmarks, setScreenLandmarks] = useState<{ left: Vec3[] | null; right: Vec3[] | null }>({ left: null, right: null })

  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        setStatus('Cargando WASM...')
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        )
        if (cancelled) return

        setStatus('Cargando modelo...')
        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: 'models/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        })
        if (cancelled) { landmarker.close(); return }
        landmarkerRef.current = landmarker

        setStatus('Abriendo camara...')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); landmarker.close(); return }
        streamRef.current = stream

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }

        pipelineRef.current = new GesturePipeline()
        setStatus('Activo')

        function loop() {
          if (cancelled) return
          rafRef.current = requestAnimationFrame(loop)

          const now = performance.now()
          if (now - lastFrameRef.current < 33) return
          lastFrameRef.current = now

          if (!landmarkerRef.current || !videoRef.current || !pipelineRef.current) return
          if (videoRef.current.readyState < 2) return

          const results = landmarkerRef.current.detectForVideo(videoRef.current, now)

          let leftLandmarks: Vec3[] | null = null
          let rightLandmarks: Vec3[] | null = null
          let leftScreen: Vec3[] | null = null
          let rightScreen: Vec3[] | null = null

          if (results.worldLandmarks && results.handedness) {
            for (let i = 0; i < results.handedness.length; i++) {
              const label = results.handedness[i][0]?.categoryName
              const world = results.worldLandmarks[i] as Vec3[]
              const screen = (results.landmarks?.[i] ?? null) as Vec3[] | null
              if (label === 'Left') { leftLandmarks = world; leftScreen = screen }
              else if (label === 'Right') { rightLandmarks = world; rightScreen = screen }
            }
          }

          setScreenLandmarks({ left: leftScreen, right: rightScreen })
          const debugFrame = pipelineRef.current.processDebug(leftLandmarks, rightLandmarks, now)
          setFrame(debugFrame)
        }

        loop()
      } catch (e: any) {
        setStatus(`Error: ${e.message}`)
      }
    }

    init()
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      landmarkerRef.current?.close()
    }
  }, [])

  // Draw landmarks on canvas overlay
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const drawHand = (landmarks: Vec3[] | null, color: string) => {
      if (!landmarks) return
      // Draw connections
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      for (const [a, b] of CONNECTIONS) {
        const pa = landmarks[a]
        const pb = landmarks[b]
        ctx.beginPath()
        ctx.moveTo(pa.x * canvas.width, pa.y * canvas.height)
        ctx.lineTo(pb.x * canvas.width, pb.y * canvas.height)
        ctx.stroke()
      }
      // Draw joints
      for (let i = 0; i < landmarks.length; i++) {
        const p = landmarks[i]
        ctx.beginPath()
        ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2)
        ctx.fillStyle = i === 0 ? '#fff' : color
        ctx.fill()
      }
    }

    drawHand(screenLandmarks.left, '#00f0ff')
    drawHand(screenLandmarks.right, '#64ffda')
  }, [screenLandmarks])

  const captureSnapshot = useCallback(() => {
    if (!frame) return
    const snap = JSON.stringify({
      timestamp: new Date().toISOString(),
      leftLandmarks: frame.leftLandmarks,
      rightLandmarks: frame.rightLandmarks,
      leftFeatures: frame.leftFeatures,
      rightFeatures: frame.rightFeatures,
      leftState: frame.leftState,
      rightState: frame.rightState,
      gesture: frame.gesture,
      modifier: frame.modifier,
      output: frame.output,
    }, null, 2)
    setSnapshots(prev => [...prev, snap])
    navigator.clipboard.writeText(snap)
  }, [frame])

  const exportAll = useCallback(() => {
    const blob = new Blob([snapshots.join('\n---\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gesture-debug-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [snapshots])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0e14', zIndex: 9999, overflow: 'auto', fontFamily: "'Space Grotesk', monospace" }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid #ffffff15' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, letterSpacing: '2px', color: '#00f0ff' }}>GESTURE DEBUG</span>
          <span style={{ fontSize: 10, color: status === 'Activo' ? '#64ffda' : '#ffd700' }}>{status}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={captureSnapshot} style={btnStyle('#00f0ff')}>
            CAPTURAR ({snapshots.length})
          </button>
          {snapshots.length > 0 && (
            <button onClick={exportAll} style={btnStyle('#64ffda')}>EXPORTAR</button>
          )}
          <button onClick={onClose} style={btnStyle('#ff5252')}>CERRAR</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, padding: 16, height: 'calc(100vh - 56px)' }}>
        {/* Left: camera + landmarks */}
        <div style={{ flex: '0 0 400px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ position: 'relative', width: 400, height: 300, borderRadius: 8, overflow: 'hidden', border: '1px solid #ffffff22' }}>
            <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} muted playsInline />
            <canvas ref={canvasRef} width={640} height={480} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'scaleX(-1)' }} />
            {/* Detection badges */}
            <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6 }}>
              <DetectBadge label="IZQ" detected={frame?.leftLandmarks != null} />
              <DetectBadge label="DER" detected={frame?.rightLandmarks != null} />
            </div>
          </div>

          {/* Gesture result big */}
          <div style={{ display: 'flex', gap: 8 }}>
            <GestureBig label="IZQUIERDA" gesture={frame?.gesture.left ?? 'idle'} detected={frame?.leftLandmarks != null} />
            <GestureBig label="DERECHA" gesture={frame?.gesture.right ?? 'idle'} detected={frame?.rightLandmarks != null} />
          </div>

          {/* Output summary */}
          {frame && <OutputSummary output={frame.output} />}
        </div>

        {/* Right: data panels */}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <DataPanel title="FEATURES IZQ" data={frame?.leftFeatures} />
            <DataPanel title="FEATURES DER" data={frame?.rightFeatures} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <DataPanel title="STATE IZQ" data={frame?.leftState} />
            <DataPanel title="STATE DER" data={frame?.rightState} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <DataPanel title="MODIFIER" data={frame?.modifier} />
            <DataPanel title="OUTPUT" data={frame?.output ? { grab: frame.output.grab, point: frame.output.point, pinch: frame.output.pinch, click: frame.output.click, back: frame.output.back } : null} />
          </div>

          {/* Last snapshot preview */}
          {snapshots.length > 0 && (
            <div style={{ background: '#0d1117', border: '1px solid #ffffff15', borderRadius: 6, padding: 10, maxHeight: 200, overflow: 'auto' }}>
              <div style={{ fontSize: 8, color: '#00f0ff', marginBottom: 4, letterSpacing: '1px' }}>
                ULTIMO SNAPSHOT (copiado al clipboard)
              </div>
              <pre style={{ fontSize: 9, color: '#c8f4ff', whiteSpace: 'pre-wrap', margin: 0 }}>
                {snapshots[snapshots.length - 1]?.slice(0, 2000)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DetectBadge({ label, detected }: { label: string; detected: boolean }) {
  return (
    <span style={{
      fontSize: 9, padding: '2px 6px', borderRadius: 3,
      background: detected ? 'rgba(100,255,218,0.2)' : 'rgba(255,82,82,0.2)',
      color: detected ? '#64ffda' : '#ff5252',
      border: `1px solid ${detected ? '#64ffda44' : '#ff525244'}`,
    }}>
      {label}: {detected ? 'OK' : 'NO'}
    </span>
  )
}

function GestureBig({ label, gesture, detected }: { label: string; gesture: string; detected: boolean }) {
  return (
    <div style={{
      flex: 1, padding: '10px 12px', borderRadius: 6,
      border: `1px solid ${detected ? '#00f0ff33' : '#ffffff11'}`,
      background: detected ? 'rgba(0,240,255,0.04)' : '#0d1117',
    }}>
      <div style={{ fontSize: 8, color: 'var(--text-dim, #888)', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, color: gesture !== 'idle' ? '#00f0ff' : '#555', fontWeight: 600, letterSpacing: '0.05em' }}>
        {gesture.toUpperCase()}
      </div>
    </div>
  )
}

function OutputSummary({ output }: { output: PipelineDebugFrame['output'] }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <MiniStat label="GRAB" value={output.grab.active ? `dX:${output.grab.deltaX.toFixed(2)} dY:${output.grab.deltaY.toFixed(2)}` : 'off'} active={output.grab.active} />
      <MiniStat label="POINT" value={output.point.active ? `${output.point.screenX.toFixed(2)},${output.point.screenY.toFixed(2)}` : 'off'} active={output.point.active} />
      <MiniStat label="ZOOM" value={`${output.pinch.zoom.toFixed(2)}${output.pinch.paused ? ' P' : ''}`} active={output.pinch.active} />
      <MiniStat label="CLICK" value={output.click ? 'YES' : '-'} active={output.click} />
      <MiniStat label="BACK" value={output.back ? 'YES' : '-'} active={output.back} />
    </div>
  )
}

function MiniStat({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div style={{
      padding: '4px 8px', borderRadius: 4, fontSize: 9,
      border: `1px solid ${active ? '#00f0ff44' : '#ffffff11'}`,
      background: active ? 'rgba(0,240,255,0.06)' : 'transparent',
      color: active ? '#00f0ff' : '#666',
    }}>
      <span style={{ fontSize: 7, opacity: 0.6 }}>{label} </span>{value}
    </div>
  )
}

function DataPanel({ title, data }: { title: string; data: any }) {
  return (
    <div style={{ flex: 1, background: '#0d1117', border: '1px solid #ffffff12', borderRadius: 6, padding: 10, minWidth: 0 }}>
      <div style={{ fontSize: 8, letterSpacing: '1.5px', color: '#00f0ff', opacity: 0.7, marginBottom: 6 }}>{title}</div>
      {data ? (
        <pre style={{ fontSize: 9, color: '#c8f4ff', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5 }}>
          {formatData(data)}
        </pre>
      ) : (
        <span style={{ fontSize: 9, color: '#555' }}>null</span>
      )}
    </div>
  )
}

function formatData(obj: any): string {
  if (typeof obj !== 'object' || obj === null) return String(obj)
  const lines: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const inner = Object.entries(v).map(([ik, iv]) =>
        `${ik}: ${typeof iv === 'number' ? (iv as number).toFixed(4) : iv}`
      ).join(', ')
      lines.push(`${k}: { ${inner} }`)
    } else if (typeof v === 'number') {
      lines.push(`${k}: ${v.toFixed(4)}`)
    } else if (typeof v === 'boolean') {
      lines.push(`${k}: ${v}`)
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`)
    }
  }
  return lines.join('\n')
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: 'transparent', border: `1px solid ${color}55`, color,
    fontSize: 9, letterSpacing: '0.1em', padding: '5px 12px',
    borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
  }
}
