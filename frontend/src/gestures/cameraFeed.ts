// frontend/src/gestures/cameraFeed.ts
// Cámara compartida del sistema de gestos (singleton de módulo).
//
// El <video> oculto vive en el DOM a propósito: primitives.capture_photo
// reutiliza cualquier <video> vivo para sacar fotos sin re-pedir permiso.
// Abrir/cerrar streams de más también dispara el bug del cliente PipeWire de
// WebKitGTK (SIGSEGV en libpipewire-module-protocol-native) — una sola apertura
// por sesión de gestos; los reintentos del landmarker NO tocan la cámara.

import { INFER_MAX_WIDTH } from './config'

let video: HTMLVideoElement | null = null
let stream: MediaStream | null = null
let lastVideoTime = -1
let scaleCanvas: HTMLCanvasElement | null = null
let scaleCtx: CanvasRenderingContext2D | null = null
let scaleDisabled = false
let probeCanvas: HTMLCanvasElement | null = null
let probeCtx: CanvasRenderingContext2D | null = null

/** El <video> vivo del pipeline (para GestureDebugView y capture_photo). */
export function getGestureVideo(): HTMLVideoElement | null {
  return video
}

/** getUserMedia y video.play() pueden colgarse sin error; un `starting` eterno
 * se diagnosticaba como pipeline muerto. */
const OPEN_TIMEOUT_MS = 12000

// Una sola apertura en vuelo: dos getUserMedia concurrentes dejan un stream
// huérfano y el churn tumba el cliente PipeWire.
let opening: Promise<{ width: number; height: number }> | null = null
let wanted = false

function withTimeout<T>(p: Promise<T>, what: string, onLate?: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const t = setTimeout(() => {
      done = true
      reject(new Error(`cámara sin respuesta: ${what} no arrancó en ${OPEN_TIMEOUT_MS / 1000} s`))
    }, OPEN_TIMEOUT_MS)
    p.then(
      (v) => { if (done) { onLate?.(v); return } clearTimeout(t); done = true; resolve(v) },
      (e) => { if (done) return; clearTimeout(t); done = true; reject(e) },
    )
  })
}

export function openCamera(): Promise<{ width: number; height: number }> {
  wanted = true
  if (video && stream?.active && video.readyState >= 2) {
    return Promise.resolve({ width: video.videoWidth, height: video.videoHeight })
  }
  if (opening) return opening
  const p: Promise<{ width: number; height: number }> = startCamera().finally(() => {
    if (opening === p) opening = null
  })
  opening = p
  return p
}

async function startCamera(): Promise<{ width: number; height: number }> {
  releaseCamera()

  // SOLO `ideal`: WebKitGTK ignora los constraints (negocia vía portal
  // PipeWire), pero un constraint DURO (`max`/`exact`) que no puede satisfacer
  // lo hace fallar con OverconstrainedError y deja el pipeline sin cámara.
  // frameRate bajo a propósito: la inferencia corre en el main thread, así que
  // cada frame de cámara de más es contención contra el render; 20 fps de gesto
  // ya se sienten continuos porque los consumers interpolan entre muestras. Si
  // el portal lo ignora, el pacing de useGesturePipeline limita igual el ritmo.
  const got = await withTimeout(navigator.mediaDevices.getUserMedia({
    video: {
      // 640x480 empíricamente negocia 640x360; pedir 480x270 hacía que el
      // portal saltara a 1280x720 (más decodificación por frame para nada).
      width: { ideal: 640 }, height: { ideal: 480 },
      frameRate: { ideal: 20 },
      facingMode: 'user',
    },
  }), 'getUserMedia', (late) => late.getTracks().forEach(t => t.stop())) // llegó tras el timeout: no dejarlo huérfano
  if (!wanted) {
    got.getTracks().forEach(t => t.stop())
    throw new Error('cámara cancelada')
  }
  stream = got

  video = document.createElement('video')
  video.srcObject = stream
  video.autoplay = true
  video.playsInline = true
  video.muted = true
  video.style.display = 'none'
  video.dataset.jarvisGestures = '1'
  document.body.appendChild(video)
  const v = video
  try {
    await withTimeout(v.play(), 'video.play()')
  } catch (e) {
    releaseCamera()
    throw e
  }
  if (!wanted) {
    releaseCamera()
    throw new Error('cámara cancelada')
  }

  return { width: v.videoWidth, height: v.videoHeight }
}

