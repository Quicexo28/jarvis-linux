# Visor 3D + Rotación por Gesto Mejorada — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a voice-invokable 3D model viewer (parametric surfaces via mathjs + N-dimensional polytopes with 4D projection) and replace the discrete grab→ring rotation with continuous drag+snap using a shared clutch/EMA gesture hook.

**Architecture:** A shared `useGestureRotation` hook (clutch + EMA + dead zone + non-linear sensitivity) powers both the ring drag+snap refactor and the 3D viewer grab-rotate. The viewer is a zustand-driven overlay (same pattern as DisplayCard) with an R3F Canvas. The ring gains a float `ringAngle` and snaps to the nearest slot on puño release. Backend wires `show_3d`/`hide_3d` MCP tools through the skill bus.

**Tech Stack:** React 19, TypeScript, @react-three/fiber v9, three.js v0.183, mathjs (new), zustand, vitest (frontend + backend)

---

## File Map

**New files:**
- `frontend/src/lib/gestures/gestureRotationHelpers.ts` — pure: EMA, dead zone, non-linear (testable, no DOM)
- `frontend/src/lib/gestures/gestureRotationHelpers.test.ts` — unit tests for helpers
- `frontend/src/lib/gestures/useGestureRotation.ts` — React hook: clutch + smoothing → GestureRotationFrame ref
- `frontend/src/lib/geometry/parametricMath.ts` — pure: mathjs evaluate (u,v)→xyz surface → Float32Arrays (testable)
- `frontend/src/lib/geometry/parametricMath.test.ts` — unit tests
- `frontend/src/lib/geometry/polytopeMath.ts` — pure: N-D vertex/edge gen, plane rotation, N→3D projection (testable)
- `frontend/src/lib/geometry/polytopeMath.test.ts` — unit tests
- `frontend/src/state/model3dStore.ts` — zustand: open/spec/show/hide
- `frontend/src/components/Model3DViewer.tsx` — R3F Canvas overlay

**Modified files:**
- `frontend/package.json` — add mathjs
- `frontend/src/state/jarvisStore.ts` — add `ringAngle: number` + `setRingAngle`
- `frontend/src/gestures/config.ts` — add `RING_DRAG_SENSITIVITY`
- `frontend/src/AwakeApp.tsx` — replace grab handler, add Model3DViewer mount
- `frontend/src/skills/primitives.ts` — add `model3d_show`, `model3d_hide` verbs
- `backend/mcp-server/jarvis-mcp.js` — add `show_3d`, `hide_3d` MCP tools
- `backend/src/handlers/skillTools.js` — add `handleModel3dShow`, `handleModel3dHide`
- `backend/src/routes.js` — add model3d routes
- `backend/src/handlers/speech.js` — add `MODEL3D_PROMPT_SECTION`
- `backend/tests/model3d.contract.test.js` — backend smoke tests

---

## Task 1: Install mathjs

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Install mathjs**

```bash
cd frontend && npm install mathjs
```

Expected output includes: `added N packages` and `mathjs` in `node_modules/`.

- [ ] **Step 2: Verify import resolves**

```bash
cd frontend && node -e "import('mathjs').then(m => console.log('mathjs version:', m.version)).catch(console.error)"
```

Expected: prints `mathjs version: X.Y.Z`

- [ ] **Step 3: Commit**

```bash
cd frontend && git add package.json package-lock.json && cd .. && git commit -m "chore(frontend): add mathjs for parametric surface evaluation"
```

---

## Task 2: Pure gesture rotation helpers

**Files:**
- Create: `frontend/src/lib/gestures/gestureRotationHelpers.ts`
- Create: `frontend/src/lib/gestures/gestureRotationHelpers.test.ts`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/lib/gestures/gestureRotationHelpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { applyEMA, applyDeadZone, applyNonLinear } from './gestureRotationHelpers'

describe('applyEMA', () => {
  it('moves toward target by alpha fraction', () => {
    expect(applyEMA(0, 1, 0.5)).toBeCloseTo(0.5)
    expect(applyEMA(0.5, 1, 0.5)).toBeCloseTo(0.75)
  })
  it('reaches target instantly when alpha=1', () => {
    expect(applyEMA(0, 1, 1)).toBe(1)
  })
  it('stays put when alpha=0', () => {
    expect(applyEMA(0.5, 1, 0)).toBe(0.5)
  })
})

describe('applyDeadZone', () => {
  it('returns 0 for values below threshold', () => {
    expect(applyDeadZone(0.01, 0.02)).toBe(0)
    expect(applyDeadZone(-0.01, 0.02)).toBe(0)
  })
  it('returns value unchanged when above threshold', () => {
    expect(applyDeadZone(0.05, 0.02)).toBe(0.05)
    expect(applyDeadZone(-0.05, 0.02)).toBe(-0.05)
  })
  it('returns 0 exactly at threshold', () => {
    expect(applyDeadZone(0.02, 0.02)).toBe(0)
  })
})

