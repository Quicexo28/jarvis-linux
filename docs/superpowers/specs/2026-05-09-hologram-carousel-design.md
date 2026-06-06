# Hologram Carousel — Design Spec

**Date**: 2026-05-09
**Project**: jarvis-desktop (frontend)
**Status**: Approved for implementation planning

## Goal

Replace the scattered hologram constellation in `WorldScene.tsx` with a **rotating carousel centered on the camera/POV** that snaps between fixed angular positions (one per hologram). Existing hologram geometries and renders are kept verbatim — only the layout and interaction change.

## Why

The current layout positions seven holograms at hand-tuned 3D points around the camera (`HP` in `WorldScene.tsx:14-23`). Users browse by hovering and clicking on a free constellation. The user dislikes this disposition and interaction: it lacks structure, the focus point is ambiguous, and selecting between modes feels like aiming rather than choosing.

The carousel imposes a directed, predictable interaction: at any moment exactly one mode is "active" (in front of the camera), and rotation between modes is discrete and ordered. The cinematic quality of the renders is preserved while the navigation becomes legible.

## Scope

In scope:
- New ring-based layout for the four main modes: `home`, `house`, `cloud`, `system`.
- Nested sub-ring for `plan2d`, `plan3d`, `space` reached by entering `house`.
- Keyboard + click input model with discrete snap rotation.
- Visual emphasis (perspective + brightness) for active vs. peripheral.
- Removal of the legacy house panel listing of saved plans (replaced by direct sub-ring entry).

Out of scope:
- Backend changes (none).
- Per-hologram geometry rework — the existing `NeuralFireGeo`, `TowerGeo`, `Plan2DGeo`, `Plan3DGeo`, `SpaceGeo`, `HexTorusGeo`, `HexDieGeo` are reused unchanged.
- Mobile client (`MobileClient.tsx`) — unchanged; the `mobile` mode is not on the carousel.
- Plan editors and viewers (`Plan2DEditor`, `Plan3DViewer`, `SpaceViewer`) — unchanged. Each already accepts an optional `initialSelectedKey` and provides its own internal plan selector.

## Geometry

Camera fixed at origin `(0, 0, 0)`, looking down `-Z`, `fov=72`, `near=0.1`, `far=200`.

The four main holograms are children of a single rotating `<group>`:

| Mode   | Snap angle | Local position when at front |
|--------|-----------:|:-----------------------------|
| home   |   0°       | `(0, 0, -R_active)`          |
| house  |  90°       | `(0, 0, -R_active)`          |
| system | 180°       | `(0, 0, -R_active)`          |
| cloud  | 270°       | `(0, 0, -R_active)`          |

Two radii drive the perspective effect:
- `R_active = 4` — distance from camera when a hologram is the active snap.
- `R_idle = 7` — distance when peripheral. Inactive holograms sit further from the camera, producing the smaller / dimmer look.

Each hologram lives inside the rotating container at a fixed angular slot, but its actual radius (and other visual properties) is computed per frame from how close that slot is to the front:

```
angleFromFront = absolute angle between the hologram's slot and the camera's forward
                 (computed after applying the container's animated rotation.y)

focus = max(0, cos(angleFromFront))   // 1 at front, 0 at ±90°, <0 behind
r     = R_idle + (R_active - R_idle) * focus
scale = 0.65 + 0.55 * focus           // 0.65 idle → 1.20 active
opacity = 0.45 + 0.55 * focus
visible = angleFromFront < 100°       // hide rear hologram
```

The hologram's local position is therefore `(r * sin(slotAngle), 0, -r * cos(slotAngle))` recomputed each frame. The container group provides the global rotation that brings the active slot to `slotAngle == 0` (front of camera). Active gets `focus≈1`, the two adjacents `focus=0`, the rear is culled.

The active snap will have `focus ≈ 1`, the two adjacents `focus = 0`, the rear one is culled.

The same model applies to the sub-ring (`plan2d`, `plan3d`, `space`) at 120° spacing.

## Visual states