/**
 * Devuelve el <video> solo si tiene un frame NUEVO listo (la cámara da ~30 fps;
 * re-inferir el mismo frame es CPU gratis para nadie). null = sin frame nuevo.
 */
export function nextFrame(): HTMLVideoElement | null {
  if (!video || video.readyState < 2 || !video.videoWidth) return null
  const vt = video.currentTime
  if (vt === lastVideoTime) return null
  lastVideoTime = vt
  return video
}

/**
 * Fuente que se le pasa a `detectForVideo`: el propio <video> si ya es pequeño,
 * o un canvas reescalado a INFER_MAX_WIDTH. El reescalado se paga una vez por
 * frame (drawImage acelerado) y ahorra subida de textura en cada inferencia.
 * Los landmarks salen normalizados, así que reescalar no cambia nada aguas abajo.
 */
export function inferenceSource(v: HTMLVideoElement): HTMLVideoElement | HTMLCanvasElement {
  if (!INFER_MAX_WIDTH || scaleDisabled || v.videoWidth <= INFER_MAX_WIDTH) return v

  const w = INFER_MAX_WIDTH
  const h = Math.round((v.videoHeight / v.videoWidth) * w)
  if (!scaleCanvas) {
    scaleCanvas = document.createElement('canvas')
    // SIN `desynchronized`: pide un buffer de baja latencia cuyo contenido, leído
    // desde OTRO contexto (el WebGL con el que tasks-vision sube la textura),
    // no está garantizado. Un canvas negro entra al modelo como una imagen
    // válida y sale con CERO manos — el pipeline parece sano (corre, mide ms,
    // reporta fps) y simplemente no ve nada.
    scaleCtx = scaleCanvas.getContext('2d', { alpha: false })
  }
  if (!scaleCtx) return v
  if (scaleCanvas.width !== w || scaleCanvas.height !== h) {
    scaleCanvas.width = w
    scaleCanvas.height = h
  }
  scaleCtx.drawImage(v, 0, 0, w, h)
  return scaleCanvas
}

/**
 * Brillo medio (0..255) de lo que se le está pasando al modelo. Existe porque el
 * modo de fallo que importa es MUDO: si el frame llega negro, `detectForVideo`
 * responde igual de rápido y con cero manos, así que el síntoma («no detecta»)
 * no distingue una cámara tapada de un canvas vacío. -1 = no medible.
 */
export function probeBrightness(src: HTMLVideoElement | HTMLCanvasElement): number {
  if (!probeCanvas) {
    probeCanvas = document.createElement('canvas')
    probeCanvas.width = 32
    probeCanvas.height = 18
    probeCtx = probeCanvas.getContext('2d', { alpha: false, willReadFrequently: true })
  }
  if (!probeCtx || !probeCanvas) return -1
  try {
    probeCtx.drawImage(src, 0, 0, probeCanvas.width, probeCanvas.height)
    const { data } = probeCtx.getImageData(0, 0, probeCanvas.width, probeCanvas.height)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3
    return sum / (data.length / 4)
  } catch {
    return -1
  }
}

/** Deja de reescalar y pasa el <video> tal cual (cuesta más textura, pero VE). */
export function disableScaling(): void {
  scaleDisabled = true
  scaleCanvas = null
  scaleCtx = null
}

export function isScalingDisabled(): boolean {
  return scaleDisabled
}

export function closeCamera(): void {
  wanted = false
  // Con apertura en vuelo no se libera aquí: startCamera ve wanted=false y limpia
  // al terminar. Liberar ahora rompería el play() en vuelo cuando un off→on rápido
  // reutiliza esa misma apertura.
  if (opening) return
  releaseCamera()
}

function releaseCamera(): void {
  // Orden importa: con webkit2gtk 2.54.2 soltar srcObject con el track aún vivo
  // cuelga a veces el hilo principal (deadlock en el teardown de GStreamer:
  // appsrc del track bloqueado en una query de negociación). Medido en harness
  // WebKitGTK aislado: orden viejo colgó al ciclo 6; parando tracks primero,
  // 29 ciclos sin cuelgue. En la UI viva colgaba ~3 de 15 apagados.
  if (stream) {
    stream.getTracks().forEach(t => t.stop())
    stream = null
  }
  if (video) {
    video.srcObject = null
    video.remove()
    video = null
  }
  scaleCanvas = null
  scaleCtx = null
  probeCanvas = null
  probeCtx = null
  lastVideoTime = -1
}
