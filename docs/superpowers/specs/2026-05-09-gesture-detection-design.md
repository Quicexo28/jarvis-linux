# Gesture Detection — Design Spec

**Date**: 2026-05-09
**Project**: jarvis-desktop (frontend)
**Status**: Approved for implementation planning

## Goal

Add a camera-based hand gesture system that lets the user navigate the app and trigger actions through programmable, trainable gestures. The user records example skeleton sequences for each gesture (e.g., "open palm swipe right-to-left"), binds each gesture to an action (e.g., "rotate carousel right"), and the system detects them live from a `MediaPipe Hands` skeleton stream. The configuration UI lives inside the System mode panel.

## Why

The user wants direct, programmable gesture control beyond clap-wake and voice. Static-pose preset libraries were rejected; the user wants their own motion gestures, recorded from their own hand, mapped to their own actions. The trainable model captures both motion (hand moving) and pose change (pinch → open) without the user having to reason about which preset to pick.

The feature complements (does not replace) the keyboard / click / voice inputs. Detection is opt-in and runs locally — no frames leave the device.

## Scope

In scope:
- A new `useHandSkeleton` hook that wraps `@mediapipe/tasks-vision` and emits per-frame skeleton data.
- A trainable gesture model based on DTW (Dynamic Time Warping) matching of skeleton-feature sequences.
- A System panel section to enable the camera, list gestures, record templates, tune thresholds, and bind actions.
- A global gesture runtime that runs whenever gesture detection is enabled and a global toast that surfaces detections.
- A dispatcher mapping `ActionId` to existing app behavior.

Out of scope:
- Backend changes. Detection is 100% frontend.
- Hand tracking inside `Plan2DEditor` / `Plan3DViewer` / `SpaceViewer` for in-canvas controls — v1 only triggers app-level actions; canvas-internal gesture mappings are deferred.
- Body / face tracking. Only hand landmarks.
- Two-handed gesture composition beyond what the recorded samples naturally express.
- Custom backend payloads beyond the simple `jarvis.turn` text message hook.

## Architecture overview

```
camera (getUserMedia)
   ↓
<video> (hidden)
   ↓
useHandSkeleton (MediaPipe HandLandmarker.detectForVideo)
   ↓ HandFrame { hands: Hand[], timestamp }
GestureRuntime (mounts in AwakeApp)
   ├── ring buffer of last 60 frames
   ├── matcher (DTW per template, runs every 200ms)
   ├── cooldown gate (800ms global)
   └── on match → dispatchAction + emit toast
   ↓
gestureDispatcher → existing stores (jarvisStore, bootStore) or fetch backend
```

The skeleton stream is also exposed for live preview rendering inside the System panel (skeleton overlay on a mirrored canvas). When the panel is closed, the stream is consumed only by the matcher.

## Section A — Skeleton capture

**Library**: `@mediapipe/tasks-vision` with the `hand_landmarker.task` model. Bundled or served from `frontend/public/models/`. Lazy-loaded on first activation; cached afterwards.

**Capabilities**:
- 21 landmarks per hand in 3D, up to 2 hands.
- ~30 fps on modern CPU; up to 60 fps with WebGL/WebGPU delegate.
- Permissive license, no auth required.

**Hook signature** (`frontend/src/hooks/useHandSkeleton.ts`):

```ts
type Hand = {
  landmarks: { x: number; y: number; z: number }[]   // length 21
  handedness: 'Left' | 'Right'
}

type HandFrame = {
  hands: Hand[]
  timestamp: number
}

export function useHandSkeleton(opts: {
  enabled: boolean
  onFrame: (frame: HandFrame) => void
}): void
```

Lifecycle (mirrors `useClapDetection.ts`):
1. On `enabled=true`: `getUserMedia({ video: { width: 320, height: 240, frameRate: 30 } })`.
2. Wire stream into a hidden `<video>` element.
3. Construct `HandLandmarker` with `runningMode: 'VIDEO'`.
4. Loop: `requestAnimationFrame` → `detectForVideo(video, performance.now())` → emit frame if `hands.length > 0`.
5. Pause when `document.hidden` (Page Visibility API), resume on visibility.
6. On `enabled=false` or unmount: stop stream tracks, close `HandLandmarker`, clear timers.

