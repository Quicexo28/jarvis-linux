// frontend/src/gestures/landmarker.ts
// Creación del HandLandmarker en el MAIN thread.
//
// ¿Por qué no un Worker? tasks-vision 0.10 NO tiene ruta de ingesta CPU: toda
// imagen de entrada pasa por una textura WebGL (_addBoundTextureAsImageToStream),
// incluso con delegate CPU. Los workers de WebKitGTK no tienen WebGL (probado:
// "GLctx.activeTexture" con OffscreenCanvas, "Can't find variable: document"
// sin él) → la inferencia debe vivir donde hay GL: el main thread. El costo se
// controla con pacing adaptativo en useGesturePipeline.
//
// canvas EXPLÍCITO obligatorio: sin él la librería usa new OffscreenCanvas(1,1),
// y WebKitGTK tampoco da WebGL ahí (emscripten_webgl_create_context error 0 →
// "GLctx.activeTexture" al ingerir el primer frame, con el modelo ya cargado).
// Un <canvas> DOM sí tiene WebGL real (THREE corre en esta misma página).
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'

export type LandmarkerDelegate = 'GPU' | 'CPU'

export interface LandmarkerHandle {
  landmarker: HandLandmarker
  delegate: LandmarkerDelegate
}

// tasks-vision no expone cancelación de createFromOptions, y en WebKitGTK el
// init del delegate GPU es NO-DETERMINISTA: unas veces asienta en ~1 s, otras
// tarda 5-9 s, y (raro, tras drivers/mesa cambiados) cuelga indefinido dejando
// el pipeline pegado en 'starting'. El timeout acota el cuelgue; el reintento
// evita rendirse a CPU cuando GPU solo iba LENTO. CRÍTICO preferir GPU: la
// inferencia CPU/XNNPACK bloquea el main thread ~90-120 ms/frame y CONGELA el
// visor 3D R3F (mismo hilo del rAF). GPU descarga a shaders GL → hilo libre.
// El techo de 4 s se rendía antes de tiempo (GPU tardó >4 s y cayó a CPU→freeze);
// 10 s cubre el arranque lento. En éxito withTimeout resuelve al instante, no
// espera el techo. Ajustables si el arranque real varía.
const GPU_INIT_TIMEOUT_MS = 10000
const GPU_ATTEMPTS = 2
const CPU_INIT_TIMEOUT_MS = 12000

// Rechaza si la promesa no se asienta en ms. No cancela la original (la librería
// no lo permite), solo deja de esperarla.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} no respondió tras ${ms} ms`)), ms)
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// tasks-vision ingiere cada frame por una textura WebGL (aun con delegate CPU),
// así que createFromOptions crea un contexto GL sobre este canvas. En WebKitGTK
// con GPU híbrida (Intel + NVIDIA), crear WebGL sobre un canvas DETACHED
// (createElement sin insertar) CUELGA createFromOptions para AMBOS delegates —
// era la causa del pipeline pegado en 'starting'. Un canvas ADJUNTO al DOM sí
// obtiene WebGL real y compositado (igual que THREE en esta misma página); lo
// insertamos oculto (1px, opacity 0, tras todo). Limpia el canvas de un
// landmarker previo para no acumular en recreaciones.
function makeGlCanvas(): HTMLCanvasElement {
  for (const old of document.querySelectorAll('canvas[data-jarvis-landmarker]')) old.remove()
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  canvas.setAttribute('data-jarvis-landmarker', '')
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1'
  document.body.appendChild(canvas)
  return canvas
}

export async function createHandLandmarker(numHands: number, forceCpu = false): Promise<LandmarkerHandle> {
  console.log('[gestures] cargando runtime de visión (wasm)…')
  const vision = await withTimeout(FilesetResolver.forVisionTasks('wasm'), CPU_INIT_TIMEOUT_MS, 'runtime wasm')
  const baseOpts = {
    runningMode: 'VIDEO' as const,
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  }
  // Canvas GL FRESCO por intento: un init GPU que colgó dejó su promesa pendiente
  // (no cancelable) atada a su canvas; makeGlCanvas retira los previos para que el
  // siguiente intento no herede un contexto GL en mal estado.
  const make = (delegate: LandmarkerDelegate, timeoutMs: number, label: string) =>
    withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate },
        canvas: makeGlCanvas(),
        ...baseOpts,
      }),
      timeoutMs, label,
    )

  if (!forceCpu) {
    for (let attempt = 1; attempt <= GPU_ATTEMPTS; attempt++) {
      try {
        console.log(`[gestures] creando landmarker (delegate GPU, intento ${attempt}/${GPU_ATTEMPTS})…`)
        const landmarker = await make('GPU', GPU_INIT_TIMEOUT_MS, 'init GPU landmarker')
        return { landmarker, delegate: 'GPU' }
      } catch (err) {
        console.warn(`[gestures] delegate GPU intento ${attempt} falló/colgó:`, err)
      }
    }
    console.warn('[gestures] GPU agotó reintentos → CPU (el visor 3D puede tartamudear con gestos activos)')
  }
  console.log('[gestures] creando landmarker (delegate CPU)…')
  const landmarker = await make('CPU', CPU_INIT_TIMEOUT_MS, 'init CPU landmarker')
  return { landmarker, delegate: 'CPU' }
}
