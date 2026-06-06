# Gesture Recognition v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a 5-layer hand gesture pipeline (features → state → modifiers → gestures → output) using MediaPipe HandLandmarker for navigating the jarvis-desktop 3D UI with hand poses.

**Architecture:** Each layer is a pure module with explicit input/output types. The pipeline orchestrator runs in a requestAnimationFrame loop, feeding MediaPipe worldLandmarks through all layers and writing the final output to a zustand store. React components subscribe to gesture outputs via selectors.

**Tech Stack:** TypeScript, MediaPipe Tasks Vision (@mediapipe/tasks-vision already installed), Zustand, Vitest, React hooks.

---

## File Map

| File | Responsibility |
|------|---------------|
| `frontend/src/gestures/types.ts` | All gesture system types (shared across layers) |
| `frontend/src/gestures/config.ts` | All thresholds, constants, tuning parameters |
| `frontend/src/gestures/features.ts` | Layer 1: extract curl ratios + tip distances from landmarks |
| `frontend/src/gestures/features.test.ts` | Unit tests for feature extraction |
| `frontend/src/gestures/state.ts` | Layer 2: HandStateTracker with hysteresis |
| `frontend/src/gestures/state.test.ts` | Unit tests for state discretization |
| `frontend/src/gestures/modifiers.ts` | Layer 3: Pause modifier state machine |
| `frontend/src/gestures/modifiers.test.ts` | Unit tests for modifier transitions |
| `frontend/src/gestures/recognizer.ts` | Layer 4: Rule-based gesture matching |
| `frontend/src/gestures/recognizer.test.ts` | Unit tests for gesture recognition |
| `frontend/src/gestures/output.ts` | Layer 5: Map gestures to actions with smoothing |
| `frontend/src/gestures/output.test.ts` | Unit tests for output mapping |
| `frontend/src/gestures/pipeline.ts` | Orchestrator: assembles layers, runs rAF loop |
| `frontend/src/state/gestureStore.ts` | Zustand store for GestureOutput + enabled flag |
| `frontend/src/hooks/useGesturePipeline.ts` | React hook: MediaPipe init + video + lifecycle |

---

### Task 1: Types and Config

**Files:**
- Create: `frontend/src/gestures/types.ts`
- Create: `frontend/src/gestures/config.ts`

- [ ] **Step 1: Create types.ts with all shared types**

```typescript
// frontend/src/gestures/types.ts

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface HandFeatures {
  palmSize: number
  curl: {
    thumb: number
    index: number
    middle: number
    ring: number
    pinky: number
  }
  tipDistances: {
    thumbIndex: number
    indexMiddle: number
    middleRing: number
    ringPinky: number
  }
  wristPosition: Vec3
  indexTipPosition: Vec3
}

export type FingerState = 'extended' | 'half' | 'contracted'

export interface HandState {
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

export type GestureId = 'grab' | 'pinch' | 'point' | 'peace_sep' | 'peace_close' | 'idle'

export interface GestureResult {
  left: GestureId
  right: GestureId
}

export interface ActiveGesture {
  id: GestureId
  hand: 'left' | 'right'
  continuousValue?: number
}

export type ModifierStatus =
  | { type: 'none' }
  | { type: 'paused'; frozenValue: number }
  | { type: 'waiting_resume'; frozenValue: number; target: number; tolerance: number }

export interface GestureOutput {
  grab: {
    active: boolean
    deltaX: number
    deltaY: number
  }
  point: {
    active: boolean
    screenX: number
    screenY: number
  }
  pinch: {
    active: boolean
    zoom: number
    paused: boolean
  }
  click: boolean
  back: boolean
}
```

- [ ] **Step 2: Create config.ts with all constants**

```typescript
// frontend/src/gestures/config.ts

// Layer 2 — State hysteresis thresholds
export const CURL_CONTRACTED_ENTER = 0.45
export const CURL_CONTRACTED_EXIT = 0.50
export const CURL_EXTENDED_ENTER = 0.75
export const CURL_EXTENDED_EXIT = 0.70

// Layer 2 — Contact thresholds (normalized by palmSize)
export const CONTACT_THUMB_INDEX_ENTER = 0.15
export const CONTACT_THUMB_INDEX_EXIT = 0.22

// Layer 3 — Modifier
export const PAUSE_RESUME_TOLERANCE = 0.05
export const PAUSE_TIMEOUT_MS = 3000

// Layer 4 — Gesture recognition
export const PEACE_SEP_MIN_DISTANCE = 0.4
export const PEACE_CLOSE_MAX_DISTANCE = 0.25
export const DISCRETE_MIN_HOLD_MS = 150

// Layer 5 — Output
export const MIN_PINCH_DIST = 0.04
export const MAX_PINCH_DIST = 0.18
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 3.0
export const ZOOM_SMOOTH_FACTOR = 0.06
export const GRAB_DEAD_ZONE = 0.08
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/gestures/types.ts frontend/src/gestures/config.ts
git commit -m "feat(gestures): add types and config for gesture pipeline v2"
```

---

### Task 2: Feature Layer

**Files:**
- Create: `frontend/src/gestures/features.ts`
- Create: `frontend/src/gestures/features.test.ts`

- [ ] **Step 1: Write failing tests for extractFeatures**