**Resolution rationale**: 320×240 is enough for landmark accuracy and keeps inference under ~30 ms on integrated GPUs. Higher resolutions hurt frame rate without measurable accuracy gain at this distance.

**Permissions**: standard browser camera prompt fired on first activation. If denied, hook fails silently and the System panel shows an inline notice.

## Section B — Trainable gesture model

A gesture is a temporal sequence of skeleton-feature vectors, not a static pose. This captures both motion (palm moves right-to-left) and pose change (pinch → open).

### Per-frame feature vector (24 dimensions)

Computed from the dominant hand each frame:

| Group                  | Dims | Description                                     |
|------------------------|-----:|-------------------------------------------------|
| Palm center            |   3  | `(cx, cy, cz)` of palm centroid, normalized     |
| Palm→index orientation |   3  | unit vector from palm to index tip              |
| Per-finger openness    |   5  | normalized tip-to-base distance, per finger     |
| Pinch distance         |   1  | normalized thumb-tip ↔ index-tip distance       |
| Thumb to other tips    |   3  | thumb-tip to {middle, ring, pinky} distances    |
| Hand orientation       |   3  | approx roll, pitch, yaw of the hand frame       |
| Palm velocity          |   3  | first difference of palm center vs prior frame  |
| Total openness         |   1  | mean of finger openness                         |
| Handedness             |   1  | left = −1, right = +1                            |

Normalization: position centered on the centroid of all landmarks; scale divided by the wrist→middle-tip span. The matcher becomes invariant to absolute hand position and apparent size.

### Template structure

```ts
type GestureTemplate = {
  id: string                    // ulid
  label: string                 // user-facing name
  actionId: ActionId            // dispatcher key (Section D)
  payload?: string              // for ActionId='jarvis.turn', the message text
  samples: number[][][]         // 3-5 samples, each samples[k] = N frames × 24 features
  durationMs: number            // mean duration of samples
  threshold: number             // DTW score threshold for match (multiplier)
}
```

Stored in `localStorage` under `jarvis.gestures.templates.v1`. Estimated size: 5 templates × 4 samples × 30 frames × 24 floats ≈ 60 KB.

### Recording flow

1. User opens "+ Nuevo gesto" modal in the System panel.
2. **Step 1 — Datos**: name + action dropdown.
3. **Step 2 — Grabar muestras**:
   - Live preview with skeleton overlay.
   - Per slot (1, 2, 3 required; 4, 5 optional):
     - Press "Grabar muestra N".
     - Countdown 3-2-1.
     - Capture 1.5 s of skeleton frames.
     - Validate ≥15 frames had a hand detected. If not, reject with "Mantén la mano visible" and discard.
     - Show start+end pose thumbnails in the slot.
   - Per-slot "Re-grabar" button.
4. **Step 3 — Tuning**:
   - Threshold slider (0.5×–2.0× of the auto-default).
   - "Probar gesto" runs a 10 s live test, counting detections and showing live score.
   - Save / Cancel.

Default threshold computation: `worst_score = max(score(sample_i, sample_j) for i ≠ j)` across the recorded samples, then `threshold = worst_score × 1.4`. This sets the matcher to allow as much variance as the user already showed during recording, plus 40% grace.

### Live matcher

Runs continuously inside `<GestureRuntime />` while `gestureEnabled`:

1. Maintain a ring buffer of the last 60 skeleton-feature frames (~2 s at 30 fps).
2. Every 200 ms (≈ every 6 frames), for each template:
   - Slice a window from the buffer sized to `template.durationMs ± 30%`.
   - Compute DTW score between the window and each `template.samples[k]`.
   - Take `score = min(scores)` (best match against any sample).
3. If `score < template.threshold` → emit a detection event for that template.
4. After any detection: enter 800 ms global cooldown — no further detections fire until cooldown elapses.

