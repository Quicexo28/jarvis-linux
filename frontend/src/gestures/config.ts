// frontend/src/gestures/config.ts
// Única fuente de umbrales del sistema de gestos v2 (worker + engine).
// Los "curl" son ratios distancia-punta/longitud-cadena sobre WORLD landmarks:
// 1.0 = dedo recto, ~0.3 = plegado. Calibrados con datos reales — no mover
// sin re-probar con el panel "Debug gestos".

// --- Pose: histéresis de curl por dedo (no-pulgar) ---
export const CURL_CONTRACTED_ENTER = 0.68
export const CURL_CONTRACTED_EXIT = 0.72
export const CURL_EXTENDED_ENTER = 0.82
export const CURL_EXTENDED_EXIT = 0.78

// Pulgar: rango de curl mucho más estrecho (0.79–0.99)
export const THUMB_CONTRACTED_ENTER = 0.85
export const THUMB_CONTRACTED_EXIT = 0.88
export const THUMB_EXTENDED_ENTER = 0.92
export const THUMB_EXTENDED_EXIT = 0.89

// --- Pose: estabilización ---
/** Frames consecutivos con la misma pose candidata para cambiar la pose estable. */
export const POSE_STABLE_FRAMES = 2
/**
 * Mano perdida ≤ este tiempo mantiene el gesto activo con valores congelados.
 * MediaPipe pierde 1-3 frames con frecuencia (motion blur); sin gracia, un
 * dropout suelta el grab a mitad de arrastre y el 3D pega saltos.
 */
export const LOST_GRACE_MS = 250

// --- Peace (V) con histéresis sep/close ---
// Gap índice-medio normalizado por palma. Entre ambos umbrales se mantiene el
// sub-estado anterior — sin esa zona muerta el gap intermedio caía a idle y
// disparaba el click antes de tiempo.
export const PEACE_SEP_ENTER = 0.36
export const PEACE_CLOSE_ENTER = 0.30

// --- Pinch (mano derecha, progresivo) ---
// Apertura = dist3D(punta pulgar, punta índice) / palmSize, en world landmarks.
// Contacto ≈ 0.3-0.45; spread completo ≈ 1.6-1.8.
export const PINCH_ENGAGE_APERTURE = 0.45
export const PINCH_RELEASE_APERTURE = 1.55
// Mapeo ANCLADO: zoom = exp(GAIN · (apertura − apertura_de_enganche)) — función
// directa y continua de la distancia pulgar-índice (la integración por pasos con
// deadband de la primera versión se sentía "a tirones"). Ganancia asimétrica:
// desde el contacto se puede ABRIR ~1.1 de apertura pero solo CERRAR ~0.27
// (dedos cruzados) — sin la ganancia extra hacia abajo nunca se llegaba a 0.5x.
/** ln(3)/1.15 ≈ 0.95 → spread completo (justo antes del release) ≈ zoom 3x. */
export const PINCH_GAIN_IN = 0.95
/** ln(0.5)/−0.27 ≈ 2.6 → cierre completo ≈ zoom 0.5x. */
export const PINCH_GAIN_OUT = 2.6
/** Zona muerta diminuta alrededor del ancla (remapeo C0): el temblor en el punto
 * de contacto no hace vibrar el zoom en 1.0. */
export const PINCH_ANCHOR_DEADZONE = 0.015
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 3.0

// --- Grab (mano izquierda, progresivo) ---
/** Palma image-space típica a ~60 cm. Normaliza los deltas: misma sensibilidad cerca o lejos de la cámara. */
export const GRAB_PALM_REF = 0.18
export const GRAB_SCALE_MIN = 0.6
export const GRAB_SCALE_MAX = 1.8

// --- Eventos discretos (peace_sep → click, peace_close → back) ---
export const DISCRETE_MIN_HOLD_MS = 150
export const DISCRETE_COOLDOWN_MS = 400

// --- Puntero (point) ---
/** Expansión alrededor del centro del frame: la mano no llega cómoda a los bordes. */
export const POINTER_EXPAND = 1.45

// --- One-Euro por canal (rate efectivo ~20-25 Hz) ---
// Regla One-Euro: minCutoff controla el jitter en reposo, beta el lag en
// movimiento. El beta del puntero era 0.007 → el cursor "nadaba" detrás de la
// mano en movimientos rápidos.
export const EURO_POINTER = { minCutoff: 1.6, beta: 0.06, dCutoff: 1.0 }
export const EURO_WRIST = { minCutoff: 1.5, beta: 0.9, dCutoff: 1.0 }
// Apertura del pinch: SUAVE a propósito. El zoom es un gesto lento y el temblor
// del pulgar se amplificaba en la exponencial (zoom "vibrando"); minCutoff bajo
// mata el jitter en reposo y beta bajo evita que el ruido rápido se cuele. El
// consumer además interpola la distancia de cámara por frame (ver Model3DViewer).
export const EURO_APERTURE = { minCutoff: 0.6, beta: 0.25, dCutoff: 1.0 }
// Roll 2D (limpio): beta alto → sigue la muñeca sin lag perceptible al girar.
export const EURO_ANGLE = { minCutoff: 2.0, beta: 0.8, dCutoff: 1.0 }
/** Yaw/pitch del puño salen del depth INFERIDO por el modelo (más ruidosos que
 * el roll 2D) — minCutoff moderado controla el jitter en reposo; beta alto
 * recorta el lag en movimiento (el usuario notaba retardo gesto→pantalla). */