```typescript
// frontend/src/gestures/features.test.ts
import { test, expect } from 'vitest'
import { extractFeatures } from './features'
import type { Vec3 } from './types'

// Helper: create a landmark array of 21 points
function makeLandmarks(overrides: Partial<Record<number, Vec3>> = {}): Vec3[] {
  const base: Vec3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }))
  // Default: wrist at origin, middle_MCP at (0, 0.1, 0) → palmSize = 0.1
  base[0] = { x: 0, y: 0, z: 0 }
  base[9] = { x: 0, y: 0.1, z: 0 }
  for (const [idx, val] of Object.entries(overrides)) {
    base[Number(idx)] = val
  }
  return base
}

test('palmSize is distance between wrist[0] and middle_MCP[9]', () => {
  const landmarks = makeLandmarks({
    0: { x: 0, y: 0, z: 0 },
    9: { x: 0.03, y: 0.04, z: 0 },
  })
  const features = extractFeatures(landmarks)
  expect(features.palmSize).toBeCloseTo(0.05, 5)
})

test('curl ratio is 1.0 for a fully extended finger', () => {
  // Index: MCP[5], PIP[6], DIP[7], TIP[8] in a straight line
  const landmarks = makeLandmarks({
    5: { x: 0, y: 0, z: 0 },
    6: { x: 0, y: 0.03, z: 0 },
    7: { x: 0, y: 0.06, z: 0 },
    8: { x: 0, y: 0.09, z: 0 },
  })
  const features = extractFeatures(landmarks)
  expect(features.curl.index).toBeCloseTo(1.0, 2)
})

test('curl ratio is low for a contracted finger', () => {
  // Index: TIP curled back near MCP
  const landmarks = makeLandmarks({
    5: { x: 0, y: 0, z: 0 },
    6: { x: 0, y: 0.03, z: 0 },
    7: { x: 0, y: 0.04, z: 0.02 },
    8: { x: 0, y: 0.01, z: 0.01 },
  })
  const features = extractFeatures(landmarks)
  expect(features.curl.index).toBeLessThan(0.5)
})

test('tipDistances are normalized by palmSize', () => {
  const landmarks = makeLandmarks({
    0: { x: 0, y: 0, z: 0 },
    9: { x: 0, y: 0.1, z: 0 }, // palmSize = 0.1
    4: { x: 0, y: 0, z: 0 },   // thumb tip
    8: { x: 0, y: 0.05, z: 0 }, // index tip → raw distance 0.05
  })
  const features = extractFeatures(landmarks)
  expect(features.tipDistances.thumbIndex).toBeCloseTo(0.5, 2) // 0.05 / 0.1
})

test('wristPosition and indexTipPosition are extracted directly', () => {
  const landmarks = makeLandmarks({
    0: { x: 0.1, y: 0.2, z: 0.3 },
    8: { x: 0.4, y: 0.5, z: 0.6 },
  })
  const features = extractFeatures(landmarks)
  expect(features.wristPosition).toEqual({ x: 0.1, y: 0.2, z: 0.3 })
  expect(features.indexTipPosition).toEqual({ x: 0.4, y: 0.5, z: 0.6 })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/gestures/features.test.ts`
Expected: FAIL — module `./features` not found

- [ ] **Step 3: Implement extractFeatures**

```typescript
// frontend/src/gestures/features.ts
import type { Vec3, HandFeatures } from './types'

function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function curlRatio(mcp: Vec3, pip: Vec3, dip: Vec3, tip: Vec3): number {
  const chainLength = dist(mcp, pip) + dist(pip, dip) + dist(dip, tip)
  if (chainLength < 1e-6) return 0
  return dist(mcp, tip) / chainLength
}

function thumbCurlRatio(cmc: Vec3, mcp: Vec3, ip: Vec3, tip: Vec3): number {
  const chainLength = dist(cmc, mcp) + dist(mcp, ip) + dist(ip, tip)
  if (chainLength < 1e-6) return 0
  return dist(cmc, tip) / chainLength
}

export function extractFeatures(landmarks: Vec3[]): HandFeatures {
  const wrist = landmarks[0]
  const middleMcp = landmarks[9]
  const palmSize = dist(wrist, middleMcp)
  const normFactor = palmSize > 1e-6 ? palmSize : 1

  const curl = {
    thumb: thumbCurlRatio(landmarks[1], landmarks[2], landmarks[3], landmarks[4]),
    index: curlRatio(landmarks[5], landmarks[6], landmarks[7], landmarks[8]),
    middle: curlRatio(landmarks[9], landmarks[10], landmarks[11], landmarks[12]),
    ring: curlRatio(landmarks[13], landmarks[14], landmarks[15], landmarks[16]),
    pinky: curlRatio(landmarks[17], landmarks[18], landmarks[19], landmarks[20]),
  }

  const tipDistances = {
    thumbIndex: dist(landmarks[4], landmarks[8]) / normFactor,
    indexMiddle: dist(landmarks[8], landmarks[12]) / normFactor,
    middleRing: dist(landmarks[12], landmarks[16]) / normFactor,
    ringPinky: dist(landmarks[16], landmarks[20]) / normFactor,
  }

  return {
    palmSize,
    curl,
    tipDistances,
    wristPosition: { x: wrist.x, y: wrist.y, z: wrist.z },
    indexTipPosition: { x: landmarks[8].x, y: landmarks[8].y, z: landmarks[8].z },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/gestures/features.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/gestures/features.ts frontend/src/gestures/features.test.ts
git commit -m "feat(gestures): implement feature extraction layer with tests"
```

---

### Task 3: State Layer

**Files:**
- Create: `frontend/src/gestures/state.ts`
- Create: `frontend/src/gestures/state.test.ts`

- [ ] **Step 1: Write failing tests for HandStateTracker**