### DTW

Classic O(n·m) implementation. With n, m ≤ 60 frames, ~3,600 ops per template per matcher tick; ten templates × four samples × 5 ticks/s = ~720,000 ops/s, ≈ 6 ms/s of CPU on modern hardware.

Distance between two frames: weighted Euclidean

```
d(f_a, f_b) = sqrt(Σ_i w_i · (f_a[i] - f_b[i])²)
```

Weights elevate palm center (×2) and palm velocity (×2) over individual finger openness. Tuning lives in a constants module so it can be adjusted by feel without touching the matcher.

If matcher CPU becomes a problem (not expected at v1 scale): move into a Web Worker. Deferred.

### Edge cases

- **No hand in frame**: matcher does nothing for that tick.
- **One hand vs two**: matcher uses the most recently seen hand. Templates recorded with two hands store both, but v1 matching considers only the dominant frame.
- **Gesture too short** (<300 ms): recording rejects the sample.
- **Gesture too long** (>2.5 s): recording truncates to the matcher buffer length and warns the user.
- **Threshold too loose**: tuning slider lets the user tighten; debug overlay shows live scores.

## Section C — System panel UI

The gesture configuration UI is inserted into the existing `HudPanel mode="System"` (`AwakeApp.tsx:338-413`), under the existing "CONEXION MOVIL" block. Visual style matches the rest of the System panel (cyan/dark theme, mono-spaced labels, glass cards).

### Sections inside the panel

1. **Header**:
   - Label `GESTOS` (same style as `CONEXION MOVIL`).
   - "Activar cámara" toggle (`HudBtn`). On first activation, browser permission prompt fires. State persisted.

2. **Live preview** (only when `gestureEnabled=true`):
   - 240 × 180 canvas on the left side of the block.
   - Mirrored camera frame.
   - Skeleton overlay: 21 landmarks + bone segments per hand. Right hand = `#00f0ff`, left hand = `#ff66dd`.
   - Bottom-corner debug badge with current fps; togglable.

3. **Gesture list** (right side, scrollable when content overflows):
   - Each template renders a card:
     ```
     ┌────────────────────────────────────┐
     │ ✋→ Mano abierta swipe izq         │
     │    → Rotar carrusel derecha       │
     │    [3 muestras · umbral 1.0×]     │
     │    [Probar]  [Editar]  [Borrar]   │
     └────────────────────────────────────┘
     ```
   - "Probar": isolates the template; matches still fire but bypass the dispatcher and only show "DETECTADO" feedback.
   - "Editar": opens the recorder modal pre-filled with the existing template.
   - Live confidence: while the matcher computes scores, the card border lights proportionally to `1 - score / threshold` for that template. Provides intuitive tuning feedback.

4. **"+ Nuevo gesto"** button at the end of the list.

### Recorder modal

Overlay on top of the System panel; covers ~70% of the viewport. Steps detailed in Section B's recording flow.

### Detection toast (global)

Independent of the System panel — mounted near the status bar in `AwakeApp.tsx`. When a gesture fires, a small `GlassPanel`-styled toast appears top-center for ~600 ms:

```
╭───────────────────╮
│  ✋  Mano abierta  │
│    swipe izq      │
╰───────────────────╯
```

Fades in/out. Stack-collapses if multiple gestures fire (rare due to cooldown).

When the System panel is not active:
- The hook still runs (always-on while `gestureEnabled`).
- The skeleton overlay canvas is not rendered.
- The matcher fires actions and the global toast surfaces them.

## Section D — Action vocabulary and wireup

### Action catalog

```ts
type ActionId =
  // Carousel (depends on hologram-carousel-design.md being implemented)
  | 'ring.rotate.left'
  | 'ring.rotate.right'
  | 'ring.enter'
  | 'ring.back'
  // Voice / system
  | 'voice.toggle'
  | 'voice.wake'
  | 'system.sleep'
  // Backend
  | 'jarvis.turn'             // requires payload (text message)
```

### Dispatcher