describe('applyNonLinear', () => {
  it('preserves sign of negative input', () => {
    expect(applyNonLinear(-0.5, 1.5)).toBeLessThan(0)
  })
  it('returns 0 for 0 input', () => {
    expect(applyNonLinear(0, 1.5)).toBe(0)
  })
  it('compresses small values relative to large (exponent > 1)', () => {
    const small = Math.abs(applyNonLinear(0.1, 2))
    const large = Math.abs(applyNonLinear(0.9, 2))
    // Small should be proportionally smaller (0.1^2/0.9^2 ≈ 0.012)
    expect(small / large).toBeLessThan(0.1 / 0.9)
  })
  it('is linear when exponent=1', () => {
    expect(applyNonLinear(0.5, 1)).toBeCloseTo(0.5)
    expect(applyNonLinear(-0.3, 1)).toBeCloseTo(-0.3)
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd frontend && npm test -- gestureRotationHelpers
```

Expected: FAIL with "cannot find module" or "not exported"

- [ ] **Step 3: Implement helpers**

Create `frontend/src/lib/gestures/gestureRotationHelpers.ts`:

```typescript
/**
 * Pure helper functions for gesture rotation smoothing.
 * No React, no DOM — fully testable in Node.
 */

/**
 * Exponential Moving Average: moves prev toward current by alpha each step.
 * alpha=0 → no movement; alpha=1 → instant.
 */
export function applyEMA(prev: number, current: number, alpha: number): number {
  return prev + alpha * (current - prev)
}

/**
 * Dead zone: returns 0 if abs(value) < threshold, otherwise returns value.
 * Prevents micro-jitter from triggering rotation.
 */
export function applyDeadZone(value: number, threshold: number): number {
  return Math.abs(value) < threshold ? 0 : value
}

/**
 * Non-linear sensitivity: sign(v) * |v|^exponent.
 * exponent > 1: slow near center, faster at extremes (precision + reach).
 * exponent = 1: linear (identity).
 */
export function applyNonLinear(value: number, exponent: number): number {
  if (value === 0) return 0
  return Math.sign(value) * Math.pow(Math.abs(value), exponent)
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
cd frontend && npm test -- gestureRotationHelpers
```

Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
cd frontend && cd .. && git add frontend/src/lib/gestures/ && git commit -m "feat(gestures): pure helper functions for gesture rotation (EMA, dead zone, non-linear)"
```

---

## Task 3: useGestureRotation hook

**Files:**
- Create: `frontend/src/lib/gestures/useGestureRotation.ts`

Note: This hook is tested via integration (Tasks 4-5). Pure unit tests would require mocking the gestureStore and React effects — covered implicitly by the ring behavior in Task 5.

- [ ] **Step 1: Create the hook**

Create `frontend/src/lib/gestures/useGestureRotation.ts`:

```typescript
import { useRef, useEffect } from 'react'
import { useGestureStore } from '../../state/gestureStore'
import { applyEMA, applyDeadZone, applyNonLinear } from './gestureRotationHelpers'

export interface GestureRotationFrame {
  /** Smoothed yaw delta this cycle. Add to rotation.y. */
  deltaYaw: number
  /** Smoothed pitch delta this cycle. Add to rotation.x. */
  deltaPitch: number
  /** Whether grab clutch is currently engaged. */
  grabActive: boolean
  /**
   * True in the single effect cycle when grab transitions active→inactive.
   * Use in a useEffect on [gestureOutput.grab.active] to detect release.
   */
  justReleased: boolean
}

export interface UseGestureRotationOptions {
  /** Base sensitivity multiplier. Default 2.0. */
  sensitivity?: number
  /** EMA smoothing alpha (0=no smooth, 1=instant). Default 0.25. */
  emaAlpha?: number
  /** Dead zone threshold below which delta is ignored. Default 0.018. */
  deadZone?: number
  /** Non-linear exponent (>1 = slow near center, fast far). Default 1.5. */
  nonLinearExp?: number
  /** Whether to process gestures at all. Default true. */
  enabled?: boolean
}

/**
 * Returns a stable mutable ref updated on each gesture change.
 * Read deltaYaw/deltaPitch inside useFrame (R3F) or useEffect (ring).
 *
 * Clutch model: puño cerrado (grab.active) = engaged; abrir = released.
 * On engage: captures base position so deltaX/Y are relative to engagement point.
 * On release: sets justReleased=true for one cycle, then false.
 */
export function useGestureRotation(
  opts: UseGestureRotationOptions = {}
): React.MutableRefObject<GestureRotationFrame> {
  const {
    sensitivity = 2.0,
    emaAlpha = 0.25,
    deadZone = 0.018,
    nonLinearExp = 1.5,
    enabled = true,
  } = opts

  const output = useGestureStore(s => s.output)

  const frameRef = useRef<GestureRotationFrame>({
    deltaYaw: 0, deltaPitch: 0, grabActive: false, justReleased: false,
  })
  const prevGrabRef = useRef(false)
  const baseRef = useRef({ x: 0, y: 0 })
  const smoothedRef = useRef({ x: 0, y: 0 })
  const prevSmoothedRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    if (!enabled) {
      frameRef.current = { deltaYaw: 0, deltaPitch: 0, grabActive: false, justReleased: false }
      return
    }

    const { grab } = output
    const wasGrabbing = prevGrabRef.current
    const isGrabbing = grab.active

    // Clutch engage: capture base position, reset smoothing state
    if (isGrabbing && !wasGrabbing) {
      baseRef.current = { x: grab.deltaX, y: grab.deltaY }
      smoothedRef.current = { x: 0, y: 0 }
      prevSmoothedRef.current = { x: 0, y: 0 }
    }

    const justReleased = wasGrabbing && !isGrabbing
    prevGrabRef.current = isGrabbing

    if (!isGrabbing) {
      frameRef.current = { deltaYaw: 0, deltaPitch: 0, grabActive: false, justReleased }
      return
    }

    // Delta from clutch base
    const rawX = grab.deltaX - baseRef.current.x
    const rawY = grab.deltaY - baseRef.current.y

    // EMA smoothing (reduces jitter from MediaPipe tracking noise)
    const newSX = applyEMA(smoothedRef.current.x, rawX, emaAlpha)
    const newSY = applyEMA(smoothedRef.current.y, rawY, emaAlpha)

    // Delta since last cycle (additive rotation signal)
    const dX = newSX - prevSmoothedRef.current.x
    const dY = newSY - prevSmoothedRef.current.y

    smoothedRef.current = { x: newSX, y: newSY }
    prevSmoothedRef.current = { x: newSX, y: newSY }

    // Dead zone + non-linear + sensitivity
    const finalX = applyNonLinear(applyDeadZone(dX, deadZone), nonLinearExp) * sensitivity
    const finalY = applyNonLinear(applyDeadZone(dY, deadZone), nonLinearExp) * sensitivity

    frameRef.current = { deltaYaw: finalX, deltaPitch: finalY, grabActive: true, justReleased: false }
  }, [output.grab.active, output.grab.deltaX, output.grab.deltaY, enabled, sensitivity, emaAlpha, deadZone, nonLinearExp])

  return frameRef
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd .. && git add frontend/src/lib/gestures/useGestureRotation.ts && git commit -m "feat(gestures): useGestureRotation hook — clutch + EMA + dead zone + non-linear"
```

---

## Task 4: Add `ringAngle` to jarvisStore + config constant

**Files:**
- Modify: `frontend/src/state/jarvisStore.ts`
- Modify: `frontend/src/gestures/config.ts`

- [ ] **Step 1: Add `RING_DRAG_SENSITIVITY` to gestures/config.ts**

Open `frontend/src/gestures/config.ts`. After the `GRAB_STEP_COOLDOWN_MS` line, add:

```typescript
// Layer 7 — Grab → drag continuo del ring (reemplaza el modelo paso-a-paso).
// El ring sigue la mano 1:1 mientras el puño está cerrado; snap al slot más
// cercano al soltar. Ajustar si el arrastre se siente demasiado lento/rápido.
export const RING_DRAG_SENSITIVITY = 4.0
```

- [ ] **Step 2: Write failing test for ring angle snap math**

Create `frontend/src/state/ringSnap.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { snapToNearestSlot } from '../state/ringSnap'

describe('snapToNearestSlot', () => {
  it('snaps 0.3 to slot 0', () => {
    expect(snapToNearestSlot(0.3, 5)).toBe(0)
  })
  it('snaps 0.7 to slot 1', () => {
    expect(snapToNearestSlot(0.7, 5)).toBe(1)
  })
  it('snaps -0.3 to slot 0 (wraps from end)', () => {
    expect(snapToNearestSlot(-0.3, 5)).toBe(0)
  })
  it('snaps 4.6 to slot 0 (wraps)', () => {
    expect(snapToNearestSlot(4.6, 5)).toBe(0)
  })
  it('snaps 2.4 to slot 2', () => {
    expect(snapToNearestSlot(2.4, 5)).toBe(2)
  })
})
```

- [ ] **Step 3: Run test — confirm it fails**

```bash
cd frontend && npm test -- ringSnap
```

Expected: FAIL "cannot find module '../state/ringSnap'"

- [ ] **Step 4: Create ringSnap.ts helper**

Create `frontend/src/state/ringSnap.ts`:

```typescript
/**
 * Snap a continuous ring angle (in slot units) to the nearest integer slot,
 * wrapping modulo numSlots.
 */
export function snapToNearestSlot(ringAngle: number, numSlots: number): number {
  const rounded = Math.round(ringAngle)
  return ((rounded % numSlots) + numSlots) % numSlots
}
```

- [ ] **Step 5: Run test — confirm it passes**

```bash
cd frontend && npm test -- ringSnap
```

Expected: all 5 tests PASS

- [ ] **Step 6: Add ringAngle to jarvisStore**

Open `frontend/src/state/jarvisStore.ts`. Find the interface block and the initial state. Add `ringAngle` and `setRingAngle`:

In the interface (after `activeRingMode: Mode`):
```typescript
  /** Continuous ring angle in slot units. Integer = at a slot. Updated while dragging. */
  ringAngle: number
  setRingAngle: (angle: number) => void
```

In the initial state (after `activeRingMode: 'home'`):
```typescript
  ringAngle: 0,
```

In the actions block (after or near `setActiveRingMode`):
```typescript
  setRingAngle: (ringAngle) => set({ ringAngle }),
```

Also update `rotateRing` to keep `ringAngle` in sync with discrete steps:
```typescript
  rotateRing: (direction) => {
    const { ringLevel, activeRingMode, ringAngle } = get()
    const list =
      ringLevel === 'house-sub' ? SUB_RING
      : ringLevel === 'utils-sub' ? SUB_RING_UTILS
      : MAIN_RING
    const idx = list.indexOf(activeRingMode)
    const next = ((idx === -1 ? 0 : idx) + direction + list.length) % list.length
    set({ activeRingMode: list[next], ringAngle: next })
  },
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
cd .. && git add frontend/src/state/ frontend/src/gestures/config.ts && git commit -m "feat(ring): add ringAngle float to jarvisStore + snapToNearestSlot helper"
```

---

## Task 5: Replace grab→ring handler with drag+snap

**Files:**
- Modify: `frontend/src/AwakeApp.tsx`

The current grab handler (lines ~171-185 in AwakeApp.tsx) uses the old step+rearm model.
Replace it with `useGestureRotation` + continuous drag + snap on release.

- [ ] **Step 1: Add imports to AwakeApp.tsx**

Near the top of AwakeApp.tsx, add the new imports alongside existing ones:

```typescript
import { useGestureRotation } from './lib/gestures/useGestureRotation'
import { snapToNearestSlot } from './state/ringSnap'
import { RING_DRAG_SENSITIVITY } from './gestures/config'
```

- [ ] **Step 2: Add ringRotRef hook call inside AwakeApp component**

Inside the `AwakeApp` function, after the existing `gestureOutput` selector, add:

```typescript
const ringRotRef = useGestureRotation({
  sensitivity: RING_DRAG_SENSITIVITY,
  emaAlpha: 0.20,
  deadZone: 0.015,
  nonLinearExp: 1.4,
})
```

Also add selectors for the new store fields (alongside existing ones):

```typescript
const ringAngle    = useJarvisStore(s => s.ringAngle)
const setRingAngle = useJarvisStore(s => s.setRingAngle)
```

- [ ] **Step 3: Remove old grab→ring handler, add new drag+snap handler**

Find and delete the old grab useEffect block (the one with `grabArmedRef`, `grabCooldownRef`, `GRAB_STEP_TRIGGER`, etc.). Also delete the `grabArmedRef` and `grabCooldownRef` `useRef` declarations.

Replace with this new handler:

```typescript
// Gesture: grab → drag ring continuously; snap to nearest slot on release.
// Uses useGestureRotation (clutch + EMA + dead zone) for smooth, precise control.
const MAIN_RING_SLOTS = 5  // MAIN_RING has 5 modes: home, house, system, cloud, utils

useEffect(() => {
  if (gestureOutput.pinch.active || zoomedMode != null) return

  const { deltaYaw, grabActive, justReleased } = ringRotRef.current

  if (grabActive) {
    // Drag: update continuous ringAngle. Only affect main ring while at main level.
    if (ringLevel === 'main') {
      setRingAngle(ringAngle + deltaYaw)
    }
    return
  }

  if (justReleased && ringLevel === 'main') {
    // Snap to nearest slot and update activeRingMode
    const MAIN_RING: Mode[] = ['home', 'house', 'system', 'cloud', 'utils']
    const slot = snapToNearestSlot(ringAngle, MAIN_RING_SLOTS)
    setRingAngle(slot)
    setActiveRingMode(MAIN_RING[slot])
  }
}, [gestureOutput.grab.active, gestureOutput.grab.deltaX, gestureOutput.grab.deltaY,
    gestureOutput.pinch.active, zoomedMode, ringAngle, ringLevel,
    setRingAngle, setActiveRingMode, rotateRing])
```

Note: import `Mode` from `./types` if not already imported in the file.

- [ ] **Step 4: Remove unused imports from AwakeApp.tsx**

Remove `GRAB_STEP_TRIGGER`, `GRAB_STEP_REARM`, `GRAB_STEP_COOLDOWN_MS` from the import of `'./gestures/config'` if they're no longer used.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 6: Run frontend tests**

```bash
cd frontend && npm test
```

Expected: all existing tests pass (no regressions)

- [ ] **Step 7: Commit**

```bash
cd .. && git add frontend/src/AwakeApp.tsx frontend/src/gestures/config.ts && git commit -m "feat(ring): drag-continuo+snap gesto de rotación — reemplaza modelo paso-a-paso"
```

---

## Task 6: Parametric surface math engine

**Files:**
- Create: `frontend/src/lib/geometry/parametricMath.ts`
- Create: `frontend/src/lib/geometry/parametricMath.test.ts`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/lib/geometry/parametricMath.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { evaluateParametricSurface, type ParametricSpec } from './parametricMath'

const TORUS: ParametricSpec = {
  x: 'cos(u) * (2 + cos(v))',
  y: 'sin(u) * (2 + cos(v))',
  z: 'sin(v)',
  uRange: [0, 2 * Math.PI],
  vRange: [0, 2 * Math.PI],
  segments: 8,
}

describe('evaluateParametricSurface', () => {
  it('produces correct vertex count', () => {
    const result = evaluateParametricSurface(TORUS)
    const N = 8 + 1  // segments + 1 = 9 grid points per axis
    expect(result.positions.length).toBe(N * N * 3)
  })

  it('produces correct triangle index count', () => {
    const result = evaluateParametricSurface(TORUS)
    // segments * segments * 2 triangles * 3 indices
    expect(result.indices.length).toBe(8 * 8 * 6)
  })

  it('torus center ring (v=0) has z≈0', () => {
    const result = evaluateParametricSurface({
      ...TORUS,
      vRange: [0, 0],   // v=0 → z=sin(0)=0
      segments: 4,
    })
    for (let i = 2; i < result.positions.length; i += 3) {
      expect(Math.abs(result.positions[i])).toBeLessThan(1e-10)
    }
  })

  it('handles NaN/Infinity gracefully (replaces with 0)', () => {
    const result = evaluateParametricSurface({
      x: '1/u',   // 1/0 = Infinity at u=0
      y: '0',
      z: '0',
      uRange: [0, 1],
      vRange: [0, 1],
      segments: 2,
    })
    for (const v of result.positions) {
      expect(isFinite(v)).toBe(true)
    }
  })

  it('flat plane (x=u, y=v, z=0) has correct xy and z=0', () => {
    const result = evaluateParametricSurface({
      x: 'u', y: 'v', z: '0',
      uRange: [0, 1], vRange: [0, 1],
      segments: 2,
    })
    // First vertex: u=0,v=0 → (0,0,0)
    expect(result.positions[0]).toBeCloseTo(0)  // x
    expect(result.positions[1]).toBeCloseTo(0)  // y
    expect(result.positions[2]).toBeCloseTo(0)  // z
    // All z values = 0
    for (let i = 2; i < result.positions.length; i += 3) {
      expect(Math.abs(result.positions[i])).toBeLessThan(1e-10)
    }
  })

  it('defaults to 64 segments when not specified', () => {
    const result = evaluateParametricSurface({ ...TORUS, segments: undefined })
    const N = 65
    expect(result.positions.length).toBe(N * N * 3)
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd frontend && npm test -- parametricMath
```

Expected: FAIL "cannot find module"

- [ ] **Step 3: Implement parametricMath.ts**

Create `frontend/src/lib/geometry/parametricMath.ts`:

```typescript
import { create, all } from 'mathjs'

const math = create(all)

export interface ParametricSpec {
  /** mathjs expression for x(u, v) */
  x: string
  /** mathjs expression for y(u, v) */
  y: string
  /** mathjs expression for z(u, v) */
  z: string
  uRange: [number, number]
  vRange: [number, number]
  /** Grid resolution per axis. Capped at 120 for performance. Default 64. */
  segments?: number
  title?: string
  color?: string
}

export interface EvaluatedSurface {
  /** Flat Float32Array: [x0,y0,z0, x1,y1,z1, ...] in u-major order (u outer, v inner) */
  positions: Float32Array
  /** Triangle indices for indexed geometry */
  indices: Uint32Array
  /** Actual segments used */
  segments: number
}

/**
 * Evaluate a parametric surface using mathjs expressions.
 * NaN and Infinity values are replaced with 0 (malformed formulas degrade gracefully).
 */
export function evaluateParametricSurface(spec: ParametricSpec): EvaluatedSurface {
  const seg = Math.min(120, spec.segments ?? 64)
  const [uMin, uMax] = spec.uRange
  const [vMin, vMax] = spec.vRange
  const N = seg + 1

  // Compile expressions once for performance (parse tree reused across all (u,v) evaluations)
  const exprX = math.compile(spec.x)
  const exprY = math.compile(spec.y)
  const exprZ = math.compile(spec.z)

  const positions = new Float32Array(N * N * 3)

  for (let i = 0; i <= seg; i++) {
    const u = uMin + (i / seg) * (uMax - uMin)
    for (let j = 0; j <= seg; j++) {
      const v = vMin + (j / seg) * (vMax - vMin)
      const scope = { u, v }
      let px = exprX.evaluate(scope) as number
      let py = exprY.evaluate(scope) as number
      let pz = exprZ.evaluate(scope) as number
      if (!isFinite(px)) px = 0
      if (!isFinite(py)) py = 0
      if (!isFinite(pz)) pz = 0
      const base = (i * N + j) * 3
      positions[base]     = px
      positions[base + 1] = py
      positions[base + 2] = pz
    }
  }

  // Two triangles per quad: (a,b,d) and (a,d,c)
  const indices = new Uint32Array(seg * seg * 6)
  let idx = 0
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * N + j
      const b = a + 1
      const c = (i + 1) * N + j
      const d = c + 1
      indices[idx++] = a; indices[idx++] = b; indices[idx++] = d
      indices[idx++] = a; indices[idx++] = d; indices[idx++] = c
    }
  }

  return { positions, indices, segments: seg }
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
cd frontend && npm test -- parametricMath
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend/src/lib/geometry/ && git commit -m "feat(3d): parametric surface math engine with mathjs — evaluates (u,v)→xyz"
```

---

## Task 7: N-dimensional polytope math engine

**Files:**
- Create: `frontend/src/lib/geometry/polytopeMath.ts`
- Create: `frontend/src/lib/geometry/polytopeMath.test.ts`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/lib/geometry/polytopeMath.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildHypercube, buildCross, rotateInPlane, projectToR3 } from './polytopeMath'

describe('buildHypercube', () => {
  it('2D square: 4 vertices, 4 edges', () => {
    const h = buildHypercube(2)
    expect(h.vertices.length).toBe(4)
    expect(h.edges.length).toBe(4)
  })
  it('3D cube: 8 vertices, 12 edges', () => {
    const h = buildHypercube(3)
    expect(h.vertices.length).toBe(8)
    expect(h.edges.length).toBe(12)
  })
  it('4D tesseract: 16 vertices, 32 edges', () => {
    const h = buildHypercube(4)
    expect(h.vertices.length).toBe(16)
    // N * 2^(N-1) = 4 * 8 = 32
    expect(h.edges.length).toBe(32)
  })
  it('all vertices have N coords all ±1', () => {
    const h = buildHypercube(4)
    for (const v of h.vertices) {
      expect(v.length).toBe(4)
      for (const c of v) expect(Math.abs(c)).toBeCloseTo(1)
    }
  })
  it('throws for dimension > 7', () => {
    expect(() => buildHypercube(8)).toThrow()
  })
})

describe('buildCross', () => {
  it('3D cross: 6 vertices, 12 edges', () => {
    const c = buildCross(3)
    expect(c.vertices.length).toBe(6)
    expect(c.edges.length).toBe(12)
  })
  it('no antipodal edges', () => {
    const c = buildCross(3)
    // Antipodal pairs: (0,1), (2,3), (4,5) — none should be edges
    const edgeSet = new Set(c.edges.map(([a, b]) => `${a}-${b}`))
    expect(edgeSet.has('0-1')).toBe(false)
    expect(edgeSet.has('2-3')).toBe(false)
  })
})

describe('rotateInPlane', () => {
  it('90° rotation in XY plane maps [1,0,0,0] to [0,1,0,0]', () => {
    const v = [[1, 0, 0, 0]]
    const r = rotateInPlane(v, 0, 1, Math.PI / 2)
    expect(r[0][0]).toBeCloseTo(0)
    expect(r[0][1]).toBeCloseTo(1)
    expect(r[0][2]).toBeCloseTo(0)
    expect(r[0][3]).toBeCloseTo(0)
  })
  it('does not mutate input vertices', () => {
    const v = [[1, 0, 0, 0]]
    const original = v[0].slice()
    rotateInPlane(v, 0, 1, 0.5)
    expect(v[0]).toEqual(original)
  })
  it('360° rotation returns to original', () => {
    const v = [[1, 2, 3, 4]]
    const r = rotateInPlane(v, 0, 3, 2 * Math.PI)
    expect(r[0][0]).toBeCloseTo(v[0][0])
    expect(r[0][3]).toBeCloseTo(v[0][3])
  })
})

describe('projectToR3', () => {
  it('3D vertices pass through unchanged', () => {
    const pts = [[1, 2, 3], [4, 5, 6]]
    const result = projectToR3(pts)
    expect(result[0]).toEqual([1, 2, 3])
    expect(result[1]).toEqual([4, 5, 6])
  })
  it('4D vertices project to 3D with finite values', () => {
    const { vertices } = buildHypercube(4)
    const projected = projectToR3(vertices)
    expect(projected.length).toBe(16)
    for (const p of projected) {
      expect(p.length).toBe(3)
      for (const c of p) expect(isFinite(c)).toBe(true)
    }
  })
  it('5D vertices project to 3D', () => {
    const { vertices } = buildHypercube(5)
    const projected = projectToR3(vertices)
    expect(projected.length).toBe(32)
    for (const p of projected) expect(p.length).toBe(3)
  })
})
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd frontend && npm test -- polytopeMath
```

Expected: FAIL "cannot find module"

- [ ] **Step 3: Implement polytopeMath.ts**

Create `frontend/src/lib/geometry/polytopeMath.ts`:

```typescript
/**
 * N-dimensional polytope generation and projection.
 * Pure math — no Three.js, no DOM. Testable in Node.
 */

export interface PolytopeGeometry {
  /** N-dimensional vertex coordinates */
  vertices: number[][]
  /** Pairs of vertex indices forming edges */
  edges: [number, number][]
  dimension: number
}

/**
 * N-dimensional hypercube (all ±1 combinations).
 * Has 2^N vertices and N * 2^(N-1) edges.
 * Cap: dimension ≤ 7 (128 vertices) for performance.
 */
export function buildHypercube(n: number): PolytopeGeometry {
  if (n < 2 || n > 7) throw new Error(`Hypercube dimension must be 2–7, got ${n}`)
  const count = 1 << n  // 2^n
  const vertices: number[][] = []
  for (let i = 0; i < count; i++) {
    const v: number[] = []
    for (let d = 0; d < n; d++) {
      v.push((i >> d) & 1 ? 1 : -1)
    }
    vertices.push(v)
  }
  const edges: [number, number][] = []
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const diff = i ^ j
      if (diff !== 0 && (diff & (diff - 1)) === 0) {  // exactly 1 bit differs
        edges.push([i, j])
      }
    }
  }
  return { vertices, edges, dimension: n }
}

/**
 * N-dimensional cross polytope (orthoplex): 2N vertices (±e_i for each axis).
 * Connected to all except its antipodal partner.
 */
export function buildCross(n: number): PolytopeGeometry {
  if (n < 2 || n > 7) throw new Error(`Cross polytope dimension must be 2–7, got ${n}`)
  const vertices: number[][] = []
  for (let d = 0; d < n; d++) {
    const pos = new Array(n).fill(0); pos[d] = 1; vertices.push(pos)
    const neg = new Array(n).fill(0); neg[d] = -1; vertices.push(neg)
  }
  const edges: [number, number][] = []
  for (let i = 0; i < 2 * n; i++) {
    for (let j = i + 1; j < 2 * n; j++) {
      if ((i ^ j) !== 1) {  // not antipodal (antipodal pairs differ in only the last bit)
        edges.push([i, j])
      }
    }
  }
  return { vertices, edges, dimension: n }
}

/**
 * Rotate vertices in the plane spanned by axes a and b by angle theta.
 * Returns new vertices — does NOT mutate input.
 */
export function rotateInPlane(vertices: number[][], a: number, b: number, theta: number): number[][] {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  return vertices.map(v => {
    const r = [...v]
    r[a] = v[a] * c - v[b] * s
    r[b] = v[a] * s + v[b] * c
    return r
  })
}

/**
 * Project N-dimensional vertices to 3D via successive perspective projections.
 * Each step reduces dimensionality by 1: factor = dist / (dist - w_last); scale others.
 * Returns [x, y, z] per vertex.
 */
export function projectToR3(vertices: number[][], dist = 4): [number, number, number][] {
  let pts = vertices.map(v => [...v])
  for (let dim = pts[0].length; dim > 3; dim--) {
    pts = pts.map(v => {
      const w = v[dim - 1]
      const factor = dist / Math.max(0.001, dist - w * 0.8)
      return v.slice(0, dim - 1).map(c => c * factor)
    })
  }
  return pts.map(v => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0])
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
cd frontend && npm test -- polytopeMath
```

Expected: all 10 tests PASS

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend/src/lib/geometry/polytopeMath.ts frontend/src/lib/geometry/polytopeMath.test.ts && git commit -m "feat(3d): N-dimensional polytope engine — hypercube/cross, 4D rotation, N→3D projection"
```

---

## Task 8: model3dStore

**Files:**
- Create: `frontend/src/state/model3dStore.ts`

- [ ] **Step 1: Create the store**

Create `frontend/src/state/model3dStore.ts`:

```typescript
import { create } from 'zustand'

export interface ParametricSpec {
  kind: 'parametric'
  x: string
  y: string
  z: string
  uRange: [number, number]
  vRange: [number, number]
  segments?: number
  title?: string
  color?: string
}

export interface PolytopeSpec {
  kind: 'polytope'
  type: 'hypercube' | 'cross'
  dimension: number
  title?: string
}

export type Model3DSpec = ParametricSpec | PolytopeSpec

interface Model3DState {
  open: boolean
  spec: Model3DSpec | null
  show: (spec: Model3DSpec) => void
  hide: () => void
}

export const useModel3dStore = create<Model3DState>((set) => ({
  open: false,
  spec: null,
  show: (spec) => set({ open: true, spec }),
  hide: () => set({ open: false }),
}))
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd .. && git add frontend/src/state/model3dStore.ts && git commit -m "feat(3d): model3dStore — zustand store for 3D viewer overlay"
```

---

## Task 9: Model3DViewer R3F component

**Files:**
- Create: `frontend/src/components/Model3DViewer.tsx`

- [ ] **Step 1: Create Model3DViewer.tsx**

Create `frontend/src/components/Model3DViewer.tsx`:

```tsx
/**
 * Model3DViewer — full-screen overlay that renders a 3D model.
 * Driven by model3dStore (same pattern as DisplayCard).
 * Gestures: pinch = zoom (dolly), grab = rotate (trackball via useGestureRotation).
 * Polytopes ≥ 4D auto-rotate in 4D planes XW/YW simultaneously with manual grab.
 */

import { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useGestureStore } from '../state/gestureStore'
import { useModel3dStore, type Model3DSpec, type ParametricSpec, type PolytopeSpec } from '../state/model3dStore'
import { useGestureRotation } from '../lib/gestures/useGestureRotation'
import { evaluateParametricSurface } from '../lib/geometry/parametricMath'
import { buildHypercube, buildCross, rotateInPlane, projectToR3 } from '../lib/geometry/polytopeMath'

/* ---- Parametric surface object ---- */

function ParametricObject({ spec }: { spec: ParametricSpec }) {
  const gestureOutput = useGestureStore(s => s.output)
  const gestureRef = useGestureRotation({ sensitivity: 2.5, emaAlpha: 0.22, deadZone: 0.015 })
  const groupRef = useRef<THREE.Group>(null)
  const grabRot = useRef({ y: 0, x: 0 })

  const geometry = useMemo(() => {
    const { positions, indices } = evaluateParametricSurface(spec)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1))
    geo.computeVertexNormals()
    return geo
  }, [spec])

  useFrame((state) => {
    const g = groupRef.current
    if (!g) return
    // Apply grab rotation
    const { deltaYaw, deltaPitch, grabActive } = gestureRef.current
    if (grabActive) {
      grabRot.current.y += deltaYaw
      grabRot.current.x += deltaPitch
    }
    g.rotation.y = grabRot.current.y
    g.rotation.x = grabRot.current.x
    // Pinch zoom: map zoom 0.5–3 to camera z 12–2
    if (gestureOutput.pinch.active) {
      state.camera.position.z = Math.max(2, Math.min(14, 6 / gestureOutput.pinch.zoom))
    }
  })

  const color = spec.color ?? '#38d5ff'
  return (
    <group ref={groupRef}>
      <mesh geometry={geometry}>
        <meshStandardMaterial color={color} side={THREE.DoubleSide} wireframe transparent opacity={0.85} emissive={color} emissiveIntensity={0.3} />
      </mesh>
    </group>
  )
}

/* ---- N-dimensional polytope object ---- */

function PolytopeObject({ spec }: { spec: PolytopeSpec }) {
  const gestureOutput = useGestureStore(s => s.output)
  const gestureRef = useGestureRotation({ sensitivity: 2.5, emaAlpha: 0.22, deadZone: 0.015 })
  const groupRef = useRef<THREE.Group>(null)
  const linesRef = useRef<THREE.LineSegments>(null)
  const spheresRef = useRef<THREE.InstancedMesh>(null)
  const ndAngles = useRef({ xw: 0, yw: 0, zw: 0 })
  const grabRot = useRef({ y: 0, x: 0 })

  const { vertices: baseVertices, edges } = useMemo(() =>
    spec.type === 'hypercube' ? buildHypercube(spec.dimension) : buildCross(spec.dimension),
  [spec])

  // Pre-allocate line geometry buffer (positions updated each frame)
  const lineGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(edges.length * 2 * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return geo
  }, [edges])

  useFrame((state, delta) => {
    const group = groupRef.current
    const lines = linesRef.current
    if (!group || !lines) return

    // 4D auto-rotation (only when dimension ≥ 4)
    if (spec.dimension >= 4) {
      ndAngles.current.xw += delta * 0.28
      ndAngles.current.yw += delta * 0.19
    }
    if (spec.dimension >= 5) {
      ndAngles.current.zw += delta * 0.13
    }

    // Manual grab rotation
    const { deltaYaw, deltaPitch, grabActive } = gestureRef.current
    if (grabActive) {
      grabRot.current.y += deltaYaw
      grabRot.current.x += deltaPitch
    }
    group.rotation.y = grabRot.current.y
    group.rotation.x = grabRot.current.x

    // Pinch zoom
    if (gestureOutput.pinch.active) {
      state.camera.position.z = Math.max(2, Math.min(16, 6 / gestureOutput.pinch.zoom))
    }

    // Apply N-D rotations to base vertices
    let verts = baseVertices
    if (spec.dimension >= 4) {
      verts = rotateInPlane(verts, 0, 3, ndAngles.current.xw)
      verts = rotateInPlane(verts, 1, 3, ndAngles.current.yw)
    }
    if (spec.dimension >= 5) {
      verts = rotateInPlane(verts, 2, 4, ndAngles.current.zw)
    }

    // Project to 3D
    const projected = projectToR3(verts)

    // Update line segment positions
    const posAttr = lines.geometry.attributes.position as THREE.BufferAttribute
    edges.forEach(([i, j], k) => {
      const p = projected[i]
      const q = projected[j]
      posAttr.setXYZ(k * 2,     p[0], p[1], p[2])
      posAttr.setXYZ(k * 2 + 1, q[0], q[1], q[2])
    })
    posAttr.needsUpdate = true

    // Update vertex sphere positions
    const spheres = spheresRef.current
    if (spheres) {
      const dummy = new THREE.Object3D()
      projected.forEach(([x, y, z], i) => {
        dummy.position.set(x, y, z)
        dummy.updateMatrix()
        spheres.setMatrixAt(i, dummy.matrix)
      })
      spheres.instanceMatrix.needsUpdate = true
    }
  })

  return (
    <group ref={groupRef}>
      <lineSegments ref={linesRef} geometry={lineGeo}>
        <lineBasicMaterial color="#38d5ff" transparent opacity={0.75} />
      </lineSegments>
      <instancedMesh ref={spheresRef} args={[undefined, undefined, baseVertices.length]}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshBasicMaterial color="#38d5ff" />
      </instancedMesh>
    </group>
  )
}

/* ---- Scene wrapper ---- */

function Scene({ spec }: { spec: Model3DSpec }) {
  return (
    <>
      <color attach="background" args={['#060d12']} />
      <ambientLight intensity={0.4} color="#38d5ff" />
      <pointLight position={[5, 5, 5]} intensity={1.2} color="#ffffff" />
      <pointLight position={[-5, -3, -5]} intensity={0.6} color="#0059ff" />
      {spec.kind === 'parametric'
        ? <ParametricObject spec={spec} />
        : <PolytopeObject spec={spec} />
      }
    </>
  )
}

/* ---- Overlay wrapper ---- */

export function Model3DViewer() {
  const open = useModel3dStore(s => s.open)
  const spec = useModel3dStore(s => s.spec)
  const hide = useModel3dStore(s => s.hide)

  // Esc closes the viewer
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hide])

  if (!open || !spec) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 5000,
      background: 'rgba(4, 10, 16, 0.96)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px', color: '#38d5ff', fontSize: 13, letterSpacing: 1,
        textTransform: 'uppercase', borderBottom: '1px solid rgba(56,213,255,0.2)',
      }}>
        <span>{spec.title ?? (spec.kind === 'polytope' ? `${spec.dimension}D ${spec.type}` : 'Superficie')}</span>
        <button
          onClick={hide}
          style={{ background: 'transparent', border: 'none', color: '#7fa6b8', cursor: 'pointer', fontSize: 20 }}
          aria-label="Cerrar"
        >×</button>
      </div>
      {/* 3D Canvas */}
      <div style={{ flex: 1 }}>
        <Canvas camera={{ position: [0, 0, 6], fov: 40 }}>
          <Scene spec={spec} />
        </Canvas>
      </div>
      {/* Footer hint */}
      <div style={{
        padding: '6px 20px', color: 'rgba(56,213,255,0.4)', fontSize: 11,
        borderTop: '1px solid rgba(56,213,255,0.1)',
        textAlign: 'center',
      }}>
        Puño cerrado: rotar · Pinch: zoom · Esc: cerrar
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors (if errors, fix imports/types before continuing)

- [ ] **Step 3: Commit**

```bash
cd .. && git add frontend/src/components/Model3DViewer.tsx && git commit -m "feat(3d): Model3DViewer — R3F overlay con gestos pinch-zoom y grab-rotate"
```

---

## Task 10: Wire primitives + mount in AwakeApp

**Files:**
- Modify: `frontend/src/skills/primitives.ts`
- Modify: `frontend/src/AwakeApp.tsx`

- [ ] **Step 1: Add model3d primitives to primitives.ts**

Open `frontend/src/skills/primitives.ts`. Add the import at the top (alongside other store imports):

```typescript
import { useModel3dStore, type Model3DSpec } from '../state/model3dStore'
```

Add two functions alongside the other primitives (after `displayHide`, before the `PRIMITIVES` map):

```typescript
/** Show the 3D model viewer. payload is a Model3DSpec. */
async function model3dShow(payload: any = {}): Promise<unknown> {
  const kind = payload?.kind
  if (!['parametric', 'polytope'].includes(kind)) throw new Error('invalid_model3d_kind')
  useModel3dStore.getState().show(payload as Model3DSpec)
  return { shown: true, kind, title: payload.title ?? '' }
}

/** Hide the 3D model viewer. */
async function model3dHide(): Promise<unknown> {
  useModel3dStore.getState().hide()
  return { hidden: true }
}
```

In the `PRIMITIVES` record, add alongside other entries:

```typescript
  model3d_show: model3dShow,
  model3d_hide: model3dHide,
```

- [ ] **Step 2: Mount Model3DViewer in AwakeApp.tsx**

Open `frontend/src/AwakeApp.tsx`. Add the import alongside other component imports:

```typescript
import { Model3DViewer } from './components/Model3DViewer'
```

In the JSX return, alongside the other overlays (`DisplayCard`, etc.), add:

```tsx
{/* 3D model viewer — full-screen overlay driven by model3dStore */}
<Model3DViewer />
```

Also: add `model3dStore.open` to the grab guard so the ring doesn't rotate while the viewer is open:

Find the line in the new ring drag handler:
```typescript
if (gestureOutput.pinch.active || zoomedMode != null) return
```

Replace with:
```typescript
const model3dOpen = useModel3dStore(s => s.open)
// ... (this selector should be at component level, not inside the effect)
```

Actually, add the selector at the component level (alongside other selectors):
```typescript
const model3dOpen  = useModel3dStore(s => s.open)
```

Then update the guard inside the grab useEffect:
```typescript
if (gestureOutput.pinch.active || zoomedMode != null || model3dOpen) return
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 4: Run all frontend tests**

```bash
cd frontend && npm test
```

Expected: all tests pass (no regressions)

- [ ] **Step 5: Commit**

```bash
cd .. && git add frontend/src/skills/primitives.ts frontend/src/AwakeApp.tsx && git commit -m "feat(3d): wire model3d_show/hide primitives + mount Model3DViewer in AwakeApp"
```

---

## Task 11: Backend — MCP tools, handlers, routes, prompt

**Files:**
- Modify: `backend/mcp-server/jarvis-mcp.js`
- Modify: `backend/src/handlers/skillTools.js`
- Modify: `backend/src/routes.js`
- Modify: `backend/src/handlers/speech.js`

- [ ] **Step 1: Add show_3d and hide_3d to jarvis-mcp.js**

Open `backend/mcp-server/jarvis-mcp.js`. In the `TOOLS` array, add before the `/* ----- Cloud ----- */` comment:

```javascript
  /* ----- Visor 3D ----- */
  {
    name: 'show_3d',
    description: 'Muestra el visor 3D de figuras matemáticas. Para superficies paramétricas usa kind="parametric" con expresiones x/y/z en u,v (mathjs). Para hipercubos/politopos N-dimensionales usa kind="polytope". Ejemplos: toro = {kind:"parametric", x:"cos(u)*(2+cos(v))", y:"sin(u)*(2+cos(v))", z:"sin(v)", uRange:[0,6.28], vRange:[0,6.28]}. Teseracto = {kind:"polytope", type:"hypercube", dimension:4}. Superboloide = {kind:"parametric", x:"sign(cos(u))*pow(abs(cos(u)),0.3)*sign(cos(v))*pow(abs(cos(v)),0.3)", y:"sign(sin(u))*pow(abs(sin(u)),0.3)", z:"sign(sin(v))*pow(abs(sin(v)),0.3)", uRange:[-1.5708,1.5708], vRange:[-3.1416,3.1416]}. Para cerrar usa hide_3d.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['parametric', 'polytope'], description: 'Tipo de figura' },
        // Parametric fields
        x: { type: 'string', description: '[parametric] expresión mathjs para x(u,v)' },
        y: { type: 'string', description: '[parametric] expresión mathjs para y(u,v)' },
        z: { type: 'string', description: '[parametric] expresión mathjs para z(u,v)' },
        uRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[parametric] rango de u: [min, max]' },
        vRange: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[parametric] rango de v: [min, max]' },
        segments: { type: 'integer', minimum: 8, maximum: 120, description: '[parametric] resolución de la malla, default 64' },
        // Polytope fields
        type: { type: 'string', enum: ['hypercube', 'cross'], description: '[polytope] tipo: hypercube (teseracto y más) o cross (ortoplex)' },
        dimension: { type: 'integer', minimum: 2, maximum: 7, description: '[polytope] número de dimensiones (4 = teseracto)' },
        // Common
        title: { type: 'string', description: 'Título a mostrar en el visor' },
        color: { type: 'string', description: '[parametric] color hex, default "#38d5ff"' },
      },
      required: ['kind'],
    },
    method: 'POST', path: '/api/skills/model3d/show',
  },
  {
    name: 'hide_3d',
    description: 'Cierra el visor 3D. Úsalo cuando el señor diga "cierra eso", "ya está", "quita la figura".',
    inputSchema: { type: 'object', properties: {} },
    method: 'POST', path: '/api/skills/model3d/hide',
  },