```typescript
// frontend/src/gestures/state.test.ts
import { test, expect, beforeEach } from 'vitest'
import { HandStateTracker } from './state'
import type { HandFeatures } from './types'

function makeFeatures(overrides: Partial<HandFeatures> = {}): HandFeatures {
  return {
    palmSize: 0.1,
    curl: { thumb: 0.9, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 },
    tipDistances: { thumbIndex: 0.8, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 },
    wristPosition: { x: 0, y: 0, z: 0 },
    indexTipPosition: { x: 0, y: 0, z: 0 },
    ...overrides,
  }
}

let tracker: HandStateTracker

beforeEach(() => {
  tracker = new HandStateTracker()
})

test('all fingers extended when curl > 0.75 → isIdle true', () => {
  const state = tracker.update(makeFeatures())
  expect(state.isIdle).toBe(true)
  expect(state.extendedCount).toBe(5)
  expect(state.fingers.index).toBe('extended')
})

test('all fingers contracted when curl < 0.45', () => {
  const features = makeFeatures({
    curl: { thumb: 0.3, index: 0.3, middle: 0.3, ring: 0.3, pinky: 0.3 },
  })
  const state = tracker.update(features)
  expect(state.fingers.index).toBe('contracted')
  expect(state.fingers.thumb).toBe('contracted')
  expect(state.isIdle).toBe(false)
  expect(state.extendedCount).toBe(0)
})

test('hysteresis prevents flicker at boundary', () => {
  // Start extended (curl=0.9)
  tracker.update(makeFeatures({ curl: { thumb: 0.9, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 } }))
  // Drop to 0.72 — still above exit threshold 0.70, should stay extended
  const state = tracker.update(makeFeatures({ curl: { thumb: 0.72, index: 0.72, middle: 0.72, ring: 0.72, pinky: 0.72 } }))
  expect(state.fingers.index).toBe('extended')
  // Drop to 0.68 — below exit threshold 0.70, should become half
  const state2 = tracker.update(makeFeatures({ curl: { thumb: 0.68, index: 0.68, middle: 0.68, ring: 0.68, pinky: 0.68 } }))
  expect(state2.fingers.index).toBe('half')
})

test('contact thumbIndex enters when distance < 0.15', () => {
  const state = tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.10, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  expect(state.contacts.thumbIndex).toBe(true)
})

test('contact thumbIndex has exit hysteresis at 0.22', () => {
  // Enter contact
  tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.10, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  // Move to 0.18 — above enter threshold but below exit threshold, stays in contact
  const state = tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.18, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  expect(state.contacts.thumbIndex).toBe(true)
  // Move to 0.25 — above exit threshold, loses contact
  const state2 = tracker.update(makeFeatures({ tipDistances: { thumbIndex: 0.25, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } }))
  expect(state2.contacts.thumbIndex).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/gestures/state.test.ts`
Expected: FAIL — module `./state` not found

- [ ] **Step 3: Implement HandStateTracker**

```typescript
// frontend/src/gestures/state.ts
import type { HandFeatures, HandState, FingerState } from './types'
import {
  CURL_CONTRACTED_ENTER, CURL_CONTRACTED_EXIT,
  CURL_EXTENDED_ENTER, CURL_EXTENDED_EXIT,
  CONTACT_THUMB_INDEX_ENTER, CONTACT_THUMB_INDEX_EXIT,
} from './config'

type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'
const FINGER_NAMES: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky']

function nextFingerState(current: FingerState, curl: number): FingerState {
  switch (current) {
    case 'contracted':
      if (curl > CURL_CONTRACTED_EXIT) return 'half'
      return 'contracted'
    case 'half':
      if (curl < CURL_CONTRACTED_ENTER) return 'contracted'
      if (curl > CURL_EXTENDED_ENTER) return 'extended'
      return 'half'
    case 'extended':
      if (curl < CURL_EXTENDED_EXIT) return 'half'
      return 'extended'
  }
}

export class HandStateTracker {
  private fingerStates: Record<FingerName, FingerState> = {
    thumb: 'extended', index: 'extended', middle: 'extended', ring: 'extended', pinky: 'extended',
  }
  private thumbIndexContact = false

  update(features: HandFeatures): HandState {
    for (const name of FINGER_NAMES) {
      this.fingerStates[name] = nextFingerState(this.fingerStates[name], features.curl[name])
    }

    if (this.thumbIndexContact) {
      if (features.tipDistances.thumbIndex > CONTACT_THUMB_INDEX_EXIT) {
        this.thumbIndexContact = false
      }
    } else {
      if (features.tipDistances.thumbIndex < CONTACT_THUMB_INDEX_ENTER) {
        this.thumbIndexContact = true
      }
    }

    const fingers = { ...this.fingerStates }
    let extendedCount = 0
    for (const name of FINGER_NAMES) {
      if (fingers[name] === 'extended') extendedCount++
    }

    return {
      fingers,
      contacts: { thumbIndex: this.thumbIndexContact },
      isIdle: extendedCount === 5,
      extendedCount,
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/gestures/state.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/gestures/state.ts frontend/src/gestures/state.test.ts
git commit -m "feat(gestures): implement state layer with hysteresis"
```

---

### Task 4: Modifier Layer

**Files:**
- Create: `frontend/src/gestures/modifiers.ts`
- Create: `frontend/src/gestures/modifiers.test.ts`

- [ ] **Step 1: Write failing tests for ModifierLayer**

```typescript
// frontend/src/gestures/modifiers.test.ts
import { test, expect, beforeEach } from 'vitest'
import { ModifierLayer } from './modifiers'
import type { HandState, ActiveGesture } from './types'

function makeHandState(pinky: 'extended' | 'half' | 'contracted' = 'contracted'): HandState {
  return {
    fingers: { thumb: 'contracted', index: 'contracted', middle: 'contracted', ring: 'contracted', pinky },
    contacts: { thumbIndex: true },
    isIdle: false,
    extendedCount: pinky === 'extended' ? 1 : 0,
  }
}

let modifier: ModifierLayer

beforeEach(() => {
  modifier = new ModifierLayer()
})

test('status is none when no active gesture', () => {
  const status = modifier.update(makeHandState('extended'), null, 0.5, 0)
  expect(status.type).toBe('none')
})

test('transitions to paused when pinky extends during pinch', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  const status = modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  expect(status.type).toBe('paused')
  if (status.type === 'paused') {
    expect(status.frozenValue).toBe(1.5)
  }
})

test('transitions to waiting_resume when pinky lowers after pause', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  const status = modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  expect(status.type).toBe('waiting_resume')
})

test('resumes when distance matches target within tolerance', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  // Return to within tolerance of 0.08 target
  const status = modifier.update(makeHandState('contracted'), gesture, 0.082, 200)
  expect(status.type).toBe('none')
})

test('times out after 3s without match', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  // 3.1 seconds later, still not matched
  const status = modifier.update(makeHandState('contracted'), gesture, 0.30, 3200)
  expect(status.type).toBe('none')
})

test('re-pauses if pinky extends again during waiting_resume', () => {
  const gesture: ActiveGesture = { id: 'pinch', hand: 'right', continuousValue: 1.5 }
  modifier.update(makeHandState('extended'), gesture, 0.08, 0)
  modifier.update(makeHandState('contracted'), gesture, 0.12, 100)
  const status = modifier.update(makeHandState('extended'), gesture, 0.12, 200)
  expect(status.type).toBe('paused')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/gestures/modifiers.test.ts`
