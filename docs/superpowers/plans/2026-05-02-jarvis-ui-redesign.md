# Jarvis Desktop — UI/UX Full Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete holographic UI/UX redesign with a 3-phase boot state machine (DORMANT → LISTENING → AWAKE), transparent Electron window, atomic nucleus 3D Core scene, and unified cyan/black design system across all 7 modes.

**Architecture:** Single transparent fullscreen Electron window. React renders 3 stacked layers controlled by `bootStore`: `DormantLayer` (always mounted, clap detection), `ListeningLayer` (pulsing dot + wake word), `AwakeApp` (full redesigned app). Transition between LISTENING→AWAKE uses a canvas radial-expansion animation from center-bottom. All modes share `CosmicBackground` (particle field) and the same glass/cyan design tokens.

**Tech Stack:** Electron 30, React 19, Three.js 0.183, @react-three/fiber 9, @react-three/drei 10, Zustand 5, TypeScript, Vite, CSS custom properties (no Tailwind)

---

## File Map

### New files
| File | Responsibility |
|------|----------------|
| `frontend/src/state/bootStore.ts` | DORMANT / LISTENING / AWAKE state machine |
| `frontend/src/components/DormantLayer.tsx` | Invisible layer — clap detector, IPC sync |
| `frontend/src/components/ListeningLayer.tsx` | Pulsing dot + wake-word recognizer |
| `frontend/src/components/RadialTransition.tsx` | Canvas radial expansion LISTENING→AWAKE |
| `frontend/src/components/GlassPanel.tsx` | Reusable `<div class="glass">` wrapper |
| `frontend/src/components/HoloDock.tsx` | Bottom navigation dock (hover to reveal) |
| `frontend/src/components/CosmicBackground.tsx` | Shared R3F particle-field background |
| `frontend/src/scenes/AtomicNucleusScene.tsx` | Core mode — nucleus + orbital rings |
| `frontend/src/scenes/HouseHoloScene.tsx` | Casa mode — miniature plan holograms |
| `frontend/src/scenes/CloudHoloScene.tsx` | Cloud mode — network node constellation |
| `frontend/src/scenes/SystemHoloScene.tsx` | System mode — 3 orbital rings (CPU/GPU/Net) |
| `frontend/src/AwakeApp.tsx` | Full app shell (extracted from App.tsx, redesigned) |
| `frontend/src/styles/design-system.css` | CSS variables, glass, buttons, inputs, layers |

### Modified files
| File | Changes |
|------|---------|
| `electron/main.js` | Transparent fullscreen window, ipcMain handlers |
| `electron/preload.js` | Expose `setBootState`, `onBootState` via contextBridge |
| `frontend/src/App.tsx` | Becomes boot-layer orchestrator (DormantLayer/ListeningLayer/AwakeApp) |
| `frontend/index.html` | Add Space Grotesk font link |
| `frontend/src/index.css` | Import design-system.css only |
| `frontend/src/HoloScene.tsx` | Deleted — replaced by scene files |
| `frontend/src/modes/Plan2DEditor.tsx` | Dot grid, glass panels, glow walls |
| `frontend/src/modes/Plan3DViewer.tsx` | Cyan materials, glass sidebar, holographic grid |
| `frontend/src/modes/SpaceViewer.tsx` | Crosshair component, glass popup |

---

## Task 1: Boot State Store

**Files:**
- Create: `frontend/src/state/bootStore.ts`
- Create: `frontend/src/state/bootStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/state/bootStore.test.ts`:
```ts
import { test, expect, beforeEach } from 'vitest'
import { useBootStore } from './bootStore'

beforeEach(() => {
  useBootStore.setState({ bootState: 'DORMANT' })
})

test('initial bootState is DORMANT', () => {
  expect(useBootStore.getState().bootState).toBe('DORMANT')
})

test('setBootState transitions to LISTENING', () => {
  useBootStore.getState().setBootState('LISTENING')
  expect(useBootStore.getState().bootState).toBe('LISTENING')
})

test('setBootState transitions to AWAKE', () => {
  useBootStore.getState().setBootState('AWAKE')
  expect(useBootStore.getState().bootState).toBe('AWAKE')
})

test('setBootState can return to DORMANT from AWAKE', () => {
  useBootStore.getState().setBootState('AWAKE')
  useBootStore.getState().setBootState('DORMANT')
  expect(useBootStore.getState().bootState).toBe('DORMANT')
})
```

- [ ] **Step 2: Run test — verify it fails**

```
cd frontend && npm test -- --run src/state/bootStore.test.ts
```
Expected: FAIL — "Cannot find module './bootStore'"

- [ ] **Step 3: Create bootStore.ts**

Create `frontend/src/state/bootStore.ts`:
```ts
import { create } from 'zustand'

export type BootState = 'DORMANT' | 'LISTENING' | 'AWAKE'

interface BootStore {
  bootState: BootState
  setBootState: (state: BootState) => void
}

export const useBootStore = create<BootStore>((set) => ({
  bootState: 'DORMANT',
  setBootState: (bootState) => set({ bootState }),
}))
```

- [ ] **Step 4: Run tests — verify they pass**

```
cd frontend && npm test -- --run src/state/bootStore.test.ts
```
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/bootStore.ts frontend/src/state/bootStore.test.ts
git commit -m "feat(boot): bootStore DORMANT/LISTENING/AWAKE state machine"
```

---

## Task 2: Electron — Transparent Fullscreen Window + IPC

**Files:**
- Modify: `electron/preload.js`
- Modify: `electron/main.js`

- [ ] **Step 1: Rewrite preload.js**

Replace `electron/preload.js` entirely:
```js
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronBridge', {
  platform: process.platform,
  setBootState: (state) => ipcRenderer.invoke('boot:setState', state),
  onBootState: (cb) => {
    ipcRenderer.on('boot:state', (_, s) => cb(s))
    return () => ipcRenderer.removeAllListeners('boot:state')
  },
})
```

- [ ] **Step 2: Update line 1 of main.js — add ipcMain**

Change:
```js
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron')
```
To:
```js
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron')
```

- [ ] **Step 3: Replace createWindow() in main.js (lines 25–51)**

```js
function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    title: 'Jarvis',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Start dormant: invisible and click-through
  mainWindow.setIgnoreMouseEvents(true, { forward: true })

  if (IS_DEV) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(getFrontendPath())
  }

  mainWindow.on('close', (e) => {
    e.preventDefault()
    mainWindow.hide()
  })
}
```

- [ ] **Step 4: Add IPC handlers inside app.whenReady() after createTray()**

```js
  ipcMain.handle('boot:setState', (_, state) => {
    if (!mainWindow) return
    if (state === 'DORMANT') {
      mainWindow.setIgnoreMouseEvents(true, { forward: true })
      mainWindow.setSkipTaskbar(true)
    } else if (state === 'LISTENING') {
      mainWindow.setIgnoreMouseEvents(true, { forward: true })
      mainWindow.setSkipTaskbar(true)
    } else if (state === 'AWAKE') {
      mainWindow.setIgnoreMouseEvents(false)
      mainWindow.setSkipTaskbar(false)
      mainWindow.focus()
    }
  })
```

- [ ] **Step 5: Commit**

```bash
git add electron/main.js electron/preload.js
git commit -m "feat(electron): transparent fullscreen window + boot IPC handlers"
```

---

## Task 3: DormantLayer

**Files:**
- Create: `frontend/src/components/DormantLayer.tsx`

- [ ] **Step 1: Create DormantLayer.tsx**

Create `frontend/src/components/DormantLayer.tsx`:
```tsx
import { useEffect } from 'react'
import { useClapDetection } from '../hooks/useClapDetection'
import { useBootStore } from '../state/bootStore'

