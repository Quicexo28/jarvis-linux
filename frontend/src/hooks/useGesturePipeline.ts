import { useEffect, useRef } from 'react'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { GesturePipeline } from '../gestures/pipeline'
import { useGestureStore } from '../state/gestureStore'
import { POINTER_SMOOTHING } from '../gestures/config'
import type { Vec3 } from '../gestures/types'

export function useGesturePipeline() {
  const enabled = useGestureStore(s => s.enabled)
  const setOutput = useGestureStore(s => s.setOutput)
  const pipelineRef = useRef<GesturePipeline | null>(null)
  const handLandmarkerRef = useRef<HandLandmarker | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)
  const lastFrameTimeRef = useRef<number>(0)
  const pointerSmoothRef = useRef<{ x: number; y: number } | null>(null)
  const grabOnsetXRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    async function init() {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      )

      if (cancelled) return

      const handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'models/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
      })

      if (cancelled) { handLandmarker.close(); return }

      handLandmarkerRef.current = handLandmarker
      pipelineRef.current = new GesturePipeline()
      await pipelineRef.current.initML()

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      })

      if (cancelled) { stream.getTracks().forEach(t => t.stop()); handLandmarker.close(); return }

      streamRef.current = stream
      const video = document.createElement('video')
      video.srcObject = stream
      video.autoplay = true
      video.playsInline = true
      video.muted = true
      video.style.display = 'none'
      document.body.appendChild(video)
      videoRef.current = video

      await video.play()
      if (cancelled) return

      function loop() {
        if (cancelled) return
        rafRef.current = requestAnimationFrame(loop)

        const now = performance.now()
        if (now - lastFrameTimeRef.current < 33) return
        lastFrameTimeRef.current = now

        if (!handLandmarkerRef.current || !videoRef.current || !pipelineRef.current) return
        if (videoRef.current.readyState < 2) return

        const results = handLandmarkerRef.current.detectForVideo(videoRef.current, now)

        let leftLandmarks: Vec3[] | null = null
        let rightLandmarks: Vec3[] | null = null
        // image-space (0..1 sobre el frame) — necesario para mapear el puntero a la pantalla;
        // worldLandmarks son métricos y centrados en la mano, no sirven para el cursor.
        let leftImageLandmarks: Vec3[] | null = null

        if (results.worldLandmarks && results.handedness) {
          for (let i = 0; i < results.handedness.length; i++) {
            const label = results.handedness[i][0]?.categoryName
            const landmarks = results.worldLandmarks[i] as Vec3[]
            if (label === 'Left') {
              leftLandmarks = landmarks
              leftImageLandmarks = (results.landmarks?.[i] as Vec3[]) ?? null
            } else if (label === 'Right') {
              rightLandmarks = landmarks
            }
          }
        }

        const output = pipelineRef.current.process(leftLandmarks, rightLandmarks, now)

        // Grab: swipe horizontal medido con la muñeca (landmark 0) en image-space. worldLandmarks
        // están re-centrados en la mano (translation-invariant), así que mover la mano por el frame
        // casi no movía el deltaX original — costaba muchísimo rotar. Image-space sí sigue la mano.
        if (output.grab.active && leftImageLandmarks && leftImageLandmarks[0]) {
          const wx = leftImageLandmarks[0].x
          if (grabOnsetXRef.current === null) grabOnsetXRef.current = wx
          output.grab.deltaX = wx - grabOnsetXRef.current
        } else {
          grabOnsetXRef.current = null
        }

        // El cursor usa la punta del índice (landmark 8) en coords de imagen, suavizada (EMA).
        if (output.point.active && leftImageLandmarks && leftImageLandmarks[8]) {
          const tip = leftImageLandmarks[8]
          const prev = pointerSmoothRef.current
          const sx = prev ? prev.x + (tip.x - prev.x) * POINTER_SMOOTHING : tip.x
          const sy = prev ? prev.y + (tip.y - prev.y) * POINTER_SMOOTHING : tip.y
          pointerSmoothRef.current = { x: sx, y: sy }
          output.point.screenX = sx
          output.point.screenY = sy
        } else {
          pointerSmoothRef.current = null
        }

        setOutput(output)
      }

      loop()
    }

    init()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      if (videoRef.current) {
        videoRef.current.remove()
        videoRef.current = null
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      if (handLandmarkerRef.current) {
        handLandmarkerRef.current.close()
        handLandmarkerRef.current = null
      }
      pipelineRef.current = null
    }
  }, [enabled, setOutput])
}
