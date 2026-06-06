import { useEffect, useRef, useState, useCallback } from 'react'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { extractFeatures } from '../gestures/features'
import { GESTURE_CLASSES, type GestureClass } from '../gestures/ml/classes'
import {
  GestureMLModel, featuresToVector, saveDataset, loadDataset,
  exportDatasetFile, importDatasetFile, type TrainingSample, type TrainingDataset,
} from '../gestures/ml/model'
import type { Vec3, HandFeatures } from '../gestures/types'

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17],
]

export function GestureTrainer({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const rafRef = useRef(0)
  const lastFrameRef = useRef(0)
  const recordingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [status, setStatus] = useState('Iniciando...')
  const [currentFeatures, setCurrentFeatures] = useState<HandFeatures | null>(null)
  const [screenLandmarks, setScreenLandmarks] = useState<Vec3[] | null>(null)
  const [selectedClass, setSelectedClass] = useState<GestureClass>('idle')
  const selectedClassRef = useRef<GestureClass>('idle')
  const [dataset, setDataset] = useState<TrainingDataset>(() => loadDataset())
  const [recording, setRecording] = useState(false)
  const [samplesThisSession, setSamplesThisSession] = useState(0)
  const [trainProgress, setTrainProgress] = useState<string | null>(null)
  const [livePredict, setLivePredict] = useState<{ gesture: GestureClass; confidence: number } | null>(null)
  const [modelReady, setModelReady] = useState(false)
  const [handDetected, setHandDetected] = useState(false)

  const modelRef = useRef(new GestureMLModel())

  // Init MediaPipe
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        setStatus('Cargando WASM...')
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        )
        if (cancelled) return

        setStatus('Cargando modelo MediaPipe...')
        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 1,
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

        // Try load existing model
        const loaded = await modelRef.current.load()
        if (loaded) setModelReady(true)

        setStatus('Listo')

        function loop() {
          if (cancelled) return
          rafRef.current = requestAnimationFrame(loop)

          const now = performance.now()
          if (now - lastFrameRef.current < 50) return
          lastFrameRef.current = now

          if (!landmarkerRef.current || !videoRef.current) return
          if (videoRef.current.readyState < 2) return

          const results = landmarkerRef.current.detectForVideo(videoRef.current, now)

          let worldLandmarks: Vec3[] | null = null
          let normalizedLandmarks: Vec3[] | null = null

          if (results.worldLandmarks?.length) {
            worldLandmarks = results.worldLandmarks[0] as Vec3[]
            normalizedLandmarks = (results.landmarks?.[0] ?? null) as Vec3[] | null
          }

          setHandDetected(worldLandmarks !== null)
          setScreenLandmarks(normalizedLandmarks)

          if (worldLandmarks) {
            const features = extractFeatures(worldLandmarks)
            setCurrentFeatures(features)

            if (recordingRef.current) {
              setDataset(prev => {
                const sample: TrainingSample = { features: featuresToVector(features), label: selectedClassRef.current }
                const next = { ...prev, samples: [...prev.samples, sample] }
                saveDataset(next)
                return next
              })
              setSamplesThisSession(p => p + 1)
            }

            if (modelRef.current.isReady()) {
              setLivePredict(modelRef.current.predict(features))
            }
          } else {
            setCurrentFeatures(null)
            setLivePredict(null)
          }
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

  // Keep refs in sync
  useEffect(() => { recordingRef.current = recording }, [recording])
  useEffect(() => { selectedClassRef.current = selectedClass }, [selectedClass])

  // Draw landmarks
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (!screenLandmarks) return
    ctx.strokeStyle = recording ? '#ff5252' : '#00f0ff'
    ctx.lineWidth = 2
    for (const [a, b] of CONNECTIONS) {
      const pa = screenLandmarks[a]
      const pb = screenLandmarks[b]
      ctx.beginPath()
      ctx.moveTo(pa.x * canvas.width, pa.y * canvas.height)
      ctx.lineTo(pb.x * canvas.width, pb.y * canvas.height)
      ctx.stroke()
    }
    for (let i = 0; i < screenLandmarks.length; i++) {
      const p = screenLandmarks[i]
      ctx.beginPath()
      ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2)
      ctx.fillStyle = i === 0 ? '#fff' : (recording ? '#ff5252' : '#00f0ff')
      ctx.fill()
    }
  }, [screenLandmarks, recording])

  const handleTrain = useCallback(async () => {
    if (dataset.samples.length < 10) {
      setTrainProgress('Necesitas al menos 10 muestras')
      return
    }
    setTrainProgress('Entrenando...')
    try {
      const { finalLoss, finalAcc } = await modelRef.current.train(
        dataset.samples,
        (epoch, loss, acc) => {
          if (epoch % 10 === 0) setTrainProgress(`Epoch ${epoch}: loss=${loss.toFixed(4)} acc=${(acc * 100).toFixed(1)}%`)
        },
      )
      await modelRef.current.save()
      setModelReady(true)
      setTrainProgress(`Listo! Loss=${finalLoss.toFixed(4)} Acc=${(finalAcc * 100).toFixed(1)}%`)
    } catch (e: any) {
      setTrainProgress(`Error: ${e.message}`)
    }
  }, [dataset])

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const imported = await importDatasetFile(file)
      setDataset(imported)
      saveDataset(imported)
    } catch {}
  }, [])

  const classCounts = dataset.samples.reduce((acc, s) => {
    acc[s.label] = (acc[s.label] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0e14', zIndex: 9999, overflow: 'auto', fontFamily: "'Space Grotesk', monospace" }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid #ffffff15' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, letterSpacing: '2px', color: '#00f0ff' }}>GESTURE TRAINER</span>
          <span style={{ fontSize: 10, color: status === 'Listo' ? '#64ffda' : '#ffd700' }}>{status}</span>
          {modelReady && <span style={{ fontSize: 9, color: '#64ffda', border: '1px solid #64ffda44', padding: '1px 6px', borderRadius: 3 }}>MODELO ACTIVO</span>}
        </div>
        <button onClick={onClose} style={btnStyle('#ff5252')}>CERRAR</button>
      </div>

      <div style={{ display: 'flex', gap: 16, padding: 16, height: 'calc(100vh - 56px)' }}>
        {/* Left: Camera */}
        <div style={{ flex: '0 0 420px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ position: 'relative', width: 420, height: 315, borderRadius: 8, overflow: 'hidden', border: `2px solid ${recording ? '#ff5252' : '#ffffff22'}` }}>
            <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} muted playsInline />
            <canvas ref={canvasRef} width={640} height={480} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', transform: 'scaleX(-1)' }} />
            {recording && <div style={{ position: 'absolute', top: 8, right: 8, width: 12, height: 12, borderRadius: '50%', background: '#ff5252', animation: 'blink 1s infinite' }} />}
            <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 10, color: handDetected ? '#64ffda' : '#ff5252' }}>
              {handDetected ? 'Mano detectada' : 'Sin mano'}
            </div>
          </div>

          {/* Live prediction */}
          {livePredict && (
            <div style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #00f0ff33', background: 'rgba(0,240,255,0.04)' }}>
              <div style={{ fontSize: 8, color: '#00f0ff88', letterSpacing: '1px', marginBottom: 4 }}>PREDICCION EN VIVO</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 18, color: '#00f0ff', fontWeight: 600 }}>{livePredict.gesture.toUpperCase()}</span>
                <span style={{ fontSize: 11, color: '#c8f4ff88' }}>{(livePredict.confidence * 100).toFixed(0)}%</span>
              </div>
            </div>
          )}

          {/* Current features */}
          {currentFeatures && (
            <div style={{ fontSize: 9, color: '#c8f4ff88', padding: 8, background: '#0d1117', borderRadius: 4, border: '1px solid #ffffff11' }}>
              <div style={{ marginBottom: 4, color: '#00f0ff88', fontSize: 8, letterSpacing: '1px' }}>FEATURES</div>
              curl: th={currentFeatures.curl.thumb.toFixed(3)} ix={currentFeatures.curl.index.toFixed(3)} md={currentFeatures.curl.middle.toFixed(3)} rn={currentFeatures.curl.ring.toFixed(3)} pk={currentFeatures.curl.pinky.toFixed(3)}
              <br/>
              tips: thIx={currentFeatures.tipDistances.thumbIndex.toFixed(3)} ixMd={currentFeatures.tipDistances.indexMiddle.toFixed(3)} mdRn={currentFeatures.tipDistances.middleRing.toFixed(3)} rnPk={currentFeatures.tipDistances.ringPinky.toFixed(3)}
            </div>
          )}
        </div>

        {/* Right: Controls */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
          {/* Class selector */}
          <div>
            <div style={{ fontSize: 9, letterSpacing: '1.5px', color: '#00f0ff', opacity: 0.7, marginBottom: 8 }}>SELECCIONA GESTO</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {GESTURE_CLASSES.map(cls => (
                <button
                  key={cls}
                  onClick={() => setSelectedClass(cls)}
                  style={{
                    ...btnStyle(selectedClass === cls ? '#00f0ff' : '#ffffff55'),
                    background: selectedClass === cls ? 'rgba(0,240,255,0.12)' : 'transparent',
                    fontWeight: selectedClass === cls ? 600 : 400,
                  }}
                >
                  {cls.toUpperCase()}
                  {classCounts[cls] ? ` (${classCounts[cls]})` : ''}
                </button>
              ))}
            </div>
          </div>

          {/* Recording controls */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setRecording(!recording)}
              style={{
                ...btnStyle(recording ? '#ff5252' : '#64ffda'),
                padding: '8px 20px',
                fontSize: 11,
              }}
            >
              {recording ? 'PARAR GRABACION' : 'GRABAR'}
            </button>
            <span style={{ fontSize: 10, color: '#c8f4ff88' }}>
              {recording ? `Grabando "${selectedClass}"...` : 'Haz el gesto y presiona grabar'}
            </span>
            {samplesThisSession > 0 && (
              <span style={{ fontSize: 9, color: '#64ffda' }}>+{samplesThisSession} esta sesion</span>
            )}
          </div>

          {/* Dataset stats */}
          <div style={{ background: '#0d1117', border: '1px solid #ffffff12', borderRadius: 6, padding: 12 }}>
            <div style={{ fontSize: 9, letterSpacing: '1.5px', color: '#00f0ff', opacity: 0.7, marginBottom: 8 }}>DATASET ({dataset.samples.length} samples)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {GESTURE_CLASSES.map(cls => (
                <div key={cls} style={{ fontSize: 9, padding: '3px 8px', borderRadius: 3, border: '1px solid #ffffff15', color: (classCounts[cls] || 0) >= 30 ? '#64ffda' : '#c8f4ff88' }}>
                  {cls}: {classCounts[cls] || 0}
                </div>
              ))}
            </div>
          </div>

          {/* Train button */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={handleTrain} style={{ ...btnStyle('#ffd700'), padding: '8px 20px', fontSize: 11 }}>
              ENTRENAR MODELO
            </button>
            {trainProgress && <span style={{ fontSize: 10, color: '#ffd70088' }}>{trainProgress}</span>}
          </div>

          {/* Dataset management */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => exportDatasetFile(dataset)} style={btnStyle('#64ffda')}>EXPORTAR DATASET</button>
            <button onClick={() => fileInputRef.current?.click()} style={btnStyle('#64ffda')}>IMPORTAR DATASET</button>
            <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
            <button onClick={() => { setDataset({ samples: [], version: 1 }); saveDataset({ samples: [], version: 1 }); setSamplesThisSession(0) }} style={btnStyle('#ff5252')}>BORRAR TODO</button>
          </div>

          {/* Instructions */}
          <div style={{ fontSize: 10, color: '#c8f4ff55', lineHeight: 1.8, marginTop: 8 }}>
            <strong style={{ color: '#c8f4ff88' }}>Instrucciones:</strong><br/>
            1. Selecciona un gesto de la lista<br/>
            2. Haz el gesto frente a la camara<br/>
            3. Presiona GRABAR (graba ~20fps mientras mantengas el gesto)<br/>
            4. Repite con variaciones (angulos, distancias, mano abierta/cerrada)<br/>
            5. Minimo 30 samples por gesto recomendado<br/>
            6. Presiona ENTRENAR cuando tengas suficientes datos<br/>
            7. La prediccion en vivo se activa automaticamente
          </div>
        </div>
      </div>

      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      `}</style>
    </div>
  )
}

function btnStyle(color: string): React.CSSProperties {
  return {
    background: 'transparent', border: `1px solid ${color}55`, color,
    fontSize: 9, letterSpacing: '0.1em', padding: '5px 12px',
    borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
  }
}
