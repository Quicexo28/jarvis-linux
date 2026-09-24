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
// init es NO-DETERMINISTA: unas veces asienta en ~1 s y otras tarda decenas de
// segundos (máquina cargada, primera compilación de 11 MB de wasm). CRÍTICO
// preferir GPU: la inferencia CPU/XNNPACK bloquea el main thread ~90-120 ms por
// frame y CONGELA el visor 3D R3F (mismo hilo del rAF); GPU descarga a shaders.
//
// MODELO DE ESPERA (reescrito 2026-09-18 tras verlo fallar en vivo): la versión
// anterior hacía `withTimeout` y a los 10 s ABANDONABA el intento para lanzar
// otro. Los abandonados NO se cancelan — terminaban 30-60 s después y dejaban un
// grafo de MediaPipe VIVO con su contexto GL que nadie cerraba ("Graph
// successfully started running" ×3 en journald, ya pasados sus timeouts).
// Cada timeout añadía así un huérfano que competía por la GPU y hacía el
// siguiente intento aún más lento: una cascada que se empeoraba sola y acababa
// SIEMPRE en `init CPU landmarker no respondió tras 12000 ms`. Ahora:
//  - los intentos CONVIVEN y gana el primero que aterrice (`raceAttempts`);
//  - el que llega tarde se CIERRA (`close()`) y su canvas se retira — cero
//    huérfanos, que era la causa raíz;
//  - CPU no sustituye a GPU: solo entra si GPU FALLA de verdad. Lanzarla "por si
//    acaso" mientras GPU sigue viva duplica el trabajo en el MISMO main thread y
//    retrasa a las dos (medido: con las dos en vuelo, GPU 70 417 ms y CPU
//    58 712 ms — ambas acabaron, ninguna dentro del techo viejo).
//
// CUÁNTO TARDA DE VERDAD: en este equipo, con la UI despierta (carrusel 3D a 60
// fps en el mismo hilo) y el resto de Jarvis corriendo, construir el grafo tarda
// alrededor de un minuto. No es el fichero — servir el .task de 7,8 MB tarda
// 12 ms — sino el grafo compitiendo por el main thread de WebKit. Por eso el
// techo es de MINUTOS, no de segundos: rendirse antes no acelera nada, solo
// deja al usuario sin gestos y (antes del cierre de tardíos) con un grafo
// huérfano encendido. Es un coste de UNA vez por arranque de la UI.
/** Techo por delegate: pasado esto se da por muerto y se prueba el siguiente. */
const INIT_HARD_CAP_MS = 150000
/** El wasm es local (tauri://), pero 11 MB compilando en una máquina cargada. */
const WASM_TIMEOUT_MS = 20000

/** Rechaza si la promesa no se asienta en ms. No cancela la original. */
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
// insertamos oculto (1px, opacity 0, tras todo).
//
// El atributo lleva ESTADO (`pending` | `live`) y la limpieza solo toca lo que
// ya no sirve: arrancarle el canvas a un init EN VUELO era parte del problema
// descrito arriba (el contexto GL de ese init cuelga de este nodo).
function makeGlCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  canvas.setAttribute('data-jarvis-landmarker', 'pending')
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1'
  document.body.appendChild(canvas)
  return canvas
}

function retire(canvas: HTMLCanvasElement): void {
  canvas.remove()
}

/**
 * Retira los canvas de landmarkers que el llamante YA cerró. Se hace al empezar
 * una creación nueva: `useGesturePipeline` cierra el anterior antes de pedir
 * otro, así que en ese momento cualquier canvas `live` es basura. Los `pending`
 * se respetan: pertenecen a un init todavía en vuelo.
 */
function retireClosed(): void {
  for (const old of document.querySelectorAll('canvas[data-jarvis-landmarker="live"]')) old.remove()
}

interface RaceOptions {
  vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
  baseOpts: Record<string, unknown>
  /** Delegates a lanzar y cuánto esperar antes de lanzar cada uno. */
  plan: { delegate: LandmarkerDelegate; afterMs: number }[]
  /** Latido de progreso: un minuto de silencio es indistinguible de un cuelgue. */
  onProgress?: (msg: string) => void
}

/** Cada cuánto se informa del progreso mientras se construye el grafo. */
const PROGRESS_TICK_MS = 3000