export const EURO_ROT = { minCutoff: 1.5, beta: 0.8, dCutoff: 1.0 }
/** Zona muerta (rad) sobre el INCREMENTO de giro por-frame en el GrabTracker:
 * con la rotación acumulativa, el ruido de landmarks (~0.003-0.006 rad/frame con
 * la mano quieta) se integraría y la figura "temblaría". Soft (resta el umbral)
 * → mata el temblor en reposo sin escalón y sin lag; el movimiento real lo cruza. */
export const ROT_INCREMENT_DEADZONE = 0.006

// --- Inferencia (main thread — ver gestures/landmarker.ts) ---
/** Piso del intervalo entre inferencias. `detectForVideo` es SÍNCRONA aunque el
 * delegate sea GPU (bloquea hasta el readback): a 30 ms de piso con inferencias
 * de ~30 ms el main thread quedaba ~70% ocupado y TODO lo demás (rAF de R3F,
 * React) se sentía pesado. Con el delegate GPU la inferencia bajó a 10-16 ms
 * (medido 2026-09-24), así que 40 ms (25 fps) deja la ocupación en ~35%.
 * Los fps importan para el TRACKING, no solo para la fluidez: en modo VIDEO el
 * recorte de cada frame sale de los landmarks del anterior, y a 20 fps un
 * movimiento rápido sacaba la mano de ese recorte → mano perdida → vuelta al
 * detector de palma (las «pérdidas»). El pacing adaptativo sigue degradando
 * bajo carga (inferMs·factor). */
export const FRAME_MIN_INTERVAL_MS = 40
/** Ancho al que se reescala el frame ANTES de la inferencia (0 = sin reescalar).
 * OJO: solo el detector de PALMA trabaja a 192x192; el modelo de LANDMARKS
 * recorta la mano del frame de ENTRADA y la lleva a 224x224. A 320 px una mano
 * a distancia de escritorio medía ~50-60 px y se AMPLIABA ×4 → landmarks
 * borrosos, temblor y presencia baja (la mala detección). Con el delegate GPU
 * la subida de textura de 640x360 es despreciable, así que va sin reescalar.
 * Los landmarks salen normalizados (0..1) → nada aguas abajo cambia. */
export const INFER_MAX_WIDTH = 0
/** El intervalo se adapta a inferMs · factor — bajo carga degrada fps en vez de saturar. */
export const PACE_FACTOR = 1.35
export const FRAME_MAX_INTERVAL_MS = 200
/** Reposo: sin ninguna mano a la vista (o con un modal encima) la inferencia
 * cuesta lo mismo y no produce nada. Sin esto el WebKitWebProcess se comía ~50%
 * de un núcleo las 24 h, y ese núcleo es el que necesitan DeepFilter (denoise) y
 * ECAPA (speaker-id) del STT — se medía como latencia de voz, no como gestos
 * lentos. Tras IDLE_AFTER_MS sin mano se pasa a IDLE_FRAME_INTERVAL_MS; la
 * primera mano detectada vuelve al pacing normal, así que el único costo es
 * ≤IDLE_FRAME_INTERVAL_MS de latencia al levantar la mano (a 400 ms la mano
 * «tardaba» en aparecer; 200 ms × ~12 ms GPU = ~6% de un núcleo en reposo). */
export const IDLE_AFTER_MS = 4000
export const IDLE_FRAME_INTERVAL_MS = 200
/** detectForVideo lanzando en runtime → recrear el landmarker sin tocar la cámara. */
export const LANDMARKER_MAX_RESTARTS = 3

// --- Consumers (AwakeApp / WorldScene) — iguales que en v1 ---
export const PINCH_ENTER_THRESHOLD = 2.0
export const PINCH_SCALE_MULTIPLIER = 2.0
export const PINCH_APPROACH_DISTANCE = 3.0
export const PINCH_DISSOLVE_START = 0.7
export const PINCH_VIGNETTE_START = 0.5
/**
 * Arrastre del carrusel: SLOTS por unidad de `grab.deltaX` (deltaX 1.0 = mover
 * la mano de un borde al otro del encuadre, ya normalizado por tamaño de palma).
 * Con 7, un gesto cómodo de ~1/3 del encuadre mueve ~2,3 de los 6 slots y la
 * vuelta completa cabe en un solo barrido. Era 4.0 cuando el valor se integraba
 * a través de EMA + zona muerta + exponente, que se comían la mayor parte del
 * recorrido; con el arrastre absoluto la ganancia llega entera, así que este
 * número es ahora literal — subirlo mueve MÁS anillo por el mismo gesto.
 */
