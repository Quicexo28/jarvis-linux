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
export const EURO_APERTURE = { minCutoff: 1.2, beta: 0.6, dCutoff: 1.0 }
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
/** Piso del intervalo entre inferencias — 30 ms = cadencia de la cámara
 * (640x360@30): procesar CADA frame, no hay más que ganar por debajo. Con
 * delegate GPU (infer ~16 ms) el main thread lo aguanta; la era CPU-inline
 * necesitaba 66 ms (15 fps) para no saturar el WebKitWebProcess. El pacing
 * adaptativo sigue degradando bajo carga — si vuelve el delegate CPU, el
 * intervalo sube solo (inferMs·factor). */
export const FRAME_MIN_INTERVAL_MS = 30
/** El intervalo se adapta a inferMs · factor — bajo carga degrada fps en vez de saturar. */
export const PACE_FACTOR = 1.35
export const FRAME_MAX_INTERVAL_MS = 200
/** detectForVideo lanzando en runtime → recrear el landmarker sin tocar la cámara. */
export const LANDMARKER_MAX_RESTARTS = 3

// --- Consumers (AwakeApp / WorldScene) — iguales que en v1 ---
export const PINCH_ENTER_THRESHOLD = 2.0
export const PINCH_SCALE_MULTIPLIER = 2.0
export const PINCH_APPROACH_DISTANCE = 3.0
export const PINCH_DISSOLVE_START = 0.7
export const PINCH_VIGNETTE_START = 0.5
export const RING_DRAG_SENSITIVITY = 4.0