```

- [ ] **Step 2: Add handlers to skillTools.js**

Open `backend/src/handlers/skillTools.js`. In the `/* ----- DISPLAY / PICKER ----- */` section (or just before `/* ----- CLOUD ----- */`), add:

```javascript
/* ----- MODEL 3D ----- */

export async function handleModel3dShow(req, res) {
  return withBody(req, (body) => {
    const kind = body?.kind
    if (!['parametric', 'polytope'].includes(kind)) {
      return json(res, 400, { ok: false, error: 'invalid_kind', detail: 'kind must be parametric or polytope' })
    }
    return bridgeToBus('model3d_show', body, res)
  }, res)
}

export async function handleModel3dHide(req, res) {
  return withBody(req, () => bridgeToBus('model3d_hide', {}, res), res)
}
```

- [ ] **Step 3: Add routes to routes.js**

Open `backend/src/routes.js`. Add the import alongside the display handlers:

```javascript
  handleDisplayShow, handleDisplayHide, handlePickFile,
  handleModel3dShow, handleModel3dHide,
```

In the routes array, alongside the display routes:

```javascript
  { method: 'POST', path: '/api/skills/model3d/show', handler: handleModel3dShow },
  { method: 'POST', path: '/api/skills/model3d/hide', handler: handleModel3dHide },