export function DormantLayer() {
  const bootState = useBootStore((s) => s.bootState)
  const setBootState = useBootStore((s) => s.setBootState)

  // Sync every boot state change to Electron window behavior
  useEffect(() => {
    const bridge = (window as any).electronBridge
    bridge?.setBootState?.(bootState)
  }, [bootState])

  // Listen for double clap only when fully dormant
  useClapDetection({
    enabled: bootState === 'DORMANT',
    threshold: 0.55,
    onDoubleClap: () => setBootState('LISTENING'),
  })

  return null
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/DormantLayer.tsx
git commit -m "feat(boot): DormantLayer — invisible clap listener for DORMANT->LISTENING"
```

---

## Task 4: ListeningLayer

**Files:**
- Create: `frontend/src/components/ListeningLayer.tsx`

- [ ] **Step 1: Create ListeningLayer.tsx**

Create `frontend/src/components/ListeningLayer.tsx`:
```tsx
import { useEffect, useRef } from 'react'
import { useBootStore } from '../state/bootStore'
import { useJarvisStore } from '../state/jarvisStore'

export function ListeningLayer() {
  const setBootState = useBootStore((s) => s.setBootState)
  const wakePhrase = useJarvisStore((s) => s.wakePhrase)
  const recRef = useRef<any>(null)

  // Auto-return to DORMANT after 30 s with no wake word detected
  useEffect(() => {
    const timer = setTimeout(() => setBootState('DORMANT'), 30_000)
    return () => clearTimeout(timer)
  }, [setBootState])

  // Continuous speech recognition — wait for wake phrase
  useEffect(() => {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!Ctor) return

    const rec = new Ctor()
    recRef.current = rec
    rec.lang = 'es-CO'
    rec.continuous = true
    rec.interimResults = true

    rec.onresult = (evt: any) => {
      const last = evt?.results?.[evt.results.length - 1]
      const text = String(last?.[0]?.transcript ?? '').toLowerCase()
      const phrase = wakePhrase.trim().toLowerCase()
      if (phrase && text.includes(phrase)) {
        setBootState('AWAKE')
      }
    }

    const restart = () => { try { rec.start() } catch {} }
    rec.onerror = restart
    rec.onend = restart
    rec.start()

    return () => {
      try { rec.onend = null; rec.stop() } catch {}
    }
  }, [wakePhrase, setBootState])

  return (
    <div className="listening-layer">
      <div className="listening-dot">
        <div className="dot-core" />
        <div className="dot-ring dot-ring-1" />
        <div className="dot-ring dot-ring-2" />
      </div>
      <span className="listening-label">· · ·</span>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/ListeningLayer.tsx
git commit -m "feat(boot): ListeningLayer — pulsing dot + 30s wake-word listener"
```

---

## Task 5: RadialTransition

**Files:**
- Create: `frontend/src/components/RadialTransition.tsx`

- [ ] **Step 1: Create RadialTransition.tsx**

Create `frontend/src/components/RadialTransition.tsx`:
```tsx
import { useEffect, useRef } from 'react'

interface Props {
  onComplete: () => void
}

export function RadialTransition({ onComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = window.innerWidth
    const h = window.innerHeight
    canvas.width = w
    canvas.height = h

    // Origin: center-bottom — exact position of the listening dot
    const ox = w / 2
    const oy = h - 24
    const maxRadius = Math.sqrt(w * w + h * h)

    const startTime = performance.now()
    let rafId = 0

    const draw = (now: number) => {
      const elapsed = now - startTime
      ctx.clearRect(0, 0, w, h)

      // Expansion phase: 100ms -> 600ms
      if (elapsed > 100 && elapsed < 700) {
        const progress = Math.min(1, (elapsed - 100) / 500)
        const radius = maxRadius * Math.pow(progress, 0.65)

        const gradient = ctx.createRadialGradient(ox, oy, 0, ox, oy, radius)
        gradient.addColorStop(0, '#00f0ff')
        gradient.addColorStop(0.35, '#0059ff')
        gradient.addColorStop(1, '#03080d')

        ctx.beginPath()
        ctx.arc(ox, oy, radius, 0, Math.PI * 2)
        ctx.fillStyle = gradient
        ctx.fill()

        // Leading edge glow
        ctx.beginPath()
        ctx.arc(ox, oy, radius, 0, Math.PI * 2)
        ctx.strokeStyle = '#00f0ff'
        ctx.lineWidth = 2
        ctx.shadowBlur = 20
        ctx.shadowColor = '#00f0ff'
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      // Fade canvas out after 600ms
      if (elapsed >= 600) {
        canvas.style.opacity = String(Math.max(0, 1 - (elapsed - 600) / 200))
      }

      if (elapsed < 800) {
        rafId = requestAnimationFrame(draw)
      } else {
        onComplete()
      }
    }

    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [onComplete])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' }}
    />
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/RadialTransition.tsx
git commit -m "feat(boot): RadialTransition — canvas expansion from center-bottom (800ms)"
```

---

## Task 6: Design System CSS

**Files:**
- Create: `frontend/src/styles/design-system.css`
- Modify: `frontend/index.html`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Update index.html with Space Grotesk font**

Replace `frontend/index.html`:
```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Jarvis</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create design-system.css**

Create `frontend/src/styles/design-system.css`:
```css
/* --- Jarvis Design System ---------------------------------------- */
:root {
  --bg:           #03080d;
  --primary:      #00f0ff;
  --accent:       #0059ff;
  --glass-bg:     rgba(0, 240, 255, 0.04);
  --glass-border: rgba(0, 240, 255, 0.15);
  --glow-sm:      0 0 12px rgba(0, 240, 255, 0.4);
  --glow-md:      0 0 24px rgba(0, 240, 255, 0.3);
  --text:         #c8f4ff;
  --text-dim:     rgba(200, 244, 255, 0.45);
  --font:         'Space Grotesk', sans-serif;
  --r:            12px;
  --r-sm:         6px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  letter-spacing: 0.04em;
  overflow: hidden;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

/* --- Glass panel --- */
.glass {
  background: var(--glass-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  border-radius: var(--r);
  box-shadow: inset 0 0 30px rgba(0,240,255,0.04), 0 4px 24px rgba(0,0,0,0.4);
}

/* --- Buttons --- */
.btn {
  background: transparent;
  border: 1px solid rgba(0,240,255,0.3);
  color: var(--primary);
  padding: 6px 16px;
  border-radius: var(--r-sm);
  font-family: var(--font);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
  white-space: nowrap;
}
.btn:hover  { background: rgba(0,240,255,0.1); box-shadow: var(--glow-sm); }
.btn.active { background: rgba(0,240,255,0.15); border-color: var(--primary); box-shadow: var(--glow-sm); }
.btn:disabled { opacity: 0.3; cursor: default; }

/* --- Label --- */
.label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-dim);
}

/* --- Input --- */
.input {
  background: rgba(0,240,255,0.03);
  border: 1px solid rgba(0,240,255,0.15);
  border-radius: var(--r-sm);
  color: var(--text);
  font-family: var(--font);
  font-size: 12px;
  padding: 7px 12px;
  width: 100%;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.input::placeholder { color: var(--text-dim); }
.input:focus { border-color: rgba(0,240,255,0.5); box-shadow: var(--glow-sm); }

/* --- Select --- */
.select {
  background: rgba(0,240,255,0.03);
  border: 1px solid rgba(0,240,255,0.15);
  border-radius: var(--r-sm);
  color: var(--text);
  font-family: var(--font);
  font-size: 12px;
  padding: 7px 12px;
  width: 100%;
  outline: none;
  cursor: pointer;
}
.select option { background: #03080d; }

/* --- Listening layer (LISTENING state) --- */
.listening-layer {
  position: fixed;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  z-index: 500;
}
.listening-dot {
  position: relative;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dot-core {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: 0 0 16px var(--primary), 0 0 32px rgba(0,240,255,0.3);
  position: absolute;
  z-index: 2;
}
.dot-ring {
  position: absolute;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--primary);
  animation: ping 1.2s ease-in-out infinite;
}
.dot-ring-2 { animation-delay: 0.6s; }
@keyframes ping {
  0%   { transform: scale(1); opacity: 0.5; }
  100% { transform: scale(1.8); opacity: 0; }
}
.listening-label {
  font-size: 11px;
  color: rgba(0,240,255,0.55);
  letter-spacing: 6px;
  animation: blink 1.4s ease-in-out infinite;
}
@keyframes blink {
  0%, 100% { opacity: 0.55; }
  50%       { opacity: 0.15; }
}

/* --- Dock --- */
.holo-dock {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%) translateY(0);
  transition: transform 0.3s ease;
  z-index: 200;
  padding: 10px 20px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.holo-dock.hidden { transform: translateX(-50%) translateY(110%); }
.dock-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  padding: 8px 10px;
  border-radius: 8px;
  border: none;
  background: transparent;
  transition: background 0.15s;
  position: relative;
}
.dock-item:hover { background: rgba(0,240,255,0.08); }
.dock-icon { font-size: 18px; transition: color 0.15s; color: var(--text-dim); }
.dock-label {
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--text-dim);
  text-transform: uppercase;
  opacity: 0;
  transition: opacity 0.15s;
}
.dock-item:hover .dock-label { opacity: 1; }
.dock-item.active .dock-icon { color: var(--primary); filter: drop-shadow(0 0 6px var(--primary)); }
.dock-item.active::after {
  content: '';
  position: absolute;
  bottom: 3px;
  left: 50%;
  transform: translateX(-50%);
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: var(--glow-sm);
}

/* --- App root --- */
.jarvis-app { position: fixed; inset: 0; background: var(--bg); overflow: hidden; }
.scene-canvas { position: absolute; inset: 0; }

/* --- Mode panel (right sidebar) --- */
.mode-panel {
  position: fixed;
  right: 24px;
  top: 50%;
  transform: translateY(-50%);
  width: 260px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 78vh;
  overflow-y: auto;
  scrollbar-width: none;
  z-index: 100;
}
.mode-panel::-webkit-scrollbar { display: none; }

/* --- Core conversation panel --- */
.core-panel {
  position: fixed;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%);
  width: 480px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 100;
}
.core-reply { font-size: 13px; color: var(--primary); line-height: 1.6; min-height: 20px; }
.core-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* --- Top status bar --- */
.status-bar {
  position: fixed;
  top: 16px;
  left: 24px;
  display: flex;
  align-items: center;
  gap: 14px;
  pointer-events: none;
  z-index: 100;
}
.mode-label { font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-dim); }
.clock { font-size: 11px; color: rgba(0,240,255,0.45); letter-spacing: 0.08em; }

/* --- Plan2D redesign --- */
.plan2d-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  gap: 14px;
  padding: 20px;
  pointer-events: none;
  z-index: 50;
}
.plan2d-overlay > * { pointer-events: all; }
.plan2d-panel {
  width: 210px;
  flex-shrink: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.plan2d-canvas-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  overflow: hidden;
}
.plan2d-svg { width: 100%; height: 100%; display: block; }
.plan-grid-dot { fill: rgba(0,240,255,0.22); }
.plan-wall-line { stroke: #00f0ff; stroke-width: 2; filter: drop-shadow(0 0 4px rgba(0,240,255,0.6)); }
.plan-wall-line.low { stroke: rgba(0,240,255,0.45); stroke-dasharray: 4 4; }
.plan-wall-line.draft { stroke: rgba(0,240,255,0.4); stroke-dasharray: 4 4; }
.plan-hover-dot { fill: var(--accent); filter: drop-shadow(0 0 3px #0059ff); }
.plan-start-dot { fill: var(--primary); filter: drop-shadow(0 0 4px #00f0ff); }

/* --- Plan3D / Space overlay --- */
.plan3d-overlay, .space-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 50; }
.plan3d-overlay > *, .space-overlay > * { pointer-events: all; }
.plan3d-panel {
  position: absolute;
  left: 20px;
  top: 50%;
  transform: translateY(-50%);
  width: 240px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  max-height: 80vh;
  overflow-y: auto;
  scrollbar-width: none;
}
.plan3d-panel::-webkit-scrollbar { display: none; }
.plan3d-canvas-wrap { position: absolute; inset: 0; pointer-events: all; }

/* --- Immersive crosshair --- */
.immersive-crosshair {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 10;
  width: 24px;
  height: 24px;
}
.crosshair-h {
  position: absolute;
  top: 50%; left: 0;
  transform: translateY(-50%);
  width: 100%; height: 1px;
  background: var(--primary);
  box-shadow: var(--glow-sm);
}
.crosshair-v {
  position: absolute;
  top: 0; left: 50%;
  transform: translateX(-50%);
  width: 1px; height: 100%;
  background: var(--primary);
  box-shadow: var(--glow-sm);
}
.crosshair-dot {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 4px; height: 4px;
  border-radius: 50%;
  background: var(--primary);
  box-shadow: var(--glow-sm);
}

/* --- Action chip (Plan3D skill selector) --- */
.action-chip {
  background: transparent;
  border: 1px solid rgba(0,240,255,0.2);
  color: var(--text-dim);
  padding: 3px 9px;
  border-radius: 4px;
  font-family: var(--font);
  font-size: 10px;
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.action-chip:hover  { background: rgba(0,240,255,0.08); color: var(--text); }
.action-chip.active { background: rgba(0,240,255,0.15); color: var(--primary); border-color: var(--primary); }
```

- [ ] **Step 3: Replace index.css**

Replace the full content of `frontend/src/index.css`:
```css
@import './styles/design-system.css';
```

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/src/index.css frontend/src/styles/design-system.css
git commit -m "feat(design): design system — tokens, glass, buttons, dock, boot layers"
```

---

## Task 7: GlassPanel + HoloDock

**Files:**
- Create: `frontend/src/components/GlassPanel.tsx`
- Create: `frontend/src/components/HoloDock.tsx`

- [ ] **Step 1: Create GlassPanel.tsx**

Create `frontend/src/components/GlassPanel.tsx`:
```tsx
import type { ReactNode, CSSProperties } from 'react'

interface Props {
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function GlassPanel({ children, className = '', style }: Props) {
  return (
    <div className={`glass ${className}`} style={style}>
      {children}
    </div>
  )
}
```

- [ ] **Step 2: Create HoloDock.tsx**

Create `frontend/src/components/HoloDock.tsx`:
```tsx
import { useState, useEffect, useCallback } from 'react'
import { useJarvisStore } from '../state/jarvisStore'
import { modeMeta } from '../constants'
import type { Mode } from '../types'
import { GlassPanel } from './GlassPanel'

const DOCK_MODES: Mode[] = ['home', 'house', 'plan2d', 'plan3d', 'space', 'cloud', 'system']

const MODE_ICONS: Record<Mode, string> = {
  home:   '◎',
  house:  '⌂',
  plan2d: '▦',
  plan3d: '⬡',
  space:  '◈',
  cloud:  '☁',
  system: '⚙',
}

export function HoloDock() {
  const mode = useJarvisStore((s) => s.mode)
  const setMode = useJarvisStore((s) => s.setMode)
  const [visible, setVisible] = useState(false)

  const handleMouseMove = useCallback((e: MouseEvent) => {
    setVisible(e.clientY > window.innerHeight - 80)
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [handleMouseMove])

  const hidden = mode === 'space' || !visible

  return (
    <GlassPanel className={`holo-dock ${hidden ? 'hidden' : ''}`}>
      {DOCK_MODES.map((m) => (
        <button
          key={m}
          className={`dock-item ${m === mode ? 'active' : ''}`}
          onClick={() => setMode(m)}
          title={modeMeta[m].label}
        >
          <span className="dock-icon">{MODE_ICONS[m]}</span>
          <span className="dock-label">{modeMeta[m].label}</span>
        </button>
      ))}
    </GlassPanel>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/GlassPanel.tsx frontend/src/components/HoloDock.tsx
git commit -m "feat(ui): GlassPanel + HoloDock bottom navigation"
```

---

## Task 8: App.tsx Boot Orchestrator + AwakeApp.tsx Shell

**Files:**
- Create: `frontend/src/AwakeApp.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create AwakeApp.tsx**

Create `frontend/src/AwakeApp.tsx`:
```tsx
import { useEffect, useRef, useMemo, useState } from 'react'
import { useJarvisStore } from './state/jarvisStore'
import { useBootStore } from './state/bootStore'
import { Plan2DEditor, loadSavedPlans } from './modes/Plan2DEditor'
import { Plan3DViewer } from './modes/Plan3DViewer'
import { SpaceViewer } from './modes/SpaceViewer'
import { HoloDock } from './components/HoloDock'
import { GlassPanel } from './components/GlassPanel'
import { getApiBase } from './api/client'
import { useClapDetection } from './hooks/useClapDetection'
import { getWakeConfirmation } from './utils/wakeReply'
import { classifyIntent } from './utils/classifyIntent'
import { modeMeta } from './constants'
import type { SystemTelemetry } from './types'

const SYSTEM_TELEMETRY_ENABLED = false

export function AwakeApp() {
  const mode = useJarvisStore((s) => s.mode)
  const setMode = useJarvisStore((s) => s.setMode)
  const voiceEnabled = useJarvisStore((s) => s.voiceEnabled)
  const setVoiceEnabled = useJarvisStore((s) => s.setVoiceEnabled)
  const wakeListening = useJarvisStore((s) => s.wakeListening)
  const setWakeListening = useJarvisStore((s) => s.setWakeListening)
  const wakePhrase = useJarvisStore((s) => s.wakePhrase)
  const clapWakeEnabled = useJarvisStore((s) => s.clapWakeEnabled)
  const setClapWakeEnabled = useJarvisStore((s) => s.setClapWakeEnabled)
  const coreInput = useJarvisStore((s) => s.coreInput)
  const setCoreInput = useJarvisStore((s) => s.setCoreInput)
  const coreReply = useJarvisStore((s) => s.coreReply)
  const setCoreReply = useJarvisStore((s) => s.setCoreReply)
  const focusedEntity = useJarvisStore((s) => s.focusedEntity)
  const setBootState = useBootStore((s) => s.setBootState)

  const [housePlanKey, setHousePlanKey] = useState<string>('')
  const [listening, setListening] = useState(false)
  const [clapListening, setClapListening] = useState(false)
  const [systemTelemetry, setSystemTelemetry] = useState<SystemTelemetry | null>(null)
  const wakeRecognitionRef = useRef<any>(null)
  const housePlans = useMemo(() => loadSavedPlans(), [mode])

  const now = new Date()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  useEffect(() => {
    if (!SYSTEM_TELEMETRY_ENABLED) return
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false
    const pull = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/system/telemetry`)
        const data = await res.json() as SystemTelemetry
        if (!cancelled) setSystemTelemetry(data)
      } catch {}
    }
    if (mode === 'system') { pull(); timer = setInterval(pull, 2000) }
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [mode])

  const speak = (text: string) => {
    if (!voiceEnabled || !text || !('speechSynthesis' in window)) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'es-CO'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  }

  const sendCoreTurnMessage = async (messageRaw: string) => {
    const message = messageRaw.trim()
    if (!message) return
    try {
      const res = await fetch(`${getApiBase()}/api/jarvis/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'jarvis-core-main', message, context: { mode } }),
      })
      const data = await res.json() as { reply?: string }
      const reply = data?.reply ?? 'Sin respuesta por ahora.'
      setCoreReply(reply)
      speak(reply)
    } catch {
      const msg = 'No pude contactar el backend de Jarvis.'
      setCoreReply(msg)
      speak(msg)
    }
  }

  const startVoiceInput = () => {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!Ctor) { setCoreReply('Tu navegador no soporta reconocimiento de voz.'); return }
    const rec = new Ctor()
    rec.lang = 'es-CO'; rec.interimResults = false; rec.maxAlternatives = 1
    setListening(true)
    rec.onresult = (evt: any) => { setCoreInput(evt?.results?.[0]?.[0]?.transcript ?? ''); setListening(false) }
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)
    rec.start()
  }

  const stopWakeListener = () => {
    if (wakeRecognitionRef.current) {
      try { wakeRecognitionRef.current.onend = null; wakeRecognitionRef.current.stop() } catch {}
      wakeRecognitionRef.current = null
    }
    setWakeListening(false)
  }

  const captureOneShotSpeech = (): Promise<string> =>
    new Promise((resolve) => {
      const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (!Ctor) { resolve(''); return }
      const rec = new Ctor()
      rec.lang = 'es-CO'; rec.interimResults = false; rec.maxAlternatives = 1
      rec.onresult = (evt: any) => resolve(evt?.results?.[0]?.[0]?.transcript ?? '')
      rec.onerror = () => resolve('')
      rec.onend = () => resolve('')
      rec.start()
    })

  const handleWakeDetected = async () => {
    setClapListening(true)
    const transcript = await captureOneShotSpeech()
    setClapListening(false)
    if (!transcript.trim()) return
    const intent = classifyIntent(transcript)
    if (intent === 'ai_directed') {
      speak(getWakeConfirmation(focusedEntity?.label))
      sendCoreTurnMessage(transcript)
    } else if (intent === 'wake_call') {
      speak(getWakeConfirmation(focusedEntity?.label))
      startVoiceInput()
    }
  }

  useClapDetection({ enabled: clapWakeEnabled && voiceEnabled, onDoubleClap: handleWakeDetected })

  useEffect(() => {
    if (!voiceEnabled && wakeListening) stopWakeListener()
  }, [voiceEnabled, wakeListening])

  const isVoiceActive = listening || clapListening || wakeListening

  return (
    <div className="jarvis-app">
      {/* 3D scene canvas — wired in Tasks 9-10 */}
      <div className="scene-canvas" id="scene-canvas-root" />

      {mode === 'plan2d' && <Plan2DEditor />}
      {mode === 'plan3d' && <Plan3DViewer initialSelectedKey={housePlanKey} />}
      {mode === 'space'  && <SpaceViewer  initialSelectedKey={housePlanKey} />}

      <div className="status-bar">
        <span className="mode-label">{modeMeta[mode].label}</span>
        <span className="clock">{time}</span>
      </div>

      {mode === 'home' && (
        <GlassPanel className="core-panel">
          <div className="label">Hablar con Jarvis</div>
          {coreReply && <div className="core-reply">{coreReply}</div>}
          <input
            className="input"
            placeholder="Dime algo..."
            value={coreInput}
            onChange={(e) => setCoreInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendCoreTurnMessage(coreInput)}
          />
          <div className="core-actions">
            <button className={`btn ${listening ? 'active' : ''}`} onClick={startVoiceInput}>
              {listening ? '● Escuchando' : '● Voz'}
            </button>
            <button className="btn" onClick={() => sendCoreTurnMessage(coreInput)}>
              ▶ Enviar
            </button>
            <button
              className={`btn ${clapWakeEnabled ? 'active' : ''}`}
              onClick={() => setClapWakeEnabled(!clapWakeEnabled)}
            >
              {clapWakeEnabled ? '◉ Aplauso' : '◎ Aplauso'}
            </button>
            <button className="btn" onClick={() => setBootState('DORMANT')}>
              ◌ Dormir
            </button>
          </div>
          {clapListening && (
            <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              Escuchando tras aplauso...
            </div>
          )}
        </GlassPanel>
      )}

      {mode === 'house' && (
        <GlassPanel className="mode-panel">
          <div className="label">Habitaciones</div>
          {housePlans.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
              No hay habitaciones guardadas.
            </div>
          )}
          {housePlans.slice(0, 12).map((p) => {
            const key = `${p.room}::${p.name}`
            return (
              <button key={key} className="btn" onClick={() => { setHousePlanKey(key); setMode('space') }}>
                {p.room} · {p.name}
              </button>
            )
          })}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn" onClick={() => setMode('plan2d')}>2D</button>
            <button className="btn" onClick={() => setMode('plan3d')}>3D</button>
          </div>
        </GlassPanel>
      )}

      {mode === 'system' && SYSTEM_TELEMETRY_ENABLED && (
        <GlassPanel className="mode-panel">
          <div className="label">Sistema</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>CPU: {(systemTelemetry?.host?.cpu?.usagePct ?? 0).toFixed(1)}%</span>
            <span>GPU: {(systemTelemetry?.host?.gpu?.avgUtilizationPct ?? 0).toFixed(1)}%</span>
            <span>
              Red: {(systemTelemetry?.host?.network?.rxMbps ?? 0).toFixed(2)} /
              {' '}{(systemTelemetry?.host?.network?.txMbps ?? 0).toFixed(2)} Mbps
            </span>
          </div>
        </GlassPanel>
      )}

      <GlassPanel style={{
        position: 'fixed', top: 16, right: 24,
        padding: '8px 14px', display: 'flex', gap: 8, zIndex: 100,
      }}>
        <button
          className={`btn ${voiceEnabled ? 'active' : ''}`}
          onClick={() => setVoiceEnabled(!voiceEnabled)}
        >
          {voiceEnabled ? '◉ Voz' : '◎ Voz'}
        </button>
      </GlassPanel>

      <HoloDock />
    </div>
  )
}
```

- [ ] **Step 2: Rewrite App.tsx as boot orchestrator**

Replace `frontend/src/App.tsx` entirely:
```tsx
import { useState, useEffect } from 'react'
import { useBootStore } from './state/bootStore'
import { DormantLayer } from './components/DormantLayer'
import { ListeningLayer } from './components/ListeningLayer'
import { RadialTransition } from './components/RadialTransition'
import { AwakeApp } from './AwakeApp'
import './App.css'

export default function App() {
  const bootState = useBootStore((s) => s.bootState)
  const [transitionDone, setTransitionDone] = useState(false)
  const [awakeVisible, setAwakeVisible] = useState(false)

  useEffect(() => {
    if (bootState !== 'AWAKE') {
      setTransitionDone(false)
      setAwakeVisible(false)
    }
  }, [bootState])

  // AwakeApp fades in at 600ms, mid-way through the radial animation
  useEffect(() => {
    if (bootState !== 'AWAKE' || transitionDone) return
    const t = setTimeout(() => setAwakeVisible(true), 600)
    return () => clearTimeout(t)
  }, [bootState, transitionDone])

  return (
    <>
      <DormantLayer />
      {bootState === 'LISTENING' && <ListeningLayer />}
      {bootState === 'AWAKE' && !transitionDone && (
        <RadialTransition onComplete={() => setTransitionDone(true)} />
      )}
      {bootState === 'AWAKE' && (
        <div style={{
          opacity: awakeVisible ? 1 : 0,
          transition: 'opacity 0.2s ease',
          position: 'fixed',
          inset: 0,
        }}>
          <AwakeApp />
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 3: Run all tests**

```
cd frontend && npm test -- --run
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/AwakeApp.tsx
git commit -m "feat(boot): App.tsx boot orchestrator + AwakeApp.tsx full app shell"
```

---

## Task 9: CosmicBackground + AtomicNucleusScene

**Files:**
- Create: `frontend/src/components/CosmicBackground.tsx`
- Create: `frontend/src/scenes/AtomicNucleusScene.tsx`
- Modify: `frontend/src/AwakeApp.tsx`

- [ ] **Step 1: Create CosmicBackground.tsx**

Create `frontend/src/components/CosmicBackground.tsx`:
```tsx
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export function CosmicBackground() {
  const pointsRef = useRef<THREE.Points>(null)

  const positions = useMemo(() => {
    const count = 800
    const pos = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 20 + Math.random() * 10
      pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      pos[i * 3 + 2] = r * Math.cos(phi)
    }
    return pos
  }, [])

  useFrame((_, delta) => {
    if (pointsRef.current) pointsRef.current.rotation.y += 0.0002 * delta * 60
  })

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#00f0ff" size={0.015} transparent opacity={0.4} sizeAttenuation />
    </points>
  )
}
```

- [ ] **Step 2: Create AtomicNucleusScene.tsx**

Create `frontend/src/scenes/AtomicNucleusScene.tsx`:
```tsx
import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { CosmicBackground } from '../components/CosmicBackground'

interface RingProps {
  radius: number
  tiltX: number
  tiltZ: number
  speed: number
  voiceActive: boolean
}

function OrbitalRing({ radius, tiltX, tiltZ, speed, voiceActive }: RingProps) {
  const groupRef = useRef<THREE.Group>(null)
  const angles = useRef([0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2])

  useFrame((_, delta) => {
    const s = voiceActive ? speed * 3.5 : speed
    angles.current = angles.current.map((a) => a + s * delta)
    const g = groupRef.current
    if (!g) return
    // children[0] = torus; children 1-4 = particles
    for (let i = 1; i < g.children.length; i++) {
      const angle = angles.current[i - 1]
      if (angle !== undefined) {
        g.children[i].position.x = Math.cos(angle) * radius
        g.children[i].position.z = Math.sin(angle) * radius
      }
    }
  })

  return (
    <group ref={groupRef} rotation={[tiltX, 0, tiltZ]}>
      <mesh>
        <torusGeometry args={[radius, 0.008, 8, 120]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.55} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[radius, 0, 0]}>
          <sphereGeometry args={[0.04, 8, 8]} />
          <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={3} />
        </mesh>
      ))}
    </group>
  )
}

function Nucleus({ voiceActive }: { voiceActive: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame((_, delta) => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.MeshStandardMaterial
    const target = voiceActive ? 3.5 : 2
    mat.emissiveIntensity += (target - mat.emissiveIntensity) * delta * 3
  })

  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.4, 32, 32]} />
        <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={2} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.46, 16, 16]} />
        <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.15} />
      </mesh>
    </group>
  )
}