Expected: FAIL — module `./modifiers` not found

- [ ] **Step 3: Implement ModifierLayer**

```typescript
// frontend/src/gestures/modifiers.ts
import type { HandState, ActiveGesture, ModifierStatus } from './types'
import { PAUSE_RESUME_TOLERANCE, PAUSE_TIMEOUT_MS } from './config'

type InternalState = 'none' | 'paused' | 'waiting_resume'

export class ModifierLayer {
  private state: InternalState = 'none'
  private frozenValue = 0
  private target = 0
  private waitingStartedAt = 0

  update(
    rightState: HandState,
    activeGesture: ActiveGesture | null,
    currentThumbIndexDist: number,
    timestampMs: number,
  ): ModifierStatus {
    const pinkyExtended = rightState.fingers.pinky === 'extended'
    const isPinchActive = activeGesture?.id === 'pinch'

    switch (this.state) {
      case 'none':
        if (pinkyExtended && isPinchActive) {
          this.state = 'paused'
          this.frozenValue = activeGesture!.continuousValue ?? 0
          this.target = currentThumbIndexDist
        }
        break

      case 'paused':
        if (!pinkyExtended) {
          this.state = 'waiting_resume'
          this.waitingStartedAt = timestampMs
        }
        break

      case 'waiting_resume':
        if (pinkyExtended) {
          this.state = 'paused'
          break
        }
        if (Math.abs(currentThumbIndexDist - this.target) < PAUSE_RESUME_TOLERANCE) {
          this.state = 'none'
          break
        }
        if (timestampMs - this.waitingStartedAt > PAUSE_TIMEOUT_MS) {
          this.state = 'none'
          break
        }
        break
    }

    switch (this.state) {
      case 'none':
        return { type: 'none' }
      case 'paused':
        return { type: 'paused', frozenValue: this.frozenValue }
      case 'waiting_resume':
        return {
          type: 'waiting_resume',
          frozenValue: this.frozenValue,
          target: this.target,
          tolerance: PAUSE_RESUME_TOLERANCE,
        }
    }
  }

  reset(): void {
    this.state = 'none'
    this.frozenValue = 0
    this.target = 0
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/gestures/modifiers.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/gestures/modifiers.ts frontend/src/gestures/modifiers.test.ts
git commit -m "feat(gestures): implement modifier layer (pause state machine)"
```

---

### Task 5: Gesture Recognizer Layer

**Files:**
- Create: `frontend/src/gestures/recognizer.ts`
- Create: `frontend/src/gestures/recognizer.test.ts`

- [ ] **Step 1: Write failing tests for gesture recognition**

```typescript
// frontend/src/gestures/recognizer.test.ts
import { test, expect, beforeEach } from 'vitest'
import { GestureRecognizer } from './recognizer'
import type { HandState, HandFeatures } from './types'

function makeState(
  fingers: Record<string, 'extended' | 'half' | 'contracted'>,
  contacts = { thumbIndex: false },
): HandState {
  const f = {
    thumb: 'extended' as const,
    index: 'extended' as const,
    middle: 'extended' as const,
    ring: 'extended' as const,
    pinky: 'extended' as const,
    ...fingers,
  }
  const extendedCount = Object.values(f).filter(v => v === 'extended').length
  return {
    fingers: f,
    contacts,
    isIdle: extendedCount === 5,
    extendedCount,
  }
}

function makeFeatures(tipDistances = { thumbIndex: 0.8, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 }): HandFeatures {
  return {
    palmSize: 0.1,
    curl: { thumb: 0.9, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 },
    tipDistances,
    wristPosition: { x: 0, y: 0, z: 0 },
    indexTipPosition: { x: 0, y: 0, z: 0 },
  }
}

let recognizer: GestureRecognizer

beforeEach(() => {
  recognizer = new GestureRecognizer()
})

test('left hand: all contracted = grab', () => {
  const state = makeState({ thumb: 'contracted', index: 'contracted', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  const result = recognizer.update(state, null, makeFeatures(), null, 0)
  expect(result.left).toBe('grab')
})

test('left hand: index extended only = point', () => {
  const state = makeState({ thumb: 'contracted', index: 'extended', middle: 'contracted', ring: 'contracted', pinky: 'contracted' })
  const result = recognizer.update(state, null, makeFeatures(), null, 0)
  expect(result.left).toBe('point')
})

test('left hand: index+middle extended + separated = peace_sep', () => {
  const state = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const features = makeFeatures({ thumbIndex: 0.8, indexMiddle: 0.5, middleRing: 0.3, ringPinky: 0.3 })
  const result = recognizer.update(state, null, features, null, 0)
  expect(result.left).toBe('peace_sep')
})

test('left hand: index+middle extended + together = peace_close', () => {
  const state = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const features = makeFeatures({ thumbIndex: 0.8, indexMiddle: 0.2, middleRing: 0.3, ringPinky: 0.3 })
  const result = recognizer.update(state, null, features, null, 0)
  expect(result.left).toBe('peace_close')
})

test('left hand: all extended = idle', () => {
  const state = makeState({})
  const result = recognizer.update(state, null, makeFeatures(), null, 0)
  expect(result.left).toBe('idle')
})

test('right hand: middle+ring+pinky contracted with thumbIndex contact = pinch', () => {
  const state = makeState({ middle: 'contracted', ring: 'contracted', pinky: 'contracted' }, { thumbIndex: true })
  const result = recognizer.update(null, state, null, makeFeatures(), 0)
  expect(result.right).toBe('pinch')
})

test('right hand: all extended = idle', () => {
  const state = makeState({})
  const result = recognizer.update(null, state, null, makeFeatures(), 0)
  expect(result.right).toBe('idle')
})

test('discrete release: peace_sep emits click after >150ms hold', () => {
  const peaceState = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const sepFeatures = makeFeatures({ thumbIndex: 0.8, indexMiddle: 0.5, middleRing: 0.3, ringPinky: 0.3 })
  // Hold for 200ms
  recognizer.update(peaceState, null, sepFeatures, null, 0)
  recognizer.update(peaceState, null, sepFeatures, null, 100)
  recognizer.update(peaceState, null, sepFeatures, null, 200)
  // Release (go to idle)
  const idleState = makeState({})
  const result = recognizer.update(idleState, null, makeFeatures(), null, 250)
  expect(result.left).toBe('idle')
  expect(recognizer.consumeDiscreteEvents().click).toBe(true)
})

test('discrete anti-bounce: pose <150ms does not emit', () => {
  const peaceState = makeState({ thumb: 'contracted', index: 'extended', middle: 'extended', ring: 'contracted', pinky: 'contracted' })
  const sepFeatures = makeFeatures({ thumbIndex: 0.8, indexMiddle: 0.5, middleRing: 0.3, ringPinky: 0.3 })
  // Hold for only 100ms
  recognizer.update(peaceState, null, sepFeatures, null, 0)
  recognizer.update(peaceState, null, sepFeatures, null, 100)
  // Release
  const idleState = makeState({})
  recognizer.update(idleState, null, makeFeatures(), null, 120)
  expect(recognizer.consumeDiscreteEvents().click).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/gestures/recognizer.test.ts`