For the active hologram:
- Scale `1.20` (matches today's zoomed scale).
- Full opacity, full emissive intensity (each geometry's `active={true}` prop already increases its emissive — keep using it).
- Sits at `R_active = 4` along `-Z`.

For adjacent holograms (`±90°` from front, or `±120°` in the sub-ring):
- Scale `0.65`.
- Opacity `0.45`.
- Emissive intensity unchanged from idle baseline (`active={false}` per geometry).
- Sits at `R_idle = 7`.

For the rear hologram (180° from front, main ring only):
- `visible = false`. Skipped entirely.

The `CosmicBackground` (800 stars) remains as is. The two `pointLight` sources and `ambientLight` from `WorldScene.tsx:919-921` are kept.

## Input model

Listener attached at the `AwakeApp` level, active only when `zoomedMode == null`:

| Input               | Action                                    |
|---------------------|-------------------------------------------|
| `←` / Left arrow    | `rotateRing(-1)` — previous snap          |
| `→` / Right arrow   | `rotateRing(+1)` — next snap              |
| `Enter`             | `setZoomedMode(activeRingMode)` (or, for house, `setRingLevel('house-sub')`) |
| `Esc`               | If `ringLevel='house-sub'`: back to main ring. Else: noop. |
| Click on adjacent   | Rotate one snap toward the clicked mode   |
| Click on active     | Same as `Enter`                           |
| Mouse wheel         | Disabled (avoids conflicts with scroll inside panels) |

Rotation animation: lerp `currentAngle → targetAngle` per frame using the existing damping pattern `k = 1 - Math.pow(0.005, delta)`, multiplied by `~6` for an effective settle time of `~350 ms`. No overshoot.

When already animating, a new arrow press queues the next target — the lerp restarts from the in-flight angle, no jitter.

## Mode entry

For `home`, `cloud`, `system` (panel modes):
1. `Enter` on the active snap calls `setZoomedMode(activeRingMode)`.
2. The carousel does not move the camera. Instead the ring opacity drops to `0.35` (cosmic background to `0.15`), and the active hologram slides to `x = -2` in local space and scales to `0.85`, freeing the right half of the screen.
3. The corresponding `HudPanel` (`core-panel` for home, `mode-panel` for cloud/system) fades + slides in from the right over `120 ms`.
4. `Esc` or the existing `Volver` button reverses the animation: panel slides out, ring opacity restores, hologram returns to center at scale `1.20`.

For `plan2d`, `plan3d`, `space` (canvas modes — only reached from the house sub-ring):
1. `Enter` on the active sub-snap calls `setZoomedMode(activeRingMode)`.
2. The existing `mode-overlay` fade-in from `AwakeApp.tsx:265-271` is reused as is — overlay covers the world, world fades out (`opacity 0.55s`).
3. `Esc` or `Volver`: `setZoomedMode(null)` returns to the sub-ring (because `ringLevel === 'house-sub'` is preserved across the canvas trip).

## Nested ring (house → sub-modes)

State machine:

```
ringLevel='main', zoomedMode=null     ← user browses 4 main modes
  ↓ Enter on house
ringLevel='house-sub', zoomedMode=null   ← user browses 3 sub-modes
  ↓ Enter on plan2d/plan3d/space
ringLevel='house-sub', zoomedMode='plan2d'  ← canvas overlay active
  ↑ Esc / Volver
ringLevel='house-sub', zoomedMode=null
  ↑ Esc / Volver
ringLevel='main', zoomedMode=null
```

Transition into the sub-ring (when entering house):
1. The four main holograms fade out and shrink to scale `0.4` over `300 ms`.
2. At the same time, three sub-holograms emerge from the camera origin with the existing spring animation (`SpringNode` pattern from `WorldScene.tsx:840-870`, but with new targets at the sub-ring slot positions).
3. Sub-ring snap angles: `plan3d=0°`, `space=120°`, `plan2d=240°`.
4. After the spring settles, the sub-ring is interactive and obeys the same input model.

Transition out (Esc from sub-ring):
1. The three sub-holograms collapse back to the origin over `300 ms`.
2. The four main holograms fade in and grow back to their ring slots.
3. State resets to `ringLevel='main', activeRingMode='house'`.

## State store changes (`jarvisStore.ts`)

Add:

```ts
type RingLevel = 'main' | 'house-sub'

interface JarvisState {
  // existing fields...
  ringLevel: RingLevel
  activeRingMode: Mode             // which snap is at the front
  setRingLevel: (level: RingLevel) => void
  rotateRing: (direction: -1 | 1) => void
  setActiveRingMode: (mode: Mode) => void
}
```

`rotateRing(direction)` advances `activeRingMode` along the cyclic list for the current ring level:
- `main`: `['home', 'house', 'system', 'cloud']` (clockwise from front).
- `house-sub`: `['plan3d', 'space', 'plan2d']` (clockwise from front).

Setting `ringLevel='house-sub'` resets `activeRingMode` to `'plan3d'`. Setting `ringLevel='main'` resets to `'house'` (so the user is right back where they entered the sub-ring).

`zoomedMode` keeps its current type and semantics. The carousel is layered on top of the existing zoom system rather than replacing it.

## File-level changes

| File | Change |
|------|--------|
| `frontend/src/scenes/WorldScene.tsx` | Major rewrite — see "Removed / Added" below |
| `frontend/src/state/jarvisStore.ts` | Add `ringLevel`, `activeRingMode`, `rotateRing`, `setRingLevel`, `setActiveRingMode` |
| `frontend/src/AwakeApp.tsx` | Remove house panel block (lines 310-326). Extend the existing `Escape` keydown listener (`AwakeApp.tsx:84-88`) into a single handler that covers ←/→/Enter/Esc with the right precedence: when `zoomedMode != null` Esc behaves as today (`handleBack`); when `zoomedMode == null` arrows rotate, Enter enters, and Esc demotes from `house-sub` to `main`. Remove `housePlans`, `housePlanKey`. Adjust panel entry animations to use slide-from-right + ring dim. |
| `frontend/src/styles/design-system.css` | Add keyframes for the panel slide-in from right and CSS variables for ring dim opacity. Selector hooks live on the existing panel classes (`core-panel`, `mode-panel`); no new module needed. |
| `frontend/src/state/jarvisStore.test.ts` | Add tests for `rotateRing` cyclic behavior in both ring levels and for `setRingLevel` reset behavior |
| `frontend/src/types.ts` | No type changes — `Mode` union stays. `mobile` remains valid but is not on the carousel. |

Removed from `WorldScene.tsx`:
- `HP`, `OVERVIEW_LOOK`, `SUB_ORIGIN`, `SUB_TARGETS`, `SUB_DELAYS` constants.
- `CameraController` component.
- `HologramNode`, `SubHologramNode`, `SpringNode`, `AssemblyParticles`, `HouseSubUniverse` components.

Added to `WorldScene.tsx`:
- `RingGroup` — owns the lerped `rotation.y` and renders its children at fixed local angles.
- `RingHologram` — wraps a single geometry, computes `focus` from its angle vs. front, applies radius offset, scale, opacity, visibility.
- `RingController` — reads `activeRingMode` and `ringLevel` from the store, exposes the click handlers, drives `RingGroup`'s rotation target.
- `MainRing` — renders the four main holograms inside a `RingGroup`.
- `HouseSubRing` — renders the three sub-mode holograms inside a `RingGroup`. Mounts only when `ringLevel === 'house-sub'`. Uses spring entrance/exit.

Reused unchanged from `WorldScene.tsx`:
- `CosmicBackground`.
- `NeuralFireGeo`, `HouseGeoFallback`, `TowerGeoInner`, `TowerGeo`, `GltfErrorBoundary`.
- `Plan2DGeo`, `Plan3DGeo`, `SpaceGeo`, `HexTorusGeo`, `HexDieGeo`.
- `useGLTF.preload(TOWER_MODEL_URL)` at module bottom.

## Tests

`frontend/src/state/jarvisStore.test.ts`:
- `rotateRing(+1)` with `ringLevel='main'`, `activeRingMode='home'` → `activeRingMode` becomes `'house'`.
- `rotateRing(-1)` with `activeRingMode='home'` → becomes `'cloud'` (wraps).
- `rotateRing(+1)` four times returns to `'home'`.
- `setRingLevel('house-sub')` sets `activeRingMode='plan3d'` (default for sub-ring).
- `setRingLevel('main')` sets `activeRingMode='house'` (returns user to the entry point).
- `rotateRing` in `house-sub` cycles through `plan3d → space → plan2d → plan3d`.

A separate scene-level test for `WorldScene` is not required — visual behavior is covered manually by running the dev server. If a smoke test is desired later, it would assert that the rendered scene contains 4 hologram groups when `ringLevel='main'` and 3 when `ringLevel='house-sub'`.

## Risks and trade-offs

- **Loss of plans-list shortcut**: removing the house panel removes the inline list of saved rooms. Users now go through the sub-ring → canvas, where each canvas screen has its own selector. Acceptable since the main usage path is "open one of the editors", not "scan all rooms".
- **No mouse-wheel rotation**: deliberate, to avoid scroll conflict inside panels. If users complain, can be added scoped to a hover state on the canvas.
- **House sub-ring transition cost**: the spring animation requires recomputing positions per frame for ~600 ms. Negligible at 60 fps.
- **Rear hologram culling on the main ring**: with only 4 modes, the back snap is at 180° and is fully invisible. Some users may feel "where did system go?" — this is mitigated by the snap indicator (small dot row) but could be worth a future affordance.

## Open questions deferred to implementation

- Snap indicator visual: small dot row at bottom showing position in the cycle? Decided during implementation.
- Whether the body should carry a `data-ring-level` attribute for CSS styling, or use inline styles on the panel root. Implementation detail.
- Exact easing curve for the rotation lerp — start with current damping; tune by feel.
