// frontend/src/hooks/useGesturePipeline.ts
// Orquestador del pipeline de gestos v2:
//   cámara compartida → MediaPipe HandLandmarker (main thread, ver
//   gestures/landmarker.ts para el porqué) → swap handedness →
//   GestureEngine (puro) → gestureStore.
//
// Anti-cuelgue (la inferencia CPU bloquea el main thread ~30-70 ms/frame):
// - Pacing ADAPTATIVO: el intervalo entre inferencias es inferMs·PACE_FACTOR
//   con piso FRAME_MIN_INTERVAL_MS — bajo carga baja el fps en vez de saturar
//   el WebKitWebProcess (v1 fijo a 30 fps → traps NeedDebuggerBreak + webview
//   muerto; a 15 fps era estable).
// - Frames de cámara repetidos se saltan (nextFrame()).
// - detectForVideo lanzando → recrear el landmarker (hasta 3 veces) SIN cerrar
//   la cámara: el churn open/close de getUserMedia dispara el SIGSEGV del
//   cliente PipeWire de WebKitGTK.
import { useEffect } from 'react'
import type { HandLandmarker } from '@mediapipe/tasks-vision'
import { GestureEngine } from '../gestures/engine'
import { createHandLandmarker } from '../gestures/landmarker'
import { openCamera, nextFrame, closeCamera, getGestureVideo, inferenceSource } from '../gestures/cameraFeed'
import { useGestureStore } from '../state/gestureStore'
import { useUiStore } from '../state/uiStore'
import { DEFAULT_OUTPUT } from '../gestures/types'
import type { HandFrame, DetectedHand, Vec3 } from '../gestures/types'
import {
  FRAME_MIN_INTERVAL_MS, FRAME_MAX_INTERVAL_MS, PACE_FACTOR, LANDMARKER_MAX_RESTARTS,
  IDLE_AFTER_MS, IDLE_FRAME_INTERVAL_MS,
} from '../gestures/config'

/**
 * Handedness verificada EMPÍRICAMENTE (2026-07-05, panel debug, mano por mano):
 * con getUserMedia SIN espejar + tasks-vision 0.10.35, label 'Left' = mano
 * IZQUIERDA física — mapeo DIRECTO, sin swap. (Nota v1 decía lo contrario; si
 * los gestos responden a la mano equivocada, re-verificar con los badges
 * IZQ/DER del panel antes de tocar esto.) Si ambas manos llegan con la misma
 * label, desempata la posición: imagen sin espejar → la mano físicamente
 * derecha aparece con x MENOR.
 */
function splitHands(hands: DetectedHand[]): { left: HandFrame | null; right: HandFrame | null } {
  let left: HandFrame | null = null
  let right: HandFrame | null = null

  const toFrame = (h: DetectedHand): HandFrame => ({ image: h.image, world: h.world, score: h.score })

  if (hands.length === 2 && hands[0].label === hands[1].label) {
    const [a, b] = hands
    const aX = a.image[0]?.x ?? 0.5
    const bX = b.image[0]?.x ?? 0.5
    right = toFrame(aX < bX ? a : b)
    left = toFrame(aX < bX ? b : a)
    return { left, right }
  }

  for (const h of hands) {
    if (h.label === 'Left') left = toFrame(h)
    else if (h.label === 'Right') right = toFrame(h)
  }
  return { left, right }
}