Expected: FAIL — module `./recognizer` not found

- [ ] **Step 3: Implement GestureRecognizer**

```typescript
// frontend/src/gestures/recognizer.ts
import type { HandState, HandFeatures, GestureId, GestureResult } from './types'
import { PEACE_SEP_MIN_DISTANCE, PEACE_CLOSE_MAX_DISTANCE, DISCRETE_MIN_HOLD_MS } from './config'

interface DiscreteEvents {
  click: boolean
  back: boolean
}

function evaluateLeft(state: HandState, features: HandFeatures): GestureId {
  const { fingers } = state
  const { tipDistances } = features

  // Priority 1: peace_sep
  if (
    fingers.index === 'extended' &&
    fingers.middle === 'extended' &&
    fingers.ring === 'contracted' &&
    fingers.pinky === 'contracted' &&
    tipDistances.indexMiddle > PEACE_SEP_MIN_DISTANCE
  ) return 'peace_sep'

  // Priority 2: peace_close
  if (
    fingers.index === 'extended' &&
    fingers.middle === 'extended' &&
    fingers.ring === 'contracted' &&
    fingers.pinky === 'contracted' &&
    tipDistances.indexMiddle < PEACE_CLOSE_MAX_DISTANCE
  ) return 'peace_close'

  // Priority 3: point
  if (
    fingers.index === 'extended' &&
    fingers.middle === 'contracted' &&
    fingers.ring === 'contracted' &&
    fingers.pinky === 'contracted'
  ) return 'point'

  // Priority 4: grab
  if (
    fingers.thumb === 'contracted' &&
    fingers.index === 'contracted' &&
    fingers.middle === 'contracted' &&
    fingers.ring === 'contracted' &&
    fingers.pinky === 'contracted'
  ) return 'grab'

  // Fallback
  if (state.isIdle) return 'idle'
  return 'idle'
}

function evaluateRight(state: HandState): GestureId {
  const { fingers, contacts } = state

  // Priority 1: pinch
  if (
    fingers.middle === 'contracted' &&
    fingers.ring === 'contracted' &&
    fingers.pinky === 'contracted' &&
    contacts.thumbIndex
  ) return 'pinch'

  // Fallback
  if (state.isIdle) return 'idle'
  return 'idle'
}

export class GestureRecognizer {
  private peaceSepActive = false
  private peaceSepStartMs = 0
  private peaceCloseActive = false
  private peaceCloseStartMs = 0
  private pendingClick = false
  private pendingBack = false

  update(
    leftState: HandState | null,
    rightState: HandState | null,
    leftFeatures: HandFeatures | null,
    rightFeatures: HandFeatures | null,
    timestampMs: number,
  ): GestureResult {
    const left: GestureId = leftState && leftFeatures
      ? evaluateLeft(leftState, leftFeatures)
      : 'idle'
    const right: GestureId = rightState
      ? evaluateRight(rightState)
      : 'idle'

    // Discrete release tracking: peace_sep → click
    if (left === 'peace_sep') {
      if (!this.peaceSepActive) {
        this.peaceSepActive = true
        this.peaceSepStartMs = timestampMs
      }
    } else {
      if (this.peaceSepActive) {
        if (timestampMs - this.peaceSepStartMs >= DISCRETE_MIN_HOLD_MS) {
          this.pendingClick = true
        }
        this.peaceSepActive = false
      }
    }

    // Discrete release tracking: peace_close → back
    if (left === 'peace_close') {
      if (!this.peaceCloseActive) {
        this.peaceCloseActive = true
        this.peaceCloseStartMs = timestampMs
      }
    } else {
      if (this.peaceCloseActive) {
        if (timestampMs - this.peaceCloseStartMs >= DISCRETE_MIN_HOLD_MS) {
          this.pendingBack = true
        }
        this.peaceCloseActive = false
      }
    }

    return { left, right }
  }

  consumeDiscreteEvents(): DiscreteEvents {
    const events = { click: this.pendingClick, back: this.pendingBack }
    this.pendingClick = false
    this.pendingBack = false
    return events
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/gestures/recognizer.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/gestures/recognizer.ts frontend/src/gestures/recognizer.test.ts
git commit -m "feat(gestures): implement gesture recognizer layer with discrete release"
```

---

### Task 6: Output Layer

**Files:**
- Create: `frontend/src/gestures/output.ts`
- Create: `frontend/src/gestures/output.test.ts`

- [ ] **Step 1: Write failing tests for OutputProcessor**