`frontend/src/gestures/dispatcher.ts`:

```ts
export function dispatchAction(actionId: ActionId, payload?: string) {
  switch (actionId) {
    case 'ring.rotate.left': {
      const s = useJarvisStore.getState()
      if (s.zoomedMode == null) s.rotateRing(-1)
      return
    }
    case 'ring.rotate.right': {
      const s = useJarvisStore.getState()
      if (s.zoomedMode == null) s.rotateRing(+1)
      return
    }
    case 'ring.enter': {
      const { activeRingMode, ringLevel, setZoomedMode, setRingLevel } = useJarvisStore.getState()
      if (ringLevel === 'main' && activeRingMode === 'house') setRingLevel('house-sub')
      else setZoomedMode(activeRingMode)
      return
    }
    case 'ring.back': {
      const { zoomedMode, ringLevel, setZoomedMode, setRingLevel } = useJarvisStore.getState()
      if (zoomedMode != null) setZoomedMode(null)
      else if (ringLevel === 'house-sub') setRingLevel('main')
      return
    }
    case 'voice.toggle': useJarvisStore.getState().setVoiceEnabled(!useJarvisStore.getState().voiceEnabled); return
    case 'voice.wake':   gestureEvents.emit('voice.wake'); return
    case 'system.sleep': useBootStore.getState().setBootState('DORMANT'); return
    case 'jarvis.turn':  if (payload) gestureEvents.emit('jarvis.turn', payload); return
  }
}
```

`handleWakeDetected` and `sendCoreTurn` currently live as closures inside `AwakeApp.tsx` (`AwakeApp.tsx:179-242`) and depend on local state (`mode`, `voiceEnabled`, `setCoreReply`, etc.). To avoid lifting them out of the component or creating a circular dependency, the dispatcher emits events through a tiny pub/sub helper (`gestures/events.ts`):

```ts
type GestureEventName = 'voice.wake' | 'jarvis.turn'
export const gestureEvents = createEmitter<GestureEventName>()
```

`AwakeApp.tsx` subscribes on mount: `gestureEvents.on('voice.wake', handleWakeDetected)` and `gestureEvents.on('jarvis.turn', (msg) => sendCoreTurn(msg))`, returning the unsubscribe in cleanup. The dispatcher stays decoupled from React tree state; AwakeApp keeps owning the closures.

This pattern is intentional: only the actions that need component-local closures route through events. Pure store mutations (`rotate`, `setZoomedMode`, `setBootState`, `setVoiceEnabled`) call the stores directly — no event indirection.

State preconditions:
- `ring.rotate.*` no-ops when `zoomedMode != null` (only meaningful from the carousel).
- `ring.back` mirrors the existing Esc / Volver decision tree.
- Voice and system actions work in any state.

No conflict with keyboard input: gestures and keys both call the same underlying functions.

### Wireup in `AwakeApp.tsx`

Mount near the root:

```tsx
<GestureRuntime />     // hook + matcher + dispatch (no DOM beyond toast)
<GestureToast />       // global, top-center
```

Inside the System panel block, mount `<GesturePanel />` (which itself opens the `<GestureRecorderModal />` when needed).

## File-level changes

### New files

| File | Purpose |
|------|---------|
| `frontend/src/hooks/useHandSkeleton.ts` | MediaPipe lifecycle hook |
| `frontend/src/state/gestureStore.ts` | zustand store: `gestureEnabled`, `templates`, CRUD setters |
| `frontend/src/gestures/features.ts` | per-frame 24-dim feature extractor |
| `frontend/src/gestures/dtw.ts` | DTW algorithm + helpers (window slicing, distance) |
| `frontend/src/gestures/dispatcher.ts` | `ActionId` type + `dispatchAction` |
| `frontend/src/gestures/events.ts` | tiny `createEmitter` for `voice.wake` / `jarvis.turn` (decouples dispatcher from `AwakeApp` closures) |
| `frontend/src/components/GestureRuntime.tsx` | orchestrates hook, ring buffer, matcher, dispatch, toast emit |
| `frontend/src/components/GestureToast.tsx` | global detection toast |
| `frontend/src/components/GesturePanel.tsx` | gestures section inside System panel |
| `frontend/src/components/GestureRecorderModal.tsx` | 3-step record/edit/tune modal |