function Scene({ voiceActive }: { voiceActive: boolean }) {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      <Nucleus voiceActive={voiceActive} />
      <OrbitalRing radius={1.2} tiltX={0}           tiltZ={0}           speed={0.4} voiceActive={voiceActive} />
      <OrbitalRing radius={1.6} tiltX={Math.PI / 3} tiltZ={0}           speed={0.3} voiceActive={voiceActive} />
      <OrbitalRing radius={2.0} tiltX={Math.PI / 2} tiltZ={Math.PI / 4} speed={0.2} voiceActive={voiceActive} />
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.1}
        maxPolarAngle={Math.PI * 0.65} minPolarAngle={Math.PI * 0.35}
      />
    </>
  )
}

export function AtomicNucleusScene({ voiceActive = false }: { voiceActive?: boolean }) {
  return (
    <Canvas camera={{ position: [0, 0.5, 7], fov: 38 }} style={{ background: '#03080d' }}>
      <Scene voiceActive={voiceActive} />
    </Canvas>
  )
}
```

- [ ] **Step 3: Wire scene into AwakeApp — add import and replace scene div**

In `frontend/src/AwakeApp.tsx`:

Add import after the last existing import:
```tsx
import { AtomicNucleusScene } from './scenes/AtomicNucleusScene'
```

Replace `<div className="scene-canvas" id="scene-canvas-root" />` with:
```tsx
      <div className="scene-canvas">
        {mode === 'home' && <AtomicNucleusScene voiceActive={isVoiceActive} />}
      </div>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/CosmicBackground.tsx frontend/src/scenes/AtomicNucleusScene.tsx frontend/src/AwakeApp.tsx