```typescript
// frontend/src/gestures/output.test.ts
import { test, expect, beforeEach } from 'vitest'
import { OutputProcessor } from './output'
import type { GestureResult, HandFeatures, ModifierStatus } from './types'

function makeFeatures(overrides: Partial<HandFeatures> = {}): HandFeatures {
  return {
    palmSize: 0.1,
    curl: { thumb: 0.9, index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 },
    tipDistances: { thumbIndex: 0.1, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 },
    wristPosition: { x: 0, y: 0, z: 0 },
    indexTipPosition: { x: 0.5, y: 0.5, z: 0 },
    ...overrides,
  }
}

let processor: OutputProcessor

beforeEach(() => {
  processor = new OutputProcessor()
})

test('grab output tracks wrist delta from onset', () => {
  const gesture: GestureResult = { left: 'grab', right: 'idle' }
  const modifier: ModifierStatus = { type: 'none' }
  // First frame: onset
  processor.update(gesture, makeFeatures({ wristPosition: { x: 0.3, y: 0.4, z: 0 } }), null, modifier, false, false)
  // Second frame: moved
  const output = processor.update(gesture, makeFeatures({ wristPosition: { x: 0.35, y: 0.42, z: 0 } }), null, modifier, false, false)
  expect(output.grab.active).toBe(true)
  expect(output.grab.deltaX).toBeCloseTo(0.5, 1) // (0.35-0.3)/0.1
  expect(output.grab.deltaY).toBeCloseTo(0.2, 1) // (0.42-0.4)/0.1
})

test('grab resets delta on re-entry', () => {
  const modifier: ModifierStatus = { type: 'none' }
  // Activate grab
  processor.update({ left: 'grab', right: 'idle' }, makeFeatures({ wristPosition: { x: 0.3, y: 0.4, z: 0 } }), null, modifier, false, false)
  // Deactivate
  processor.update({ left: 'idle', right: 'idle' }, makeFeatures(), null, modifier, false, false)
  // Re-activate at new position
  const output = processor.update({ left: 'grab', right: 'idle' }, makeFeatures({ wristPosition: { x: 0.5, y: 0.5, z: 0 } }), null, modifier, false, false)
  expect(output.grab.deltaX).toBeCloseTo(0, 1) // fresh onset, no delta
})

test('point output maps index tip position', () => {
  const gesture: GestureResult = { left: 'point', right: 'idle' }
  const modifier: ModifierStatus = { type: 'none' }
  const output = processor.update(gesture, makeFeatures({ indexTipPosition: { x: 0.7, y: 0.3, z: 0 } }), null, modifier, false, false)
  expect(output.point.active).toBe(true)
  expect(output.point.screenX).toBeCloseTo(0.7, 2)
  expect(output.point.screenY).toBeCloseTo(0.3, 2)
})

test('pinch zoom uses smoothing toward target', () => {
  const gesture: GestureResult = { left: 'idle', right: 'pinch' }
  const modifier: ModifierStatus = { type: 'none' }
  const features = makeFeatures({ tipDistances: { thumbIndex: 0.04, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } })
  // Multiple frames to accumulate smoothing
  let output = processor.update(gesture, null, features, modifier, false, false)
  for (let i = 0; i < 30; i++) {
    output = processor.update(gesture, null, features, modifier, false, false)
  }
  // With thumbIndex at 0.04 (MIN_PINCH_DIST), target zoom is MAX_ZOOM=3.0
  expect(output.pinch.active).toBe(true)
  expect(output.pinch.zoom).toBeGreaterThan(2.5) // approaching 3.0 after many frames
})

test('pinch paused returns frozen value', () => {
  const gesture: GestureResult = { left: 'idle', right: 'pinch' }
  const modifier: ModifierStatus = { type: 'paused', frozenValue: 1.8 }
  const features = makeFeatures({ tipDistances: { thumbIndex: 0.04, indexMiddle: 0.6, middleRing: 0.5, ringPinky: 0.4 } })
  const output = processor.update(gesture, null, features, modifier, false, false)
  expect(output.pinch.paused).toBe(true)
  expect(output.pinch.zoom).toBe(1.8)
})

test('click and back pass through from discrete events', () => {
  const gesture: GestureResult = { left: 'idle', right: 'idle' }
  const modifier: ModifierStatus = { type: 'none' }
  const output = processor.update(gesture, makeFeatures(), null, modifier, true, false)
  expect(output.click).toBe(true)
  expect(output.back).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/gestures/output.test.ts`
Expected: FAIL — module `./output` not found

- [ ] **Step 3: Implement OutputProcessor**

```typescript
// frontend/src/gestures/output.ts
import type { GestureResult, HandFeatures, ModifierStatus, GestureOutput } from './types'
import { MIN_PINCH_DIST, MAX_PINCH_DIST, MIN_ZOOM, MAX_ZOOM, ZOOM_SMOOTH_FACTOR, GRAB_DEAD_ZONE } from './config'

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const clamped = Math.max(inMin, Math.min(inMax, value))
  return ((clamped - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin
}

export class OutputProcessor {
  private grabOnset: { x: number; y: number } | null = null
  private grabPalmSize = 1
  private zoomSmoothed = 1.0
  private wasGrabActive = false

  update(
    gesture: GestureResult,
    leftFeatures: HandFeatures | null,
    rightFeatures: HandFeatures | null,
    modifier: ModifierStatus,
    click: boolean,
    back: boolean,
  ): GestureOutput {
    // Grab
    const grabActive = gesture.left === 'grab'
    let deltaX = 0
    let deltaY = 0

    if (grabActive && leftFeatures) {
      if (!this.wasGrabActive) {
        this.grabOnset = { x: leftFeatures.wristPosition.x, y: leftFeatures.wristPosition.y }
        this.grabPalmSize = leftFeatures.palmSize > 1e-6 ? leftFeatures.palmSize : 1
      }
      if (this.grabOnset) {
        const rawDx = (leftFeatures.wristPosition.x - this.grabOnset.x) / this.grabPalmSize
        const rawDy = (leftFeatures.wristPosition.y - this.grabOnset.y) / this.grabPalmSize
        deltaX = Math.abs(rawDx) > GRAB_DEAD_ZONE ? rawDx : 0
        deltaY = Math.abs(rawDy) > GRAB_DEAD_ZONE ? rawDy : 0
      }
    } else {
      this.grabOnset = null
    }
    this.wasGrabActive = grabActive

    // Point
    const pointActive = gesture.left === 'point'
    const screenX = pointActive && leftFeatures ? leftFeatures.indexTipPosition.x : 0
    const screenY = pointActive && leftFeatures ? leftFeatures.indexTipPosition.y : 0

    // Pinch
    const pinchActive = gesture.right === 'pinch'
    let zoomValue = this.zoomSmoothed
    let paused = false

    if (pinchActive) {
      if (modifier.type === 'paused' || modifier.type === 'waiting_resume') {
        paused = true
        zoomValue = modifier.frozenValue
        this.zoomSmoothed = modifier.frozenValue
      } else if (rightFeatures) {
        const dist = rightFeatures.tipDistances.thumbIndex
        const zoomTarget = mapRange(dist, MIN_PINCH_DIST, MAX_PINCH_DIST, MAX_ZOOM, MIN_ZOOM)
        this.zoomSmoothed += (zoomTarget - this.zoomSmoothed) * ZOOM_SMOOTH_FACTOR
        zoomValue = this.zoomSmoothed
      }
    }

    return {
      grab: { active: grabActive, deltaX, deltaY },
      point: { active: pointActive, screenX, screenY },
      pinch: { active: pinchActive, zoom: zoomValue, paused },
      click,
      back,
    }
  }

  reset(): void {
    this.grabOnset = null
    this.zoomSmoothed = 1.0
    this.wasGrabActive = false
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/gestures/output.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/gestures/output.ts frontend/src/gestures/output.test.ts
git commit -m "feat(gestures): implement output layer with zoom smoothing"
```