export const RING_DRAG_SENSITIVITY = 7.0
/**
 * Muelle crítico con el que el anillo (WorldScene `RingGroup`) sigue a su
 * objetivo, en rad/s. Retardo en movimiento = 2/ω (40 → 50 ms); asentado al 99 %
 * tras un snap ≈ 6,6/ω (≈170 ms). Más bajo = más suave pero más "detrás" de la
 * mano; más alto = vuelven a notarse los escalones de ~25 Hz del pipeline.
 */
export const RING_FOLLOW_OMEGA = 40
/**
 * Histéresis del slot resaltado durante el arrastre, en slots: para cambiar de
 * modo el ángulo debe pasar la frontera x.5 por este margen. Holgado frente al
 * temblor residual ESTIMADO con la mano quieta (ruido de muñeca tras One-Euro ×
 * RING_DRAG_SENSITIVITY ≈ 0,01-0,03 slots; sin medir en vivo) y lo bastante
 * pequeño (≈7°) para que el resalte no se sienta pegado.
 */
export const RING_SLOT_HYSTERESIS = 0.12

// --- Tap: clic con la MISMA mano que apunta (pulgar toca el índice) ---
// El "V abierta soltada" (DiscreteTracker) sigue existiendo, pero como clic de
// menú tiene tres problemas: cuesta ≥150 ms de hold MÁS la transición de pose,
// no dice QUÉ se pulsa (siempre entra al slot enfocado) y obliga a cambiar la
// mano entera de forma. El tap pinza se hace SIN dejar de apuntar: el cursor no
// se mueve y el objetivo bajo el cursor es el que recibe el evento.
// Umbrales sobre la MISMA `aperture` del pinch derecho (dist3D pulgar-índice /
// palma): contacto ≈ 0.3-0.45, pointing normal con el pulgar recogido ≈ 0.7-1.0.
export const TAP_ENTER_APERTURE = 0.45
export const TAP_EXIT_APERTURE = 0.62
/** Frames consecutivos bajo el umbral para bajar el "botón" (anti-blip). */
export const TAP_STABLE_FRAMES = 1
/** Presión más corta que esto = ruido de landmarks, no un clic. */
export const TAP_MIN_PRESS_MS = 50
/** Separación mínima entre clics — evita el doble disparo al soltar temblando. */
export const TAP_COOLDOWN_MS = 220
/** Apertura del tap: el filtro más RÁPIDO del sistema, y a propósito. Un clic
 * es un escalón corto, no una trayectoria: con los parámetros del pinch
 * (beta 0.25) el contacto tardaba 3 muestras (~150 ms) en cruzar el umbral y el
 * botón se sentía pastoso. Con minCutoff/beta altos engancha en la muestra
 * siguiente al contacto, y el ruido lo para la histéresis 0.45/0.62 — que en
 * unidades de palma es enorme comparada con el jitter de los landmarks. */
export const EURO_TAP = { minCutoff: 3.0, beta: 3.0, dCutoff: 1.0 }

// --- Puntero: precisión y latencia ---
/** Mientras el tap está presionado el puntero se mueve a esta fracción de su
 * ganancia normal, anclado al punto de presión: permite arrastrar (slider,
 * ring) sin que el propio gesto de cerrar la pinza desvíe el cursor. */
export const POINTER_FINE_GAIN = 0.45
/** Adelanto predictivo (ms) aplicado por el CONSUMIDOR con la velocidad del
 * puntero. El pipeline corre a ~20 Hz y One-Euro añade su propio retardo; sin
 * esto el cursor va perceptiblemente "detrás" de la mano. Es extrapolación
 * lineal: pasarse produce sobreimpulso al frenar, de ahí el tope. */
export const POINTER_LEAD_MS = 55
/** Tope del adelanto en fracción de pantalla (evita el overshoot al frenar). */
export const POINTER_LEAD_MAX = 0.05

// --- Cursor de mano sobre la interfaz (hooks/useGestureCursor) ---
/** Radio (px) dentro del cual el cursor se IMANTA al objetivo más cercano.
 * Apuntar con la mano tiene un error de varios píxeles y los botones del HUD
 * miden ~30 px de alto: sin imán, la ley de Fitts hace el menú inusable. */
export const CURSOR_MAGNET_RADIUS = 46
/** Histéresis: el objetivo ya enganchado conserva prioridad hasta este radio.
 * Sin ella, el cursor entre dos botones contiguos parpadea entre ambos. */
export const CURSOR_MAGNET_STICKY = 72
/** Clic por permanencia (fallback si el tap no engancha). 0 = desactivado. */
export const CURSOR_DWELL_MS = 1100
/** Movimiento (px) que cancela el dwell en curso. */
export const CURSOR_DWELL_CANCEL_PX = 38

/** Sin frames nuevos de cámara durante este tiempo el pipeline se declara
 * atascado: se limpia el output y el status vuelve a `starting`. */
export const FRAME_STALL_MS = 1500
