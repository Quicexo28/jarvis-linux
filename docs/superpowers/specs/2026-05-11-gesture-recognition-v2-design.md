# Gesture Recognition v2 — Design Spec

## Overview

A layered hand gesture recognition system for jarvis-desktop that uses MediaPipe hand landmarks to detect poses and gestures for navigating the app's 3D carousel, controlling zoom, and performing click/back actions. Replaces the previous DTW-based approach which had precision issues.

## Vocabulary

| Gesture | Hand | Type | Pose | Action |
|---------|------|------|------|--------|
| **Idle** | Any | Neutral | 5 fingers extended | No action |
| **Grab** | Left | Continuous | 5 fingers contracted | Rotate ring / pan camera |
| **Point** | Left | Continuous | Index extended, middle+ring+pinky contracted | Virtual cursor |
| **Peace Sep** | Left | Discrete (release) | Index+middle extended & separated, ring+pinky contracted | Click |
| **Peace Close** | Left | Discrete (release) | Index+middle extended & together, ring+pinky contracted | Back |
| **Pinch** | Right | Continuous | Thumb+index control distance, middle+ring+pinky contracted | Zoom |
| **Pause** | Modifier | — | Pinky extended during pinch | Freeze zoom output |

Hand distribution:
- Left: spatial navigation (grab) + UI interaction (point, click, back)
- Right: zoom (pinch) + modifier (pause)
- Both hands operate independently and simultaneously.

## Architecture — 5 Layer Pipeline

```
MediaPipe worldLandmarks (3D, per hand)
         │
    ┌────▼─────┐
    │ FEATURES │  curl ratios, tip distances, positions
    └────┬─────┘
         │
    ┌────▼─────┐
    │  STATE   │  discretize with hysteresis → finger states
    └────┬─────┘
         │
    ┌────▼─────┐
    │ MODIFIER │  evaluate pause before gestures
    └────┬─────┘
         │
    ┌────▼─────┐
    │ GESTURE  │  rule matching → gesture ID per hand
    └────┬─────┘
         │
    ┌────▼─────┐
    │  OUTPUT  │  map to actions (zoom, rotation, cursor, events)
    └──────────┘
         │
    Frontend (zustand store → React components)
```

## Layer 1 — Features

Input: 21 landmarks per hand (worldLandmarks, 3D meters).

Output per hand:

```typescript
interface HandFeatures {
  palmSize: number  // distance(wrist[0], middle_MCP[9])

  curl: {
    thumb: number   // dist(CMC[1], TIP[4]) / (dist(1,2) + dist(2,3) + dist(3,4))
    index: number   // dist(MCP[5], TIP[8]) / (dist(5,6) + dist(6,7) + dist(7,8))
    middle: number  // dist(MCP[9], TIP[12]) / (dist(9,10) + dist(10,11) + dist(11,12))
    ring: number    // dist(MCP[13], TIP[16]) / (dist(13,14) + dist(14,15) + dist(15,16))
    pinky: number   // dist(MCP[17], TIP[20]) / (dist(17,18) + dist(18,19) + dist(19,20))
  }

  tipDistances: {
    thumbIndex: number
    indexMiddle: number
    middleRing: number
    ringPinky: number
  }

  wristPosition: { x: number; y: number; z: number }
  indexTipPosition: { x: number; y: number; z: number }
}
```

All distances normalized by palmSize. Pure function, ~2ms per frame.

## Layer 2 — State

Discretizes curl ratios with hysteresis. Stateful (remembers previous state per finger).

```typescript
type FingerState = 'extended' | 'half' | 'contracted'

interface HandState {
  fingers: {
    thumb: FingerState
    index: FingerState
    middle: FingerState
    ring: FingerState
    pinky: FingerState
  }
  contacts: {
    thumbIndex: boolean
  }
  isIdle: boolean
  extendedCount: number
}
```

Hysteresis thresholds:
- contracted → half: curl > 0.50 (exit: curl < 0.45)
- half → extended: curl > 0.75 (exit: curl < 0.70)

Contact thumbIndex:
- Enter: tipDistances.thumbIndex < 0.15
- Exit: tipDistances.thumbIndex > 0.22

One `HandStateTracker` instance per hand.

## Layer 3 — Modifiers

Evaluates before gesture recognition. If active, intercepts output.

```typescript
type ModifierStatus =
  | { type: 'none' }
  | { type: 'paused'; frozenValue: number }
  | { type: 'waiting_resume'; frozenValue: number; target: number; tolerance: number }
```

Pause flow:
1. **NONE → PAUSED:** right.pinky becomes extended while PINCH active. Store frozenValue (current zoom) and target (current thumb-index distance).
2. **PAUSED → WAITING_RESUME:** right.pinky leaves extended.
3. **WAITING_RESUME → NONE (resume):** |currentDist - target| < tolerance (±0.5 normalized). Gesture resumes from frozen value.
4. **WAITING_RESUME → NONE (timeout):** 3s without distance match. Gesture cancels, zoom stays at frozenValue.
5. **WAITING_RESUME → PAUSED:** pinky re-extends (user re-pauses).