---

### Task 7: Gesture Store

**Files:**
- Create: `frontend/src/state/gestureStore.ts`

- [ ] **Step 1: Implement gestureStore**

```typescript
// frontend/src/state/gestureStore.ts
import { create } from 'zustand'
import type { GestureOutput } from '../gestures/types'

const DEFAULT_OUTPUT: GestureOutput = {
  grab: { active: false, deltaX: 0, deltaY: 0 },
  point: { active: false, screenX: 0, screenY: 0 },
  pinch: { active: false, zoom: 1.0, paused: false },
  click: false,
  back: false,
}

interface GestureState {
  enabled: boolean
  output: GestureOutput
  setEnabled: (enabled: boolean) => void
  setOutput: (output: GestureOutput) => void
}

export const useGestureStore = create<GestureState>((set) => ({
  enabled: false,
  output: DEFAULT_OUTPUT,
  setEnabled: (enabled) => set({ enabled }),
  setOutput: (output) => set({ output }),
}))
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/state/gestureStore.ts
git commit -m "feat(gestures): add gesture output zustand store"
```

---

### Task 8: Pipeline Orchestrator

**Files:**
- Create: `frontend/src/gestures/pipeline.ts`

- [ ] **Step 1: Implement GesturePipeline class**

```typescript
// frontend/src/gestures/pipeline.ts
import type { Vec3, HandFeatures, HandState, GestureResult, ModifierStatus, GestureOutput, ActiveGesture } from './types'
import { extractFeatures } from './features'
import { HandStateTracker } from './state'
import { ModifierLayer } from './modifiers'
import { GestureRecognizer } from './recognizer'
import { OutputProcessor } from './output'

export class GesturePipeline {
  private leftTracker = new HandStateTracker()
  private rightTracker = new HandStateTracker()
  private modifierLayer = new ModifierLayer()
  private recognizer = new GestureRecognizer()
  private outputProcessor = new OutputProcessor()
  private lastGesture: GestureResult = { left: 'idle', right: 'idle' }

  process(
    leftLandmarks: Vec3[] | null,
    rightLandmarks: Vec3[] | null,
    timestampMs: number,
  ): GestureOutput {
    // Layer 1: Features
    const leftFeatures: HandFeatures | null = leftLandmarks
      ? extractFeatures(leftLandmarks)
      : null
    const rightFeatures: HandFeatures | null = rightLandmarks
      ? extractFeatures(rightLandmarks)
      : null

    // Layer 2: State
    const leftState: HandState | null = leftFeatures
      ? this.leftTracker.update(leftFeatures)
      : null
    const rightState: HandState | null = rightFeatures
      ? this.rightTracker.update(rightFeatures)
      : null

    // Layer 3: Modifiers
    const activeGesture: ActiveGesture | null = this.lastGesture.right === 'pinch'
      ? { id: 'pinch', hand: 'right', continuousValue: this.outputProcessor['zoomSmoothed'] }
      : null
    const currentThumbIndexDist = rightFeatures?.tipDistances.thumbIndex ?? 0
    const modifierStatus: ModifierStatus = rightState
      ? this.modifierLayer.update(rightState, activeGesture, currentThumbIndexDist, timestampMs)
      : { type: 'none' }

    // Layer 4: Gesture recognition
    const gesture: GestureResult = this.recognizer.update(
      leftState, rightState, leftFeatures, rightFeatures, timestampMs,
    )
    this.lastGesture = gesture

    // Consume discrete events
    const discreteEvents = this.recognizer.consumeDiscreteEvents()

    // Layer 5: Output
    return this.outputProcessor.update(
      gesture, leftFeatures, rightFeatures, modifierStatus,
      discreteEvents.click, discreteEvents.back,
    )
  }

  reset(): void {
    this.leftTracker = new HandStateTracker()
    this.rightTracker = new HandStateTracker()
    this.modifierLayer.reset()
    this.recognizer = new GestureRecognizer()
    this.outputProcessor.reset()
    this.lastGesture = { left: 'idle', right: 'idle' }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/gestures/pipeline.ts
git commit -m "feat(gestures): implement pipeline orchestrator"
```

---

### Task 9: MediaPipe Hook and Lifecycle

**Files:**
- Create: `frontend/src/hooks/useGesturePipeline.ts`

- [ ] **Step 1: Download the hand_landmarker model**

The model must be served statically. Download it into the public directory:

Run:
```bash
mkdir -p frontend/public/models
curl -L "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task" -o frontend/public/models/hand_landmarker.task
```

Verify the file exists and is >5MB:
```bash
ls -la frontend/public/models/hand_landmarker.task
```

- [ ] **Step 2: Implement useGesturePipeline hook**