/**
 * Lanza los intentos escalonados y resuelve con el PRIMERO que aterrice. Los que
 * llegan después se cierran: un HandLandmarker sin dueño es un grafo corriendo
 * con su contexto GL, no un objeto inerte.
 */
function raceAttempts({ vision, baseOpts, plan, onProgress }: RaceOptions): Promise<LandmarkerHandle> {
  return new Promise<LandmarkerHandle>((resolve, reject) => {
    let done = false
    let failed = 0
    let lastErr: unknown = null
    const timers: ReturnType<typeof setTimeout>[] = []
    const started = performance.now()
    const running = new Set<LandmarkerDelegate>()

    const cap = setTimeout(() => {
      if (done) return
      done = true
      timers.forEach(clearTimeout)
      clearInterval(heartbeat)
      reject(new Error(`ningún delegate respondió tras ${INIT_HARD_CAP_MS} ms`))
    }, INIT_HARD_CAP_MS)

    const heartbeat = setInterval(() => {
      if (done || !onProgress) return
      const s = Math.round((performance.now() - started) / 1000)
      onProgress(`construyendo grafo (${[...running].join('+') || '—'}) · ${s} s`)
    }, PROGRESS_TICK_MS)

    const finish = (fn: () => void) => {
      done = true
      clearTimeout(cap)
      clearInterval(heartbeat)
      timers.forEach(clearTimeout)
      fn()
    }

    const launch = (delegate: LandmarkerDelegate) => {
      if (done) return
      const canvas = makeGlCanvas()
      const t0 = performance.now()
      running.add(delegate)
      console.log(`[gestures] creando landmarker (delegate ${delegate})…`)
      onProgress?.(`construyendo grafo (${delegate})…`)
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: 'models/hand_landmarker.task', delegate },
        canvas,
        ...baseOpts,
      }).then(
        (landmarker) => {
          const ms = Math.round(performance.now() - t0)
          running.delete(delegate)
          if (done) {
            // Tarde: nadie lo va a usar. Cerrarlo es OBLIGATORIO — dejarlo vivo
            // es exactamente el huérfano que tumbaba los arranques siguientes.
            console.warn(`[gestures] ${delegate} llegó tarde (${ms} ms) → cerrado`)
            try { landmarker.close() } catch { /* ya medio cerrado: da igual */ }
            retire(canvas)
            return
          }
          console.log(`[gestures] landmarker listo (delegate ${delegate}, ${ms} ms)`)
          canvas.setAttribute('data-jarvis-landmarker', 'live')
          finish(() => resolve({ landmarker, delegate }))
        },
        (err) => {
          failed++
          lastErr = err
          running.delete(delegate)
          retire(canvas)
          console.warn(`[gestures] delegate ${delegate} falló:`, err)
          // Solo se rinde cuando TODOS los planificados fallaron de verdad.
          if (!done && failed === plan.length) finish(() => reject(lastErr))
        },
      )
    }

    for (const step of plan) {
      if (step.afterMs <= 0) launch(step.delegate)
      else timers.push(setTimeout(() => launch(step.delegate), step.afterMs))
    }
  })
}

export async function createHandLandmarker(
  numHands: number,
  forceCpu = false,
  onProgress?: (msg: string) => void,
): Promise<LandmarkerHandle> {
  console.log('[gestures] cargando runtime de visión (wasm)…')
  onProgress?.('cargando runtime de visión…')
  const vision = await withTimeout(FilesetResolver.forVisionTasks('wasm'), WASM_TIMEOUT_MS, 'runtime wasm')
  retireClosed()

  const baseOpts = {
    runningMode: 'VIDEO' as const,
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  }

  if (forceCpu) return raceAttempts({ vision, baseOpts, plan: [{ delegate: 'CPU', afterMs: 0 }], onProgress })

  try {
    return await raceAttempts({ vision, baseOpts, plan: [{ delegate: 'GPU', afterMs: 0 }], onProgress })
  } catch (err) {
    console.warn('[gestures] delegate GPU descartado → CPU (el visor 3D puede tartamudear con gestos activos):', err)
    return raceAttempts({ vision, baseOpts, plan: [{ delegate: 'CPU', afterMs: 0 }], onProgress })
  }
}