export function useGesturePipeline(): void {
  const enabled = useGestureStore(s => s.enabled)

  useEffect(() => {
    if (!enabled) return

    const { setOutput, setStatus, setFps, setDebugFrame } = useGestureStore.getState()

    let alive = true
    let landmarker: HandLandmarker | null = null
    let delegate = 'CPU'
    let restarts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let fpsWindow = { frames: 0, start: performance.now(), inferSum: 0 }
    let lastHandAt = performance.now()
    const engine = new GestureEngine()

    const schedule = (delayMs: number) => {
      if (!alive) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(tick, delayMs)
    }

    /** El landmarker murió en runtime: recrearlo sin tocar la cámara. */
    const restartLandmarker = (reason: string) => {
      if (!alive) return
      landmarker?.close()
      landmarker = null
      restarts++
      if (restarts > LANDMARKER_MAX_RESTARTS) {
        setStatus('error', `landmarker caído ${restarts - 1} veces (${reason})`)
        return
      }
      console.warn(`[gestures] landmarker reiniciado (${reason}), intento ${restarts}/${LANDMARKER_MAX_RESTARTS}`)
      setStatus('starting', 'reiniciando modelo…')
      // forceCpu: si el runtime murió (p.ej. delegate GPU inestable), no volver a apostar por GPU.
      createHandLandmarker(2, true)
        .then((handle) => {
          if (!alive) { handle.landmarker.close(); return }
          landmarker = handle.landmarker
          delegate = handle.delegate
          setStatus('running', `${delegate} · ${Math.round(1000 / FRAME_MIN_INTERVAL_MS)} fps máx`)
          schedule(FRAME_MIN_INTERVAL_MS)
        })
        .catch((e) => {
          if (alive) setStatus('error', `modelo no recargó: ${e instanceof Error ? e.message : String(e)}`)
        })
    }

    const tick = () => {
      if (!alive || !landmarker) return

      const video = nextFrame()
      if (!video) {
        // Sin frame nuevo: esperar el EVENTO de frame (requestVideoFrameCallback)
        // en vez de sondear — el polling de 8 ms batía contra la cadencia de la
        // cámara (30 fps) y añadía hasta un frame entero de latencia. Timeout de
        // respaldo por si WebKitGTK no dispara rVFC en un <video> display:none.
        const v = getGestureVideo() as (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: () => void) => number
          cancelVideoFrameCallback?: (id: number) => void
        }) | null
        if (v?.requestVideoFrameCallback) {
          if (timer !== null) clearTimeout(timer)
          const cbId = v.requestVideoFrameCallback(() => {
            if (timer !== null) { clearTimeout(timer); timer = null }
            tick()
          })
          timer = setTimeout(() => { v.cancelVideoFrameCallback?.(cbId); tick() }, 100)
        } else {
          schedule(8)
        }
        return
      }

      const t0 = performance.now()
      let result
      try {
        result = landmarker.detectForVideo(inferenceSource(video), t0)
      } catch (e) {
        restartLandmarker(e instanceof Error ? e.message : String(e))
        return
      }
      const inferMs = performance.now() - t0

      const hands: DetectedHand[] = []
      const n = result.handedness?.length ?? 0
      for (let i = 0; i < n; i++) {
        const cat = result.handedness[i][0]
        const image = result.landmarks?.[i] as Vec3[] | undefined
        const world = result.worldLandmarks?.[i] as Vec3[] | undefined
        if (!cat || !image || !world) continue
        hands.push({ label: cat.categoryName as 'Left' | 'Right', score: cat.score, image, world })
      }

      // Modal abierto (terminal, config de voz): los gestos no deben seguir
      // manejando la escena de fondo. Manos nulas → gracia → release limpio.
      // gesture_debug NO se incluye: el panel necesita el output vivo (y es
      // opaco — no hay escena visible detrás).
      const ui = useUiStore.getState()
      const modalOpen = ui.terminalOpen || ui.speakerConfigOpen
      const { left, right } = modalOpen
        ? { left: null, right: null }
        : splitHands(hands)
      setOutput(engine.update(left, right, t0))

      // Landmarks para el panel de debug — solo si está abierto (evita renders).
      if (ui.gestureDebugOpen) {
        setDebugFrame({ left: left?.image ?? null, right: right?.image ?? null })
      }

      fpsWindow.frames++
      fpsWindow.inferSum += inferMs
      const now = performance.now()

      // Reposo: nadie gesticulando (o un modal tapando la escena) → no hay nada
      // que calcular. Ver IDLE_AFTER_MS en config.ts.
      if (hands.length > 0 && !modalOpen) lastHandAt = now
      const idle = now - lastHandAt >= IDLE_AFTER_MS

      if (now - fpsWindow.start >= 1000) {
        setFps(Math.round((fpsWindow.frames * 1000) / (now - fpsWindow.start)))
        setStatus(
          'running',
          `${delegate} · main · ${Math.round(fpsWindow.inferSum / fpsWindow.frames)}ms${idle ? ' · reposo' : ''}`,
        )
        fpsWindow = { frames: 0, start: now, inferSum: 0 }
      }

      // Pacing adaptativo: dejar aire proporcional al costo de la inferencia.
      const interval = idle
        ? IDLE_FRAME_INTERVAL_MS
        : Math.min(FRAME_MAX_INTERVAL_MS, Math.max(FRAME_MIN_INTERVAL_MS, inferMs * PACE_FACTOR))
      schedule(Math.max(0, interval - (now - t0)))
    }

    setStatus('starting')
    ;(async () => {
      const { width, height } = await openCamera()
      if (!alive) { closeCamera(); return }
      console.log(`[gestures] cámara activa ${width}x${height}`)

      // Preferir GPU: XNNPACK/CPU hace la inferencia SÍNCRONA en el main thread
      // (~90 ms/frame), lo que hambrea el rAF de R3F y CONGELA el visor 3D
      // (Model3DViewer useFrame) mientras los gestos están activos. El delegate
      // GPU descarga la inferencia a shaders GL → main thread libre → THREE fluido
      // y gestos a ~13-15 fps (verificado 2026-07-05). El cuelgue de GPU que
      // motivó forzar CPU era un WebKitGTK degradado pre-reboot; con WebGL sano
      // GPU asienta, y el withTimeout de landmarker.ts (GPU 4s → CPU 12s → error
      // visible) acota el downside al comportamiento CPU actual si vuelve a colgar.
      const handle = await createHandLandmarker(2)
      if (!alive) { handle.landmarker.close(); return }
      landmarker = handle.landmarker
      delegate = handle.delegate

      console.log(`[gestures] modelo listo (delegate=${delegate})`)
      setStatus('running', `${delegate} · main`)
      fpsWindow = { frames: 0, start: performance.now(), inferSum: 0 }
      tick()
    })().catch((e) => {
      if (!alive) return
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      console.error('[gestures] init falló:', msg)
      setStatus('error', msg)
    })

    return () => {
      alive = false
      if (timer !== null) clearTimeout(timer)
      landmarker?.close()
      landmarker = null
      closeCamera()
      // Output limpio al apagar: sin esto, un grab/pinch 'active' rancio seguía
      // rotando escenas 3D con el pipeline apagado.
      setOutput(DEFAULT_OUTPUT)
      setDebugFrame(null)
      setStatus('off')
      setFps(0)
    }
  }, [enabled])
}