```typescript
// frontend/src/hooks/useGesturePipeline.ts
import { useEffect, useRef } from 'react'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { GesturePipeline } from '../gestures/pipeline'
import { useGestureStore } from '../state/gestureStore'
import type { Vec3 } from '../gestures/types'

export function useGesturePipeline() {
  const enabled = useGestureStore(s => s.enabled)
  const setOutput = useGestureStore(s => s.setOutput)
  const pipelineRef = useRef<GesturePipeline | null>(null)
  const handLandmarkerRef = useRef<HandLandmarker | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)
  const lastFrameTimeRef = useRef<number>(0)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    async function init() {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      )

      if (cancelled) return

      const handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'models/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
      })

      if (cancelled) { handLandmarker.close(); return }

      handLandmarkerRef.current = handLandmarker
      pipelineRef.current = new GesturePipeline()

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      })

      if (cancelled) { stream.getTracks().forEach(t => t.stop()); handLandmarker.close(); return }

      streamRef.current = stream
      const video = document.createElement('video')
      video.srcObject = stream
      video.autoplay = true
      video.playsInline = true
      video.muted = true
      video.style.display = 'none'
      document.body.appendChild(video)
      videoRef.current = video

      await video.play()
      if (cancelled) return

      function loop() {
        if (cancelled) return
        rafRef.current = requestAnimationFrame(loop)

        const now = performance.now()
        if (now - lastFrameTimeRef.current < 33) return // cap ~30fps
        lastFrameTimeRef.current = now

        if (!handLandmarkerRef.current || !videoRef.current || !pipelineRef.current) return
        if (videoRef.current.readyState < 2) return

        const results = handLandmarkerRef.current.detectForVideo(videoRef.current, now)

        let leftLandmarks: Vec3[] | null = null
        let rightLandmarks: Vec3[] | null = null

        if (results.worldLandmarks && results.handedness) {
          for (let i = 0; i < results.handedness.length; i++) {
            const label = results.handedness[i][0]?.categoryName
            const landmarks = results.worldLandmarks[i] as Vec3[]
            // MediaPipe reports handedness from image perspective (mirrored for selfie)
            // "Left" in results = user's left hand in selfie mode
            if (label === 'Left') leftLandmarks = landmarks
            else if (label === 'Right') rightLandmarks = landmarks
          }
        }

        const output = pipelineRef.current.process(leftLandmarks, rightLandmarks, now)
        setOutput(output)
      }

      loop()
    }

    init()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      if (videoRef.current) {
        videoRef.current.remove()
        videoRef.current = null
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      if (handLandmarkerRef.current) {
        handLandmarkerRef.current.close()
        handLandmarkerRef.current = null
      }
      pipelineRef.current = null
    }
  }, [enabled, setOutput])
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useGesturePipeline.ts
git commit -m "feat(gestures): add MediaPipe hand landmarker hook with lifecycle"
```

---

### Task 10: Wire into AwakeApp

**Files:**
- Modify: `frontend/src/AwakeApp.tsx`

- [ ] **Step 1: Add gesture pipeline hook and toggle to AwakeApp**

Add these imports at the top of `AwakeApp.tsx`:

```typescript
import { useGesturePipeline } from './hooks/useGesturePipeline'
import { useGestureStore } from './state/gestureStore'
```

Inside the `AwakeApp` component, add after the existing store selectors:

```typescript
const gestureEnabled    = useGestureStore(s => s.enabled)
const setGestureEnabled = useGestureStore(s => s.setEnabled)
const gestureOutput     = useGestureStore(s => s.output)

useGesturePipeline()
```

Add gesture-driven navigation effects after the existing keyboard handler `useEffect`:

```typescript
// Gesture: click → enter zoomed mode (same as keyboard Enter)
useEffect(() => {
  if (gestureOutput.click && !zoomedMode) {
    setZoomedMode(activeRingMode)
  }
}, [gestureOutput.click])

// Gesture: back → handle back (same as keyboard Escape)
useEffect(() => {
  if (gestureOutput.back) {
    if (zoomedMode != null) handleBack()
    else if (ringLevel === 'house-sub') setRingLevel('main')
  }
}, [gestureOutput.back])

// Gesture: grab → rotate ring
useEffect(() => {
  if (!gestureOutput.grab.active || zoomedMode != null) return
  if (gestureOutput.grab.deltaX > 0.3) rotateRing(1)
  else if (gestureOutput.grab.deltaX < -0.3) rotateRing(-1)
}, [gestureOutput.grab.deltaX])
```

Add a gesture toggle button next to the existing voice toggle:

```tsx
<GlassPanel style={{ position: 'fixed', top: 16, right: 100, padding: '6px 14px', zIndex: 100 }}>
  <HudBtn active={gestureEnabled} onClick={() => setGestureEnabled(!gestureEnabled)}>
    Gestos
  </HudBtn>
</GlassPanel>
```

- [ ] **Step 2: Run build to verify no type errors**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/AwakeApp.tsx
git commit -m "feat(gestures): wire gesture pipeline into AwakeApp with toggle"
```

---

### Task 11: Download Model and Final Verification

- [ ] **Step 1: Download the MediaPipe model file if not already present**

Run:
```bash
mkdir -p frontend/public/models
curl -L "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task" -o frontend/public/models/hand_landmarker.task
```

- [ ] **Step 2: Add model to .gitignore (binary, ~10MB)**

Append to `frontend/.gitignore` (create if needed):

```
public/models/*.task
```

- [ ] **Step 3: Run all gesture tests**

Run: `cd frontend && npx vitest run src/gestures/`
Expected: All tests pass (features: 5, state: 5, modifiers: 6, recognizer: 9, output: 6 = 31 tests)

- [ ] **Step 4: Run full project tests**

Run: `cd frontend && npx vitest run`
Expected: All tests pass (existing + new = ~42 tests)

- [ ] **Step 5: Run TypeScript check**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit .gitignore**

```bash
git add frontend/.gitignore
git commit -m "chore: gitignore MediaPipe model binary"
```

- [ ] **Step 7: Run dev server and verify gesture toggle appears**

Run: `cd frontend && npm run dev`
Verify: Open browser, confirm "Gestos" button appears top-right. Clicking it should request camera permission. With camera active and hands visible, the pipeline should run (check console for errors).
