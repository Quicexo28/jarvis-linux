// frontend/src/gestures/config.ts

// Layer 2 — State hysteresis thresholds (non-thumb fingers)
// Real data shows contracted fingers at 0.25–0.66 range
export const CURL_CONTRACTED_ENTER = 0.68
export const CURL_CONTRACTED_EXIT = 0.72
export const CURL_EXTENDED_ENTER = 0.82
export const CURL_EXTENDED_EXIT = 0.78

// Layer 2 — Thumb-specific thresholds (thumb has much smaller curl range: 0.79–0.99)
export const THUMB_CONTRACTED_ENTER = 0.85
export const THUMB_CONTRACTED_EXIT = 0.88
export const THUMB_EXTENDED_ENTER = 0.92
export const THUMB_EXTENDED_EXIT = 0.89

// Layer 2 — Contact thresholds (normalized by palmSize)
export const CONTACT_THUMB_INDEX_ENTER = 0.55
export const CONTACT_THUMB_INDEX_EXIT = 0.65

// Layer 3 — Modifier
export const PAUSE_RESUME_TOLERANCE = 0.05
export const PAUSE_TIMEOUT_MS = 3000

// Layer 4 — Gesture recognition
export const PEACE_SEP_MIN_DISTANCE = 0.4
export const PEACE_CLOSE_MAX_DISTANCE = 0.25
export const DISCRETE_MIN_HOLD_MS = 150

// Layer 5 — Output
export const MIN_PINCH_DIST = 0.015
export const MAX_PINCH_DIST = 0.08
export const PINCH_HOLD_MS = 180
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 3.0
export const ZOOM_SMOOTH_FACTOR = 0.06
export const GRAB_DEAD_ZONE = 0.08

// Layer 6 — Pinch-to-zoom-into-hologram
export const PINCH_ENTER_THRESHOLD = 2.0
export const PINCH_SCALE_MULTIPLIER = 2.0
export const PINCH_APPROACH_DISTANCE = 3.0
export const PINCH_DISSOLVE_START = 0.7
export const PINCH_VIGNETTE_START = 0.5

// Layer 7 — Grab → rotación paso-a-paso del ring.
// deltaX = desplazamiento horizontal de la muñeca en image-space (0..1 sobre el frame), medido
// desde el inicio del grab. Un swipe deliberado mueve ~0.15-0.30.
export const GRAB_STEP_TRIGGER = 0.13     // |deltaX| para disparar 1 paso
export const GRAB_STEP_REARM = 0.05       // volver bajo este |deltaX| re-arma el siguiente paso
export const GRAB_STEP_COOLDOWN_MS = 400  // delay mínimo entre pasos (anti doble registro)

// Layer 7 — Grab → drag continuo del ring (reemplaza el modelo paso-a-paso).
// El ring sigue la mano 1:1 mientras el puño está cerrado; snap al slot más
// cercano al soltar. Ajustar si el arrastre se siente demasiado lento/rápido.
export const RING_DRAG_SENSITIVITY = 4.0

// Layer 7 — Point → suavizado del puntero (EMA, 0..1; más bajo = más suave)
export const POINTER_SMOOTHING = 0.35