git commit -m "feat(scene): CosmicBackground + AtomicNucleusScene — holographic nucleus"
```

---

## Task 10: HouseHoloScene + CloudHoloScene + SystemHoloScene

**Files:**
- Create: `frontend/src/scenes/HouseHoloScene.tsx`
- Create: `frontend/src/scenes/CloudHoloScene.tsx`
- Create: `frontend/src/scenes/SystemHoloScene.tsx`
- Modify: `frontend/src/AwakeApp.tsx`

- [ ] **Step 1: Create HouseHoloScene.tsx**

Create `frontend/src/scenes/HouseHoloScene.tsx`:
```tsx
import { Canvas } from '@react-three/fiber'
import { Float, OrbitControls } from '@react-three/drei'
import { CosmicBackground } from '../components/CosmicBackground'
import type { SavedPlan } from '../types'
import { CELL_METERS } from '../constants'

const SLOTS: [number, number, number][] = [
  [-2.5, 0, 0], [2.5, 0, 0], [0, 0, -2.5], [-2.5, 0, -2.5], [2.5, 0, -2.5],
]

function MiniaturePlan({ plan, position }: { plan: SavedPlan; position: [number, number, number] }) {
  const SCALE = 0.18  // 10m grid * 0.18 = 1.8 units
  return (
    <Float speed={0.7} floatIntensity={0.25} rotationIntensity={0.04}>
      <group position={position} scale={SCALE}>
        {plan.segments.map((seg, i) => {
          const x1 = seg.x1 * CELL_METERS
          const z1 = seg.y1 * CELL_METERS
          const x2 = seg.x2 * CELL_METERS
          const z2 = seg.y2 * CELL_METERS
          const len = Math.hypot(x2 - x1, z2 - z1)
          if (len < 0.001) return null
          const h = seg.wallType === 'low' ? 0.9 : 2.4
          return (
            <mesh
              key={i}
              position={[(x1 + x2) / 2, h * 0.5, (z1 + z2) / 2]}
              rotation={[0, -Math.atan2(z2 - z1, x2 - x1), 0]}
            >
              <boxGeometry args={[len, h, 0.1]} />
              <meshBasicMaterial color="#00f0ff" transparent opacity={0.55} wireframe />
            </mesh>
          )
        })}
      </group>
    </Float>
  )
}