```

- [ ] **Step 4: Add MODEL3D_PROMPT_SECTION to speech.js**

Open `backend/src/handlers/speech.js`. Add a new section constant after `DISPLAY_PROMPT_SECTION`:

```javascript
// Always available: 3D model viewer for geometric figures and N-D polytopes.
const MODEL3D_PROMPT_SECTION = `

VISOR 3D: Para mostrar figuras matemáticas 3D usa show_3d. Superficies paramétricas: proporciona x(u,v), y(u,v), z(u,v) como expresiones mathjs (sin, cos, pow, sqrt, PI, etc.) con uRange y vRange en radianes o el rango apropiado. Politopos N-dimensionales: kind="polytope" con type="hypercube" o "cross" y dimension=N. Ejemplos concretos — Toro: x="cos(u)*(2+cos(v))", y="sin(u)*(2+cos(v))", z="sin(v)", uRange=[0,6.28], vRange=[0,6.28]. Esfera: x="sin(u)*cos(v)", y="sin(u)*sin(v)", z="cos(u)", uRange=[0,3.14], vRange=[0,6.28]. Teseracto: kind="polytope", type="hypercube", dimension=4. En voz, di brevemente qué vas a mostrar ("Te muestro el toro", "Ahí está el teseracto girando") y llama show_3d. Nunca recites la fórmula en voz. Si el señor pide cerrar, llama hide_3d.`
```

Then update the `SPEECH_SYSTEM_PROMPT` composition:

```javascript
const SPEECH_SYSTEM_PROMPT =
  SPEECH_SYSTEM_PROMPT_BASE +
  DISPLAY_PROMPT_SECTION +
  MODEL3D_PROMPT_SECTION +
  (vaultConfigured() ? VAULT_PROMPT_SECTION : '') +
  (getCodeDir() ? CODE_PROMPT_SECTION : '') +
  (broadStorageEnabled ? STORAGE_PROMPT_SECTION : '')
