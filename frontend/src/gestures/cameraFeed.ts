// frontend/src/gestures/cameraFeed.ts
// Cámara compartida del sistema de gestos (singleton de módulo).
//
// El <video> oculto vive en el DOM a propósito: primitives.capture_photo
// reutiliza cualquier <video> vivo para sacar fotos sin re-pedir permiso.
// Abrir/cerrar streams de más también dispara el bug del cliente PipeWire de
// WebKitGTK (SIGSEGV en libpipewire-module-protocol-native) — una sola apertura
// por sesión de gestos; los reintentos del landmarker NO tocan la cámara.

let video: HTMLVideoElement | null = null
let stream: MediaStream | null = null
let lastVideoTime = -1

/** El <video> vivo del pipeline (para GestureDebugView y capture_photo). */
export function getGestureVideo(): HTMLVideoElement | null {
  return video
}

export async function openCamera(): Promise<{ width: number; height: number }> {
  if (video && stream?.active && video.readyState >= 2) {
    return { width: video.videoWidth, height: video.videoHeight }
  }
  closeCamera()

  // WebKitGTK ignora los constraints `ideal` (negocia 720p@30 vía portal
  // PipeWire) — se piden igual por si algún día los respeta.
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
  })

  video = document.createElement('video')
  video.srcObject = stream
  video.autoplay = true
  video.playsInline = true
  video.muted = true
  video.style.display = 'none'
  video.dataset.jarvisGestures = '1'
  document.body.appendChild(video)
  await video.play()

  return { width: video.videoWidth, height: video.videoHeight }
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

export function closeCamera(): void {
  if (video) {
    video.srcObject = null
    video.remove()
    video = null
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop())
    stream = null
  }
  lastVideoTime = -1
}
