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

export async function createHandLandmarker(numHands: number, forceCpu = false): Promise<LandmarkerHandle> {
  const vision = await FilesetResolver.forVisionTasks('wasm')
  const options = {
    canvas: document.createElement('canvas'),
    runningMode: 'VIDEO' as const,
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  }
  if (!forceCpu) {
    try {
      const landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate: 'GPU' },
        ...options,
      })
      return { landmarker, delegate: 'GPU' }
    } catch (err) {
      console.warn('[gestures] delegate GPU falló, usando CPU:', err)
    }
  }
  const landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate: 'CPU' },
    ...options,
  })
  return { landmarker, delegate: 'CPU' }
}