```

- [ ] **Step 5: Verify backend modules load**

```bash
cd backend && node --input-type=module --eval "
import('./src/routes.js').then(m => {
  const r = m.routes.filter(x => x.path.includes('model3d'))
  console.log('model3d routes:', r.map(x => x.method + ' ' + x.path))
}).catch(e => console.error('FAIL:', e.message))
" 2>&1
```

Expected: `model3d routes: ['POST /api/skills/model3d/show', 'POST /api/skills/model3d/hide']`

- [ ] **Step 6: Verify MCP tool count**

```bash
cd backend && node --input-type=module --eval "
import { readFileSync } from 'fs'
const s = readFileSync('./mcp-server/jarvis-mcp.js', 'utf-8')
const n = [...s.matchAll(/name: '([^']+)'/g)].map(m => m[1]).filter(x => x !== 'jarvis-mcp')
console.log('total tools:', n.length, '| 3d tools:', n.filter(t => t.includes('3d')).join(', '))
" 2>&1
```

Expected: total tools 39, 3d tools: show_3d, hide_3d

- [ ] **Step 7: Commit**

```bash
cd .. && git add backend/mcp-server/jarvis-mcp.js backend/src/handlers/skillTools.js backend/src/routes.js backend/src/handlers/speech.js && git commit -m "feat(3d): backend MCP tools show_3d/hide_3d + handlers + routes + prompt section"
```

---

## Task 12: Backend tests + full test run

**Files:**
- Create: `backend/tests/model3d.contract.test.js`

- [ ] **Step 1: Write backend smoke tests**

Create `backend/tests/model3d.contract.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const BASE = `http://localhost:${process.env.PORT || 8788}`
const FAKE = !!process.env.JARVIS_FAKE_CLAUDE