### Modified files

| File | Change |
|------|--------|
| `frontend/src/AwakeApp.tsx` | Mount `<GestureRuntime />` and `<GestureToast />` near the root. Inside the `system` panel block, render `<GesturePanel />` after the "CONEXION MOVIL" block. Subscribe to `gestureEvents` for `voice.wake` and `jarvis.turn` inside a `useEffect`, calling the existing `handleWakeDetected` and `sendCoreTurn` closures, with an unsubscribe in cleanup. |
| `frontend/package.json` | Add `@mediapipe/tasks-vision`. |
| `frontend/public/models/` | Add `hand_landmarker.task` (~7 MB). Alternative: load from CDN at runtime. Preferred: ship in `public/models/` to keep behavior offline. |

### Tests

`frontend/src/gestures/`:
- `dtw.test.ts` — identical sequences score 0; reversed sequences score high; small jitter scores low.
- `features.test.ts` — fixture landmark sets: pinch detected when thumb-index distance < threshold; open palm produces high openness across fingers.
- `dispatcher.test.ts` — `ring.enter` on `house` with `ringLevel='main'` flips to `house-sub`; `ring.rotate.left` while `zoomedMode='home'` is a no-op; `voice.toggle` flips the store flag.

`frontend/src/state/gestureStore.test.ts` — CRUD: add template, update threshold, delete, toggle enabled, persistence to localStorage.

A scene-level / hook test for `useHandSkeleton` is not required; manual smoke testing covers the camera path. If desired later, a small mocked-stream test can verify lifecycle.

## Performance budget

- MediaPipe inference: 30–60 ms per frame on integrated GPU.
- DTW matching: ~6 ms/sec total CPU at 10 templates.
- Skeleton overlay (when System panel open): negligible, 21 × 2 hands of canvas 2D points.
- The R3F WorldScene render budget is unaffected — gesture runtime does not touch the canvas.

If matcher cost grows (large template count) or inference visibly stalls the main thread: move both into a Web Worker. Not in v1.

## Privacy

- All processing local. No camera frames or skeletons are transmitted.
- Camera is requested on opt-in only; toggling off stops the `MediaStream` tracks and releases the camera (the indicator light goes off).
- The model file is loaded once (locally or from CDN); no telemetry.
- Page Visibility API pauses inference when the window is hidden, so the camera stays on but no frames are processed in the background.

## Risks and trade-offs

- **Lighting / framing**: MediaPipe is reasonably robust but fails on partial / off-screen hands. UI shows a hint when no hand is detected for >2 s.
- **False positives**: motivated the 800 ms cooldown and per-template tunable thresholds.
- **Model size**: 7 MB initial download. Lazy-loaded on first activation; cached by the browser thereafter.
- **Coupling to carousel**: `ring.*` actions assume the hologram carousel design (`2026-05-09-hologram-carousel-design.md`) is in place. If gestures ship before the carousel, those `ActionId`s become no-ops until the carousel state exists. The dispatcher fails silently in that case, which is the desired behavior.
- **Main-thread inference**: at v1 we run MediaPipe on the main thread. If this causes frame drops in the WorldScene, the fix is a Web Worker — known and reachable.

## Open questions deferred to implementation

- Exact JS bundle of MediaPipe (`@mediapipe/tasks-vision` vs the older `@mediapipe/hands` package). Preference: tasks-vision (newer, maintained); confirm during install that browser support matches our targets.
- Whether the model file ships in `frontend/public/models/` or loads from a CDN (jsdelivr). Default: ship locally for offline work.
- Service-worker caching strategy for the model (defer until/if PWA ambitions appear).
- Visual style of the recorder modal — design lives in feel, decided during implementation against the existing `GlassPanel` / `HudPanel` palette.