function Scene({ plans }: { plans: SavedPlan[] }) {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      {plans.slice(0, 5).map((plan, i) => (
        <MiniaturePlan
          key={`${plan.room}-${plan.name}`}
          plan={plan}
          position={SLOTS[i] ?? [i * 2, 0, 0]}
        />
      ))}
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.08}
        maxPolarAngle={Math.PI * 0.6} minPolarAngle={Math.PI * 0.4}
      />
    </>
  )
}

export function HouseHoloScene({ plans }: { plans: SavedPlan[] }) {
  return (
    <Canvas camera={{ position: [0, 2, 9], fov: 45 }} style={{ background: '#03080d' }}>
      <Scene plans={plans} />
    </Canvas>
  )
}
```

- [ ] **Step 2: Create CloudHoloScene.tsx**

Create `frontend/src/scenes/CloudHoloScene.tsx`:
```tsx
import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Float, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { CosmicBackground } from '../components/CosmicBackground'

const SAT_POS: [number, number, number][] = [
  [-2, 1, -1], [2, 0.5, -0.5], [-1, -1, 1],
  [1.5, -0.8, 0.5], [-2.5, -0.4, -0.5], [0, 1.5, -2],
]

function NetworkNode({ position, central }: { position: [number, number, number]; central?: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null)
  useFrame(() => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.MeshStandardMaterial
    mat.emissiveIntensity = (central ? 2 : 0.8) + Math.sin(Date.now() * 0.002 + position[0]) * 0.4
  })
  return (
    <Float speed={0.6} floatIntensity={0.2} rotationIntensity={0}>
      <mesh ref={meshRef} position={position}>
        <sphereGeometry args={central ? [0.3, 16, 16] : [0.12, 12, 12]} />
        <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={central ? 2 : 0.8} />
      </mesh>
    </Float>
  )
}

