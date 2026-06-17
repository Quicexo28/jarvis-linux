import { useState, useEffect, useRef, useCallback } from 'react'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { GesturePipeline } from '../gestures/pipeline'
import { getApiBase } from '../api/client'
import type { Vec3 } from '../gestures/types'

const WASM_URL   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
const MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
const FRAME_MS   = 100  // 10 fps — enough for gesture control without flooding the skill bus

type Status = 'idle' | 'loading' | 'ready' | 'error'

const BASE: React.CSSProperties = {
  background: 'transparent', border: '1px solid #ffffff22', borderRadius: 3,
  color: '#ccd6f6', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace',
}

const S: Record<string, React.CSSProperties> = {
  wrap:       { padding: '12px 16px', borderBottom: '1px solid #ffffff11' },
  row:        { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionLabel: { fontSize: 9, letterSpacing: '2px', color: '#00e5ff', opacity: 0.7 },
  toggleBtn:  { ...BASE, border: '1px solid #00e5ff66', color: '#00e5ff', padding: '5px 12px' },
  statusRow:  { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  statusText: { opacity: 0.5, fontSize: 11, fontFamily: 'monospace' },
  gestureBox: { marginTop: 10, padding: '10px 14px', background: '#00e5ff0a', border: '1px solid #00e5ff22', borderRadius: 3 },
  gestureLabel: { fontSize: 9, letterSpacing: '2px', color: '#00e5ff', opacity: 0.6, marginBottom: 4 },
  gestureName:  { fontSize: 18, color: '#00e5ff', fontFamily: 'monospace', letterSpacing: '2px' },
  errorText:  { fontSize: 11, color: '#ff6b6b', opacity: 0.8, marginTop: 4 },
}

function dot(color: string): React.CSSProperties {
  return { width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}`, flexShrink: 0 }
}

export function MobileGestureCamera() {
  const [enabled, setEnabled]   = useState(false)
  const [status, setStatus]     = useState<Status>('idle')
  const [gesture, setGesture]   = useState('—')
  const [errorMsg, setErrorMsg] = useState('')
  const cleanupRef              = useRef<() => void>(() => {})

  const stopAll = useCallback(() => {
    cleanupRef.current()
    cleanupRef.current = () => {}
  }, [])

  useEffect(() => {
    if (!enabled) {
      stopAll()
      setStatus('idle')
      setGesture('—')
      setErrorMsg('')
      return
    }

    let cancelled = false

    async function start() {
      setStatus('loading')
      setErrorMsg('')

      // Open WS first — desktop must be reachable
      const wsUrl = `${getApiBase().replace(/^http/, 'ws')}/api/mobile/gesture/ws`
      const ws = new WebSocket(wsUrl)

      try {
        // Load MediaPipe WASM from CDN
        const vision = await FilesetResolver.forVisionTasks(WASM_URL)
        if (cancelled) { ws.close(); return }

        // Try GPU delegate, fall back to CPU for devices without WebGL compute
        let handLandmarker: HandLandmarker
        try {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numHands: 2,
          })
        } catch {
          handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
            runningMode: 'VIDEO',
            numHands: 2,
          })
        }
        if (cancelled) { handLandmarker.close(); ws.close(); return }

        // Open front camera — user faces the phone, hands in frame
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: 320, height: 240 },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); handLandmarker.close(); ws.close(); return }

        const video = document.createElement('video')
        video.srcObject = stream
        video.autoplay = true
        video.playsInline = true
        video.muted = true
        video.style.display = 'none'
        document.body.appendChild(video)
        await video.play()
        if (cancelled) { video.remove(); stream.getTracks().forEach(t => t.stop()); handLandmarker.close(); ws.close(); return }

        const pipeline = new GesturePipeline()
        let lastFrameTime = 0
        let rafId = 0

        function loop() {
          if (cancelled) return
          rafId = requestAnimationFrame(loop)
          const now = performance.now()
          if (now - lastFrameTime < FRAME_MS) return
          lastFrameTime = now
          if (video.readyState < 2) return

          const results = handLandmarker.detectForVideo(video, now)
          let leftLandmarks: Vec3[] | null = null
          let rightLandmarks: Vec3[] | null = null

          if (results.worldLandmarks && results.handedness) {
            for (let i = 0; i < results.handedness.length; i++) {
              const label = results.handedness[i][0]?.categoryName
              const lm = results.worldLandmarks[i] as Vec3[]
              if (label === 'Left') leftLandmarks = lm
              else if (label === 'Right') rightLandmarks = lm
            }
          }

          const output = pipeline.process(leftLandmarks, rightLandmarks, now)

          const name =
            output.grab.active   ? 'grab'   :
            output.point.active  ? 'point'  :
            output.pinch.active  ? 'pinch'  :
            output.click         ? 'click'  :
            output.back          ? 'back'   :
            output.debug.leftGesture  !== 'idle' ? output.debug.leftGesture  :
            output.debug.rightGesture !== 'idle' ? output.debug.rightGesture : 'idle'

          setGesture(name === 'idle' ? '—' : name)

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(output))
          }
        }

        setStatus('ready')
        loop()

        cleanupRef.current = () => {
          cancelAnimationFrame(rafId)
          video.remove()
          stream.getTracks().forEach(t => t.stop())
          handLandmarker.close()
          try { ws.close() } catch {}
        }
      } catch (e) {
        try { ws.close() } catch {}
        if (!cancelled) {
          console.error('[mobile-gesture]', e)
          setStatus('error')
          setErrorMsg(e instanceof Error ? e.message : 'Error al iniciar cámara')
        }
      }
    }

    start()

    return () => {
      cancelled = true
      stopAll()
    }
  }, [enabled, stopAll])

  const dotColor =
    status === 'ready'   ? '#64ffda' :
    status === 'loading' ? '#f0c040' :
    status === 'error'   ? '#ff6b6b' : '#444'

  return (
    <div style={S.wrap}>
      <div style={S.row}>
        <span style={S.sectionLabel}>CÁMARA GESTOS</span>
        <button style={S.toggleBtn} onClick={() => setEnabled(e => !e)}>
          {enabled ? 'APAGAR' : 'ACTIVAR'}
        </button>
      </div>

      {enabled && (
        <>
          <div style={S.statusRow}>
            <div style={dot(dotColor)} />
            <span style={S.statusText}>
              {status === 'loading' ? 'cargando MediaPipe...' :
               status === 'ready'   ? 'detectando gestos' :
               status === 'error'   ? 'error' : ''}
            </span>
          </div>

          {status === 'error' && <div style={S.errorText}>{errorMsg}</div>}

          {status === 'ready' && (
            <div style={S.gestureBox}>
              <div style={S.gestureLabel}>GESTO ACTIVO</div>
              <div style={S.gestureName}>{gesture}</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