Tolerance for resume: ±0.05 normalized distance.

## Layer 4 — Gesture Recognition

Rules evaluated in priority order (most specific first) per hand.

Left hand:
1. **PEACE_SEP:** index extended, middle extended, ring contracted, pinky contracted, indexMiddle distance > 0.4
2. **PEACE_CLOSE:** index extended, middle extended, ring contracted, pinky contracted, indexMiddle distance < 0.25
3. **POINT:** index extended, middle contracted, ring contracted, pinky contracted
4. **GRAB:** all 5 contracted
5. **IDLE:** all 5 extended (fallback)

Right hand:
1. **PINCH:** middle contracted, ring contracted, pinky contracted, thumbIndex contact active
2. **IDLE:** all 5 extended (fallback)

Discrete gesture release logic:
- Track `wasActive` boolean per discrete gesture.
- Emit event when pose was active for >150ms and then stops matching.
- Anti-bounce: ignore poses held <150ms (transient while transitioning).

Pinch activation/deactivation:
- Activates when thumbIndex contact enters + middle/ring/pinky contracted.
- Once active, thumb-index distance can grow (zoom out) without deactivating.
- Deactivates when middle, ring, or pinky leaves contracted state.

## Layer 5 — Output

```typescript
interface GestureOutput {
  grab: {
    active: boolean
    deltaX: number  // wrist delta from onset, normalized by palmSize
    deltaY: number
  }
  point: {
    active: boolean
    screenX: number  // [0, 1] viewport
    screenY: number
  }
  pinch: {
    active: boolean
    zoom: number     // smoothed value
    paused: boolean
  }
  click: boolean     // one-shot on peace_sep release
  back: boolean      // one-shot on peace_close release
}
```

Pinch zoom mapping (stark-shapes style):
- `MIN_PINCH_DIST = 0.04` (fingers touching)
- `MAX_PINCH_DIST = 0.18` (max useful separation)
- `MIN_ZOOM = 0.5` (zoomed out)
- `MAX_ZOOM = 3.0` (zoomed in)
- `SMOOTH_FACTOR = 0.06` (per-frame interpolation)
- Mapping is inverted: less distance = more zoom.
- `zoomSmoothed += (zoomTarget - zoomSmoothed) * SMOOTH_FACTOR`

Grab dead zone: |deltaX| > 0.08 before emitting rotation.

Point: worldLandmarks x/y mapped directly to [0,1] viewport coords.

## Integration

### File structure

```
frontend/src/gestures/
├── features.ts       // Feature Layer
├── state.ts          // State Layer (HandStateTracker)
├── modifiers.ts      // Modifier Layer
├── recognizer.ts     // Gesture Layer
├── output.ts         // Output Layer + smoothing
├── pipeline.ts       // Orchestrator: assembles layers, runs rAF loop
├── config.ts         // All thresholds and constants
└── types.ts          // All gesture system types

frontend/src/hooks/
└── useGesturePipeline.ts  // Hook: init MediaPipe + video + pipeline lifecycle

frontend/src/state/
└── gestureStore.ts        // Zustand: GestureOutput + enabled flag
```

### Runtime

- MediaPipe HandLandmarker in VIDEO mode, GPU delegate preferred, 640x480 input.
- 2 hands max, worldLandmarks enabled.
- Model file: `hand_landmarker.task` served from `public/models/`.
- rAF loop at ~30fps. If detection takes >40ms, skip next frame.
- Pipeline layers 1-5 are <2ms combined; bottleneck is MediaPipe inference.

### Lifecycle

1. `useGesturePipeline()` hook mounts in AwakeApp.
2. When `gestureStore.enabled == true`: request camera, create hidden `<video>`, init HandLandmarker, start loop.
3. When disabled or unmounted: stop stream, dispose HandLandmarker, reset store.
4. Toggle button in UI (similar to existing voice toggle).

### Mapping to app actions

| Output | App action |
|--------|-----------|
| grab.deltaX | `rotateRing(direction)` in ring view; camera rotation in Plan3D/Space |
| point.screenX/Y | Virtual cursor overlay, raycast for hover |
| pinch.zoom | Zoom level controls proximity to holograms (enter/exit via threshold) |
| click | Equivalent to Enter / click on element under cursor |
| back | Equivalent to Escape / `handleBack()` |

### Store subscription

Components subscribe via zustand selectors to specific outputs:
- `WorldScene` → grab.deltaX for ring rotation
- `SpaceViewer` / `Plan3DViewer` → grab for camera, pinch for zoom
- `AwakeApp` → click, back for navigation events

## Testing

- **Unit tests:** features.ts, state.ts, recognizer.ts, output.ts with synthetic landmark data.
- **Integration test:** pipeline.ts with mocked HandLandmarker.
- MediaPipe itself is not tested — trusted as a dependency.