function ConnectionLines() {
  const origin = new THREE.Vector3(0, 0, 0)
  return (
    <>
      {SAT_POS.map((pos, i) => {
        const geo = new THREE.BufferGeometry().setFromPoints([origin, new THREE.Vector3(...pos)])
        return (
          <line key={i} geometry={geo}>
            <lineBasicMaterial color="#00f0ff" transparent opacity={0.25} />
          </line>
        )
      })}
    </>
  )
}

function Scene() {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      <NetworkNode position={[0, 0, 0]} central />
      {SAT_POS.map((pos, i) => <NetworkNode key={i} position={pos} />)}
      <ConnectionLines />
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.12}
        maxPolarAngle={Math.PI * 0.65} minPolarAngle={Math.PI * 0.35}
      />
    </>
  )
}

export function CloudHoloScene() {
  return (
    <Canvas camera={{ position: [0, 0.5, 7], fov: 45 }} style={{ background: '#03080d' }}>
      <Scene />
    </Canvas>
  )
}
```

- [ ] **Step 3: Create SystemHoloScene.tsx**

Create `frontend/src/scenes/SystemHoloScene.tsx`:
```tsx
import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { CosmicBackground } from '../components/CosmicBackground'
import type { SystemTelemetry } from '../types'

function SystemRings({ telemetry }: { telemetry?: SystemTelemetry }) {
  const ringA = useRef<THREE.Mesh>(null)
  const ringB = useRef<THREE.Mesh>(null)
  const ringC = useRef<THREE.Mesh>(null)

  const cpu = telemetry?.host?.cpu?.usagePct ?? 20
  const gpu = telemetry?.host?.gpu?.avgUtilizationPct ?? 15
  const net = Math.min(100, (telemetry?.host?.network?.rxMbps ?? 0) * 3)

  useFrame((_, delta) => {
    if (ringA.current) ringA.current.rotation.z += (0.005 + cpu / 1200) * delta * 60
    if (ringB.current) ringB.current.rotation.x += (0.003 + gpu / 1200) * delta * 60
    if (ringC.current) {
      ringC.current.rotation.y += (0.002 + net / 1200) * delta * 60
      ringC.current.rotation.z += (0.001 + net / 2400) * delta * 60
    }
  })

  return (
    <group>
      <mesh>
        <sphereGeometry args={[0.5, 24, 24]} />
        <meshStandardMaterial color="#001a1f" emissive="#00f0ff" emissiveIntensity={1.5} />
      </mesh>
      <mesh ref={ringA} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.1, 0.012, 8, 100]} />
        <meshBasicMaterial color="#00f0ff" />
      </mesh>
      <mesh ref={ringB} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[1.6, 0.01, 8, 100]} />
        <meshBasicMaterial color="#0059ff" transparent opacity={0.8} />
      </mesh>
      <mesh ref={ringC} rotation={[Math.PI / 3, 0, Math.PI / 6]}>
        <torusGeometry args={[2.2, 0.008, 8, 100]} />
        <meshBasicMaterial color="#00f0ff" transparent opacity={0.45} />
      </mesh>
    </group>
  )
}