describe('POST /api/skills/model3d/show (smoke)', () => {
  it('returns 400 for missing kind', async () => {
    const res = await fetch(`${BASE}/api/skills/model3d/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'u', y: 'v', z: '0' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('invalid_kind')
  })

  it('returns 400 for invalid kind value', async () => {
    const res = await fetch(`${BASE}/api/skills/model3d/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'mesh' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

describe('POST /api/skills/model3d/hide (smoke)', () => {
  it('responds (may be no_client if UI is not connected)', async () => {
    const res = await fetch(`${BASE}/api/skills/model3d/hide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    // Either ok:true (UI connected) or ok:false with no_client (no UI in test env) — both are valid
    expect([200, 503]).toContain(res.status)
  })
})
```

- [ ] **Step 2: Run backend tests**

```bash
cd backend && JARVIS_FAKE_CLAUDE=1 npm test 2>&1 | tail -10
```

Expected: all tests pass. The 2 pre-existing failures on `/api/jarvis/turn` (caused by real server on port 8788) are expected and not regressions. Model3d tests may show 503 (no_client) for the hide test — that is acceptable.

- [ ] **Step 3: Run all frontend tests**

```bash
cd frontend && npm test 2>&1 | tail -10
```

Expected: all tests pass including the new geometry and gesture helper tests.

- [ ] **Step 4: Commit**

```bash
cd .. && git add backend/tests/model3d.contract.test.js && git commit -m "test(3d): backend smoke tests for model3d show/hide routes"
```

---

## Task 13: Rebuild EXE + final commit

- [ ] **Step 1: Run full test suite one last time**

```bash
cd backend && JARVIS_FAKE_CLAUDE=1 npm test 2>&1 | grep -E "Test Files|Tests "
cd ../frontend && npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected:
- Backend: 8 files passed, 43+ tests passed (41 prior + 2 new model3d)
- Frontend: geometry + gesture helper tests pass

- [ ] **Step 2: Rebuild EXE**

```bash
cd .. && npm run dist 2>&1 | tail -5
```

Expected: `Jarvis Setup 1.0.0.exe` generated in `dist-electron/`

- [ ] **Step 3: Verify working tree is clean**

```bash
git status --short
```

Expected: empty (all committed)

- [ ] **Step 4: Final push**

```bash
git push origin master
```

---

## Summary of what this delivers

**Gesture rotation (Tasks 1-5):**
- Shared `useGestureRotation` hook: clutch + EMA + dead zone + non-linear. One place to tune feel.
- Ring: continuous drag follows the hand, snaps to nearest slot on release. No more step+rearm.
- Ring gesture stops while 3D viewer is open (exclusive capture).

**3D viewer (Tasks 6-13):**
- Parametric surfaces: any `(u,v)→(x,y,z)` surface via mathjs (toro, esfera, superboloide, Klein, etc.).
- N-D polytopes: `hypercube(n)` and `cross(n)` for any n=2-7; 4D/5D auto-rotates in XW/YW/ZW planes so the tesseract "unfolds" visually.
- Gesture: pinch = dolly zoom, grab = trackball rotate. Both work simultaneously.
- MCP tools `show_3d`/`hide_3d`; Jarvis receives a `spec` and renders it without reciting formulas aloud.