function Scene({ telemetry }: { telemetry?: SystemTelemetry }) {
  return (
    <>
      <color attach="background" args={['#03080d']} />
      <ambientLight color="#00f0ff" intensity={0.15} />
      <pointLight position={[4, 4, 4]} color="#0059ff" intensity={0.5} />
      <CosmicBackground />
      <SystemRings telemetry={telemetry} />
      <OrbitControls
        enableZoom={false} enablePan={false}
        autoRotate autoRotateSpeed={0.1}
        maxPolarAngle={Math.PI * 0.65} minPolarAngle={Math.PI * 0.35}
      />
    </>
  )
}

export function SystemHoloScene({ telemetry }: { telemetry?: SystemTelemetry }) {
  return (
    <Canvas camera={{ position: [0, 0.3, 7.5], fov: 38 }} style={{ background: '#03080d' }}>
      <Scene telemetry={telemetry} />
    </Canvas>
  )
}
```

- [ ] **Step 4: Wire all 3 scenes into AwakeApp**

In `frontend/src/AwakeApp.tsx`, add these imports after the AtomicNucleusScene import:
```tsx
import { HouseHoloScene }  from './scenes/HouseHoloScene'
import { CloudHoloScene }  from './scenes/CloudHoloScene'
import { SystemHoloScene } from './scenes/SystemHoloScene'
```

Replace the scene canvas block (with `mode === 'home'` only) with:
```tsx
      <div className="scene-canvas">
        {mode === 'home'   && <AtomicNucleusScene voiceActive={isVoiceActive} />}
        {mode === 'house'  && <HouseHoloScene plans={housePlans} />}
        {mode === 'cloud'  && <CloudHoloScene />}
        {mode === 'system' && <SystemHoloScene telemetry={systemTelemetry ?? undefined} />}
      </div>
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/scenes/ frontend/src/AwakeApp.tsx
git commit -m "feat(scenes): HouseHoloScene, CloudHoloScene, SystemHoloScene"
```

---

## Task 11: Plan2DEditor Visual Redesign

**Files:**
- Modify: `frontend/src/modes/Plan2DEditor.tsx`

- [ ] **Step 1: Replace the JSX return block (lines 108-162)**

Replace everything from `return (` to the final `)` with:
```tsx
  return (
    <div className="plan2d-overlay">
      <div className="glass plan2d-panel">
        <div className="label">Editor 2D</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Líneas: {segments.length}</span>
          <span>Área: {(GRID_CELLS * CELL_METERS).toFixed(0)}m × {(GRID_CELLS * CELL_METERS).toFixed(0)}m</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button className={`btn ${planTool === 'draw'   ? 'active' : ''}`} onClick={() => setPlanTool('draw')}>Dibujar</button>
          <button className={`btn ${planTool === 'erase'  ? 'active' : ''}`} onClick={() => setPlanTool('erase')}>Borrar</button>
          <button className={`btn ${wallType  === 'solid' ? 'active' : ''}`} onClick={() => setWallType('solid')}>Sólido</button>
          <button className={`btn ${wallType  === 'low'   ? 'active' : ''}`} onClick={() => setWallType('low')}>Bajo</button>
          <button className="btn" onClick={() => setSegments((prev) => prev.slice(0, -1))}>↩</button>
          <button className="btn" onClick={() => setSegments([])}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="input" placeholder="Habitación" value={room} onChange={(e) => setRoom(e.target.value)} />
          <input className="input" placeholder="Nombre del plano" value={planName} onChange={(e) => setPlanName(e.target.value)} />
          <button
            className="btn"
            onClick={saveByRoomName}
            disabled={!room.trim() || !planName.trim() || segments.length === 0}
          >
            Guardar
          </button>
        </div>
        {savedPlans.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="label">Guardados</div>
            {savedPlans.slice(0, 5).map((p) => (
              <button key={`${p.room}-${p.name}`} className="btn" onClick={() => loadPlan(p)}>
                {p.room} · {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="glass plan2d-canvas-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
          className="plan2d-svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        >
          {Array.from({ length: GRID_CELLS + 1 }).flatMap((_, i) =>
            Array.from({ length: GRID_CELLS + 1 }).map((__, j) => (
              <circle
                key={`${i}-${j}`}
                cx={i * STEP}
                cy={j * STEP}
                r={i % 2 === 0 && j % 2 === 0 ? 1.8 : 1}
                className="plan-grid-dot"
              />
            ))
          )}
          {segments.map((s, idx) => (
            <line
              key={idx}
              x1={s.x1 * STEP} y1={s.y1 * STEP}
              x2={s.x2 * STEP} y2={s.y2 * STEP}
              className={`plan-wall-line${s.wallType === 'low' ? ' low' : ''}`}
            />
          ))}
          {draft && (
            <line
              x1={draft.x1 * STEP} y1={draft.y1 * STEP}
              x2={draft.x2 * STEP} y2={draft.y2 * STEP}
              className={`plan-wall-line draft${draft.wallType === 'low' ? ' low' : ''}`}
            />
          )}
          {hoverCell && (
            <circle cx={hoverCell.cx * STEP} cy={hoverCell.cy * STEP} r={5} className="plan-hover-dot" />
          )}
          {draft && (
            <circle cx={draft.x1 * STEP} cy={draft.y1 * STEP} r={6} className="plan-start-dot" />
          )}
        </svg>
      </div>
    </div>
  )
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/modes/Plan2DEditor.tsx
git commit -m "feat(plan2d): dot grid, glass panel, glow walls"
```

---

## Task 12: Plan3DViewer Visual Redesign

**Files:**
- Modify: `frontend/src/modes/Plan3DViewer.tsx`

- [ ] **Step 1: Replace CSS class names throughout the file**

Make these exact string replacements in `frontend/src/modes/Plan3DViewer.tsx`:
- `"plan3d-panel hologram-panel"` → `"glass plan3d-panel"`
- `"plan3d-canvas-wrap hologram-panel"` → `"plan3d-canvas-wrap"`
- All `className="catalog-button"` → `className="btn"`
- All `className="save-input"` → change `<input>` elements to `className="input"` and `<select>` elements to `className="select"`
- All `className="panel-title"` → `className="label"`
- Wrap `.design-tool-group` divs: remove the className, add `style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}`
- Remove `.design-edit-panel` className divs but keep their children (or add `style={{ display: 'flex', flexDirection: 'column', gap: 8 }}`)
- Remove `.status-copy` className, keep inner `<p>` tags as plain text elements

- [ ] **Step 2: Update Canvas background and lighting (around line 313)**

Replace the Canvas opening and its initial children:
```tsx
        <Canvas camera={{ position: [5, 6, 8], fov: 50 }}>
          <color attach="background" args={['#03080d']} />
          <ambientLight color="#00f0ff" intensity={0.2} />
          <pointLight position={[5, 7, 5]} intensity={0.8} color="#0059ff" />
          <gridHelper args={[12, 48, '#00f0ff22', '#00f0ff44']} position={[0, 0, 0]} />
```

- [ ] **Step 3: Update wall mesh (around lines 330-335)**

Replace the single `<mesh>` wall render with a `<group>` containing solid + wireframe overlay:
```tsx
            return (
              <group key={idx} position={[cx, h * 0.5, cz]} rotation={[0, -angle, 0]}>
                <mesh>
                  <boxGeometry args={[length, h, 0.1]} />
                  <meshStandardMaterial color="#001a2a" emissive="#003040" emissiveIntensity={0.5} transparent opacity={0.88} />
                </mesh>
                <mesh>
                  <boxGeometry args={[length, h, 0.1]} />
                  <meshBasicMaterial color="#00f0ff" wireframe transparent opacity={0.18} />
                </mesh>
              </group>
            )
```

- [ ] **Step 4: Update viewpoint indicator colors (around lines 344-350)**

Replace the viewpoint cylinder and cone materials to use cyan instead of yellow:
```tsx
              <meshStandardMaterial color="#00f0ff" emissive="#00f0ff" emissiveIntensity={0.5} />
```
(apply this to both the cylinder and cone mesh materials)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/modes/Plan3DViewer.tsx
git commit -m "feat(plan3d): cyan materials, glass sidebar, holographic grid"
```

---

## Task 13: SpaceViewer Visual Redesign

**Files:**
- Modify: `frontend/src/modes/SpaceViewer.tsx`

- [ ] **Step 1: Replace the center dot with the crosshair**

Find `className="immersive-center-dot"` and replace the entire element with:
```tsx
        <div className="immersive-crosshair">
          <div className="crosshair-h" />
          <div className="crosshair-v" />
          <div className="crosshair-dot" />
        </div>
```

- [ ] **Step 2: Add glass class to popup container**

Find the inner wrapper `<div>` inside the `<Html>` popup element (the one with inline `background` / `border` styles). Add `className="glass"` and remove the conflicting inline `background`, `border`, `borderRadius` style properties (keep `padding`, `minWidth`, `fontSize`).

- [ ] **Step 3: Replace remaining legacy class names**

In `frontend/src/modes/SpaceViewer.tsx`:
- `catalog-button` → `btn`
- `hologram-panel` → `glass`
- `panel-title` → `label`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/modes/SpaceViewer.tsx
git commit -m "feat(space): crosshair, glass popup, holographic immersive"
```

---

## Task 14: Remove HoloScene + Legacy CSS Cleanup

**Files:**
- Delete: `frontend/src/HoloScene.tsx`
- Modify: `frontend/src/App.css`

- [ ] **Step 1: Delete HoloScene.tsx**

```bash
rm frontend/src/HoloScene.tsx
```

- [ ] **Step 2: Confirm no remaining HoloScene imports**

Search for any remaining import of `HoloScene` in the codebase:
```bash
cd frontend && grep -r "HoloScene" src/
```
Expected: no results. If found, remove those imports/usages.

- [ ] **Step 3: Clean App.css**

Read `frontend/src/App.css`. Remove rule blocks for all of these selectors (replaced by design-system.css):
`.scene`, `.scene-canvas`, `.grid-overlay`, `.orb`, `.hologram-panel`, `.mode-panel` (old), `.topbar`, `.mode-button`, `.catalog-button`, `.save-input`, `.panel-title`, `.status-copy`, `.design-edit-panel`, `.design-tool-group`, `.scene-center-marker`, `.clock-wrap`, `.eyebrow`, `.sub`.

Keep any rules for Plan2D/Plan3D/Space specifics not already in design-system.css.

- [ ] **Step 4: Run full test suite**

```
cd frontend && npm test -- --run
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove HoloScene, clean legacy CSS"
```

---

## Task 15: Smoke Test + Build Verification

- [ ] **Step 1: Start backend**

```bash
cd backend && npm run dev
```
Expected: `Jarvis backend running on http://127.0.0.1:8788`

- [ ] **Step 2: Start frontend dev server**

```bash
cd frontend && npm run dev
```
Open `http://localhost:5173`. Expected: page loads, dark background, no visible UI (DORMANT state).

- [ ] **Step 3: Test boot cycle via console**

In the browser console, manually trigger state transitions:
```js
// Trigger LISTENING state
window.__bootTest = () => {
  const s = window.__zustand_bootStore
  if (s) s.getState().setBootState('LISTENING')
}
```

Alternatively, temporarily add to the bottom of `App.tsx` (before `</>`) a dev debug button that cycles through states — then remove it before the final commit:
```tsx
      {/* DEV ONLY — remove before shipping */}
      <button
        style={{ position:'fixed', bottom:8, right:8, zIndex:99999, opacity:0.4,
                 background:'transparent', color:'#00f0ff', border:'1px solid #00f0ff44',
                 padding:'4px 10px', fontSize:10, cursor:'pointer', borderRadius:4 }}
        onClick={() => {
          const store = useBootStore.getState()
          const next = bootState === 'DORMANT' ? 'LISTENING'
                     : bootState === 'LISTENING' ? 'AWAKE' : 'DORMANT'
          store.setBootState(next)
        }}
      >
        {bootState}
      </button>
```
Import `useBootStore` in App.tsx if not already present.

- [ ] **Step 4: Verify DORMANT → LISTENING**

Click debug button once. Expected: pulsing dot at center-bottom, `· · ·` label, rest of screen transparent.

- [ ] **Step 5: Verify LISTENING → AWAKE**

Click debug button again. Expected: radial expansion from center-bottom, app fades in, dock visible on hover.

- [ ] **Step 6: Verify all 7 modes**

Hover bottom → dock slides up. Test each mode:
- Core (◎): nucleus with 3 orbital rings, particle field, conversation panel
- Casa (⌂): holographic miniature plans, room list panel
- Plano (▦): dot grid SVG editor, glass panel
- 3D (⬡): 3D walls with cyan wireframe overlay, glass sidebar
- Espacio (◈): first-person view, crosshair, dock hidden
- Cloud (☁): network constellation, auto-rotating
- System (⚙): 3 orbital rings, auto-rotating

- [ ] **Step 7: Verify Plan2D persistence**

Draw a wall, set room + name, save. Switch to Casa. Expected: the plan appears in the room list.

- [ ] **Step 8: Verify AWAKE → DORMANT**

In Core mode, click "◌ Dormir". Expected: app hides, dot disappears.

- [ ] **Step 9: TypeScript build**

```bash
cd frontend && npm run build
```
Expected: no TypeScript errors, build succeeds to `frontend/dist/`.

- [ ] **Step 10: Remove dev debug button and final commit**

Remove the temporary debug button from App.tsx. Run tests one last time.

```bash
cd frontend && npm test -- --run
git add -A
git commit -m "feat: Jarvis UI/UX holographic redesign complete"
```
