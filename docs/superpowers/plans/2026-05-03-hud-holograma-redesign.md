# HUD Holográfico + Sub-universo CASA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar todos los botones/paneles con HUD holográfico elegante y consolidar 7 hologramas en 4, con Plan2D/Plan3D/Space como sub-universo de CASA con spring physics + assembly particles.

**Architecture:** 4 hologramas principales en WorldScene. Al hacer zoom en HOUSE, el hologram se oculta y HouseSubUniverse monta 3 sub-hologramas con spring desde el origen. Los paneles de modo usan HudPanel (borde SVG animado) + HudBtn (◆ scan line) + HudInput (sweep inferior).

**Tech Stack:** React 19, TypeScript, R3F (@react-three/fiber 9), @react-three/drei, Three.js 0.183, CSS animations, Zustand 5

---

## Mapa de archivos

| Acción | Archivo | Responsabilidad |
|--------|---------|-----------------|
| CREATE | `frontend/src/components/HudBtn.tsx` | Botón holográfico ◆/◇ + scan |
| CREATE | `frontend/src/components/HudInput.tsx` | Input con sweep inferior |
| CREATE | `frontend/src/components/HudPanel.tsx` | Panel con borde animado |
| MODIFY | `frontend/src/styles/design-system.css` | Tokens HUD + keyframes |
| MODIFY | `frontend/src/scenes/WorldScene.tsx` | 4 hologramas + HouseSubUniverse |
| MODIFY | `frontend/src/AwakeApp.tsx` | Nuevos componentes HUD + nav previousMode |

---

## Task 1: CSS — Tokens HUD + keyframes + estilos base

**Files:**
- Modify: `frontend/src/styles/design-system.css`

- [ ] **Step 1: Añadir tokens HUD a `:root` y reemplazar `.btn` con `.hud-btn`**

Localiza el bloque `/* --- Buttons --- */` y reemplázalo con el bloque expandido. También añade los tokens al `:root` y los nuevos keyframes + estilos de componentes al final del archivo.

En `:root` (después de `--r-sm: 6px;`), añade:
```css
  --hud-line-h:      36px;
  --hud-scan-dur:    200ms;
  --hud-border-dur:  350ms;
  --hud-reveal-delay: 280ms;
  --hud-indicator:   rgba(0,240,255,0.35);
  --hud-indicator-on: #00f0ff;
```

Reemplaza el bloque `/* --- Buttons --- */` completo (las 3 reglas `.btn`) con:
```css
/* --- HudBtn — línea de dato holográfica --- */
.hud-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 0;
  background: none;
  border: none;
  font-family: var(--font);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(200,244,255,0.55);
  cursor: pointer;
  position: relative;
  text-align: left;
  min-height: var(--hud-line-h);
  transition: color 0.15s;
}
.hud-btn::after {
  content: '';
  position: absolute;
  bottom: 5px; left: 0;
  height: 1px; width: 0;
  background: linear-gradient(90deg, rgba(0,240,255,0.6), transparent);
}
.hud-btn:hover                   { color: #00f0ff; }
.hud-btn:hover .hud-btn-ind      { color: var(--hud-indicator-on); text-shadow: 0 0 8px #00f0ff; }
.hud-btn:hover .hud-btn-arrow    { opacity: 1; transform: translateX(0); }
.hud-btn:hover::after            { animation: hud-scan var(--hud-scan-dur) ease-out forwards; }
.hud-btn.active                  { color: #00f0ff; }
.hud-btn.active .hud-btn-ind     { color: var(--hud-indicator-on); text-shadow: 0 0 8px #00f0ff; }
.hud-btn:disabled                { opacity: 0.3; cursor: default; pointer-events: none; }
.hud-btn-ind   { color: var(--hud-indicator); font-size: 8px; flex-shrink: 0; transition: color 0.15s, text-shadow 0.15s; }
.hud-btn-label { flex: 1; }
.hud-btn-arrow { opacity: 0; transform: translateX(-4px); transition: opacity 0.15s, transform 0.15s; font-size: 10px; }
```

Añade al final del archivo:
```css
/* --- HudPanel — borde animado --- */
.hud-panel {
  position: relative;
  background: rgba(0,240,255,0.03);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  padding: 18px 20px 16px;
}
.hud-border-top, .hud-border-right, .hud-border-bottom, .hud-border-left {
  position: absolute;
  background: rgba(0,240,255,0.45);
  transform-origin: left;
}
.hud-border-top    { top: 0;    left: 0; width: 100%; height: 1px; transform-origin: left;   animation: hud-border-h var(--hud-border-dur) steps(1,end) forwards; animation-duration: 88ms; }
.hud-border-right  { top: 0;   right: 0; width: 1px; height: 100%; transform-origin: top;    animation: hud-border-v 88ms ease forwards 88ms; }
.hud-border-bottom { bottom: 0; right: 0; width: 100%; height: 1px; transform-origin: right; animation: hud-border-h 88ms ease forwards 176ms; }
.hud-border-left   { bottom: 0; left: 0; width: 1px; height: 100%; transform-origin: bottom; animation: hud-border-v 88ms ease forwards 264ms; }
@keyframes hud-border-h { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes hud-border-v { from { transform: scaleY(0); } to { transform: scaleY(1); } }
.hud-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 9px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: rgba(0,240,255,0.55);
  margin-bottom: 10px;
  animation: hud-content-reveal 0.2s ease forwards;
  animation-delay: var(--hud-reveal-delay);
  opacity: 0;
}
.hud-panel-sep {
  height: 1px;
  background: rgba(0,240,255,0.1);
  margin-bottom: 12px;
  animation: hud-content-reveal 0.2s ease forwards;
  animation-delay: var(--hud-reveal-delay);
  opacity: 0;
}
.hud-panel-content {
  display: flex;
  flex-direction: column;
  gap: 0;
  animation: hud-content-reveal 0.2s ease forwards;
  animation-delay: var(--hud-reveal-delay);
  opacity: 0;
}

/* --- HudInput --- */
.hud-input-wrap   { position: relative; width: 100%; overflow: hidden; }
.hud-input {
  width: 100%;
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  letter-spacing: 0.04em;
  padding: 6px 0 8px;
}
.hud-input::placeholder { color: var(--text-dim); }
.hud-input-line   { position: absolute; bottom: 0; left: 0; width: 100%; height: 1px; background: rgba(0,240,255,0.2); }
.hud-input-sweep  {
  position: absolute;
  bottom: 0; left: -50px;
  height: 2px; width: 50px;
  background: linear-gradient(90deg, transparent, rgba(0,240,255,0.9), transparent);
  animation: hud-input-sweep 0.65s ease-out forwards;
}
.hud-input-wrap--focused .hud-input-line { background: rgba(0,240,255,0.35); }

/* --- Status bar (top-right when zoomed) --- */
.status-bar {
  position: fixed;
  top: 16px;
  right: 24px;
  left: auto;
  display: flex;
  align-items: center;
  gap: 14px;
  pointer-events: none;
  z-index: 100;
}

/* --- Keyframes HUD --- */
@keyframes hud-scan {
  from { width: 0;    opacity: 0.7; }
  to   { width: 100%; opacity: 0;   }
}
@keyframes hud-content-reveal {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0);   }
}
@keyframes hud-input-sweep {
  from { left: -50px; opacity: 1; }
  to   { left: 110%;  opacity: 0; }
}
```

- [ ] **Step 2: Verificar que el CSS es válido**

```bash
cd frontend && npx tsc --noEmit
```

No debe haber errores de TypeScript (el CSS no afecta TSC pero confirma que el entorno funciona).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/design-system.css
git commit -m "feat(hud): tokens, keyframes y estilos base HudBtn/HudPanel/HudInput"
```

---

## Task 2: Componente HudBtn

**Files:**
- Create: `frontend/src/components/HudBtn.tsx`

- [ ] **Step 1: Crear el archivo**

```tsx
// frontend/src/components/HudBtn.tsx
import type { ReactNode, CSSProperties } from 'react'

interface HudBtnProps {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
}

export function HudBtn({ children, onClick, active = false, disabled = false, className = '', style }: HudBtnProps) {
  return (
    <button
      className={`hud-btn${active ? ' active' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      <span className="hud-btn-ind">{active ? '◆' : '◇'}</span>
      <span className="hud-btn-label">{children}</span>
      <span className="hud-btn-arrow">→</span>
    </button>
  )
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
cd frontend && npx tsc --noEmit
```
Resultado esperado: sin errores.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/HudBtn.tsx
git commit -m "feat(hud): componente HudBtn con ◆ scan line y flecha"
```

---

## Task 3: Componente HudInput

**Files:**
- Create: `frontend/src/components/HudInput.tsx`

- [ ] **Step 1: Crear el archivo**

```tsx
// frontend/src/components/HudInput.tsx
import { useState } from 'react'

interface HudInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  placeholder?: string
}

export function HudInput({ value, onChange, onSubmit, placeholder = '' }: HudInputProps) {
  const [focused, setFocused] = useState(false)
  const [sweepKey, setSweepKey] = useState(0)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
    setSweepKey(k => k + 1)
  }

  return (
    <div className={`hud-input-wrap${focused ? ' hud-input-wrap--focused' : ''}`}>
      <input
        className="hud-input"
        value={value}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={e => e.key === 'Enter' && onSubmit?.()}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="hud-input-line" />
      {(focused || value.length > 0) && (
        <div key={sweepKey} className="hud-input-sweep" />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/HudInput.tsx
git commit -m "feat(hud): componente HudInput con sweep luminoso"
```

---

## Task 4: Componente HudPanel

**Files:**
- Create: `frontend/src/components/HudPanel.tsx`

- [ ] **Step 1: Crear el archivo**

```tsx
// frontend/src/components/HudPanel.tsx
import type { ReactNode, CSSProperties } from 'react'

interface HudPanelProps {
  mode: string
  children: ReactNode
  className?: string
  style?: CSSProperties
}

export function HudPanel({ mode, children, className = '', style }: HudPanelProps) {
  return (
    <div className={`hud-panel${className ? ` ${className}` : ''}`} style={style}>
      <div className="hud-border-top" />
      <div className="hud-border-right" />
      <div className="hud-border-bottom" />
      <div className="hud-border-left" />
      {mode && (
        <>
          <div className="hud-panel-header">
            <span>◈</span>
            <span>{mode.toUpperCase()}</span>
          </div>
          <div className="hud-panel-sep" />
        </>
      )}
      <div className="hud-panel-content">
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verificar TypeScript**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/HudPanel.tsx
git commit -m "feat(hud): componente HudPanel con borde stroke-draw animado"
```

---

## Task 5: WorldScene — 4 hologramas + HouseSubUniverse

**Files:**
- Modify: `frontend/src/scenes/WorldScene.tsx`

- [ ] **Step 1: Actualizar HP (posiciones) y añadir constantes del sub-universo**

Reemplaza el bloque `HP` y `OVERVIEW_LOOK` al inicio del archivo:

```ts
const HP: Record<Mode, THREE.Vector3> = {
  home:   new THREE.Vector3( 0,   1.5, -10),
  house:  new THREE.Vector3(-4,  -0.5,  -7),
  cloud:  new THREE.Vector3( 4,  -0.5,  -7),
  system: new THREE.Vector3( 0,   3,    -8),
  // plan2d/plan3d/space no se renderizan en el universo principal;
  // sus posiciones se usan solo como fallback del CameraController
  plan2d: new THREE.Vector3(-4.5, 0.5,  -8),
  plan3d: new THREE.Vector3( 4.5, 0.5,  -8),
  space:  new THREE.Vector3( 0,  -1.8,  -7),
}
const OVERVIEW_LOOK = new THREE.Vector3(0, 0.5, -5)

// Sub-universe: los 3 hologramas emergen desde el origen de HOUSE
const SUB_ORIGIN  = new THREE.Vector3(-4, -0.5, -7)
const SUB_TARGETS: Record<'plan2d'|'plan3d'|'space', THREE.Vector3> = {
  plan2d: new THREE.Vector3(-4.5,  0.5, -8),
  plan3d: new THREE.Vector3( 4.5,  0.5, -8),
  space:  new THREE.Vector3( 0,   -1.8, -7),
}
const SUB_DELAYS: Record<'plan2d'|'plan3d'|'space', number> = {
  plan2d: 0, plan3d: 120, space: 240,
}
```

- [ ] **Step 2: Añadir SubHologramNode antes de HouseGeo**

Inserta este componente justo antes de la función `HouseGeo`:

```tsx
/* ─────────────────────────────────────────────────────────────
   Sub-hologram node — igual que HologramNode pero sin posición HP
   Usado dentro del sub-universo de CASA
───────────────────────────────────────────────────────────── */
function SubHologramNode({ mode, children }: NodeProps) {
  const zoomedMode    = useJarvisStore(s => s.zoomedMode)
  const setZoomedMode = useJarvisStore(s => s.setZoomedMode)
  const [hovered, setHovered] = useState(false)
  const groupRef = useRef<THREE.Group>(null)

  useFrame((_, delta) => {
    if (!groupRef.current) return
    const k = 1 - Math.pow(0.005, delta)
    const target = zoomedMode === mode ? 1.2 : hovered ? 1.09 : 1.0
    const s = groupRef.current.scale
    s.setScalar(THREE.MathUtils.lerp(s.x, target, k * 6))
  })

  return (
    <group
      ref={groupRef}
      onClick={e => { e.stopPropagation(); setZoomedMode(mode) }}
      onPointerOver={e => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
      onPointerOut={e => { e.stopPropagation(); setHovered(false); document.body.style.cursor = 'auto' }}
    >
      <Float speed={0.9} floatIntensity={0.28} rotationIntensity={0.04}>
        {children}
      </Float>
      <Html center distanceFactor={10} zIndexRange={[0, 0]}
        style={{ pointerEvents: 'none', opacity: hovered ? 1 : 0, transition: 'opacity 0.18s' }}>
        <span className="hologram-label">{modeMeta[mode].label}</span>
      </Html>
    </group>
  )
}
```

- [ ] **Step 3: Añadir AssemblyParticles y SpringNode antes de SceneContent**

Inserta justo antes de `function SceneContent()`:

```tsx
/* ─────────────────────────────────────────────────────────────
   Assembly particles — burst desde SUB_ORIGIN hacia target
───────────────────────────────────────────────────────────── */
function AssemblyParticles({ target }: { target: THREE.Vector3 }) {
  const ref = useRef<THREE.Points>(null)
  const [dead, setDead] = useState(false)

  const positions = useMemo(() => {
    const arr = new Float32Array(20 * 3)
    for (let i = 0; i < 20; i++) {
      arr[i * 3]     = SUB_ORIGIN.x + (Math.random() - 0.5) * 0.8
      arr[i * 3 + 1] = SUB_ORIGIN.y + (Math.random() - 0.5) * 0.8
      arr[i * 3 + 2] = SUB_ORIGIN.z + (Math.random() - 0.5) * 0.8
    }
    return arr
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDead(true), 1200)
    return () => clearTimeout(t)
  }, [])

  useFrame((_, delta) => {
    if (!ref.current || dead) return
    const pos = ref.current.geometry.attributes.position.array as Float32Array
    for (let i = 0; i < 20; i++) {
      pos[i * 3]     += (target.x - pos[i * 3])     * delta * 3.5
      pos[i * 3 + 1] += (target.y - pos[i * 3 + 1]) * delta * 3.5
      pos[i * 3 + 2] += (target.z - pos[i * 3 + 2]) * delta * 3.5
    }
    ref.current.geometry.attributes.position.needsUpdate = true
  })

  if (dead) return null

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#00f0ff" size={0.07} transparent opacity={0.75} sizeAttenuation />
    </points>
  )
}

/* ─────────────────────────────────────────────────────────────
   SpringNode — anima posición desde SUB_ORIGIN hasta target
   con spring physics manual (sin dependencias extra)
───────────────────────────────────────────────────────────── */
function SpringNode({ mode, children }: { mode: 'plan2d'|'plan3d'|'space'; children: React.ReactNode }) {
  const groupRef = useRef<THREE.Group>(null)
  const posRef   = useRef(SUB_ORIGIN.clone())
  const velRef   = useRef(new THREE.Vector3())
  const started  = useRef(false)
  const delay    = SUB_DELAYS[mode]

  useEffect(() => {
    posRef.current.copy(SUB_ORIGIN)
    velRef.current.set(0, 0, 0)
    started.current = false
    const t = setTimeout(() => { started.current = true }, delay)
    return () => { clearTimeout(t); started.current = false }
  }, [delay])

  useFrame((_, delta) => {
    if (!started.current || !groupRef.current) return
    const target = SUB_TARGETS[mode]
    const diff   = target.clone().sub(posRef.current)
    velRef.current.addScaledVector(diff, 120 * delta)
    velRef.current.multiplyScalar(Math.pow(0.88, delta * 60))
    posRef.current.addScaledVector(velRef.current, delta)
    groupRef.current.position.copy(posRef.current)
  })

  return (
    <group ref={groupRef} position={[SUB_ORIGIN.x, SUB_ORIGIN.y, SUB_ORIGIN.z]}>
      {children}
    </group>
  )
}

/* ─────────────────────────────────────────────────────────────
   HouseSubUniverse — Plan2D, Plan3D, Space con assembly
───────────────────────────────────────────────────────────── */
function HouseSubUniverse() {
  const zoomedMode = useJarvisStore(s => s.zoomedMode)
  const modes = ['plan2d', 'plan3d', 'space'] as const
  const geos: Record<typeof modes[number], React.ReactNode> = {
    plan2d: <Plan2DGeo active={zoomedMode === 'plan2d'} />,
    plan3d: <Plan3DGeo active={zoomedMode === 'plan3d'} />,
    space:  <SpaceGeo  active={zoomedMode === 'space'}  />,
  }

  return (
    <>
      {modes.map(mode => (
        <group key={mode}>
          <AssemblyParticles target={SUB_TARGETS[mode]} />
          <SpringNode mode={mode}>
            <SubHologramNode mode={mode}>
              {geos[mode]}
            </SubHologramNode>
          </SpringNode>
        </group>
      ))}
    </>
  )
}
```

- [ ] **Step 4: Actualizar SceneContent para usar 4 hologramas + HouseSubUniverse**

Reemplaza la función `SceneContent` completa:

```tsx
function SceneContent() {
  const zoomedMode = useJarvisStore(s => s.zoomedMode)
  const houseExpanded = zoomedMode === 'house'

  const MAIN_MODES = ['home', 'house', 'cloud', 'system'] as const
  const geoMap: Record<typeof MAIN_MODES[number], React.ReactNode> = {
    home:   <CoreGeo   active={zoomedMode === 'home'}   />,
    house:  <HouseGeo  active={zoomedMode === 'house' && !houseExpanded} />,
    cloud:  <CloudGeo  active={zoomedMode === 'cloud'}  />,
    system: <SystemGeo active={zoomedMode === 'system'} />,
  }

  return (
    <>
      <CameraController />
      <CosmicBackground />
      <ambientLight color="#00f0ff" intensity={0.12} />
      <pointLight position={[0, 8, -4]} color="#0059ff" intensity={1.2} />
      <pointLight position={[0, -5, -8]} color="#00f0ff" intensity={0.4} />

      {MAIN_MODES.map(mode => (
        // Oculta HOUSE cuando sub-universo está activo
        <group key={mode} visible={!(mode === 'house' && houseExpanded)}>
          <HologramNode mode={mode}>
            {geoMap[mode]}
          </HologramNode>
        </group>
      ))}

      {houseExpanded && <HouseSubUniverse />}
    </>
  )
}
```

- [ ] **Step 5: Verificar TypeScript**

```bash
cd frontend && npx tsc --noEmit
```
Resultado esperado: 0 errores.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/scenes/WorldScene.tsx
git commit -m "feat(world): 4 hologramas + HouseSubUniverse con spring y assembly"
```

---

## Task 6: AwakeApp — HudPanel + HudBtn + HudInput + previousMode nav

**Files:**
- Modify: `frontend/src/AwakeApp.tsx`

- [ ] **Step 1: Actualizar imports**

Reemplaza el bloque de imports al inicio de `AwakeApp.tsx`:

```tsx
import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useJarvisStore } from './state/jarvisStore'
import { useBootStore } from './state/bootStore'
import { Plan2DEditor, loadSavedPlans } from './modes/Plan2DEditor'
import { Plan3DViewer } from './modes/Plan3DViewer'
import { SpaceViewer } from './modes/SpaceViewer'
import { HudPanel } from './components/HudPanel'
import { HudBtn } from './components/HudBtn'
import { HudInput } from './components/HudInput'
import { GlassPanel } from './components/GlassPanel'
import { WorldScene } from './scenes/WorldScene'
import { getApiBase } from './api/client'
import { useClapDetection } from './hooks/useClapDetection'
import { getWakeConfirmation } from './utils/wakeReply'
import { classifyIntent } from './utils/classifyIntent'
import { modeMeta } from './constants'
import type { SystemTelemetry } from './types'
import type { Mode } from './types'
```

- [ ] **Step 2: Añadir `previousModeRef` y `handleBack` dentro de `AwakeApp`**

Justo después de la declaración de `const wakeRecognitionRef`, añade:

```tsx
  const prevZoomedModeRef = useRef<Mode | null>(null)

  // Captura el modo anterior antes de que cambie (para Back navigation)
  useEffect(() => {
    const prev = zoomedMode
    return () => { prevZoomedModeRef.current = prev }
  }, [zoomedMode])

  const handleBack = useCallback(() => {
    const fromHouse = prevZoomedModeRef.current === 'house'
    if (zoomedMode && CANVAS_MODES.has(zoomedMode) && fromHouse) {
      setZoomedMode('house')
    } else {
      setZoomedMode(null)
    }
  }, [zoomedMode, setZoomedMode])
```

- [ ] **Step 3: Actualizar el handler de Escape para usar handleBack**

Reemplaza el `useEffect` del Escape key:

```tsx
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && zoomedMode) handleBack() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [zoomedMode, handleBack])
```

- [ ] **Step 4: Actualizar el botón Back para usar handleBack**

Reemplaza:
```tsx
      {zoomedMode && (
        <button className="world-back-btn" onClick={() => setZoomedMode(null)}>
          ← Volver
        </button>
      )}
```
Con:
```tsx
      {zoomedMode && (
        <button className="world-back-btn" onClick={handleBack}>
          ← Volver
        </button>
      )}
```

- [ ] **Step 5: Reemplazar Core panel (HOME) con HudPanel + HudBtn + HudInput**

Reemplaza el bloque `{/* Core panel (home mode) */}` completo:

```tsx
      {/* Core panel (home mode) */}
      {isPanelMode && zoomedMode === 'home' && (
        <HudPanel mode="Core" className="core-panel">
          {coreReply && <div className="core-reply">{coreReply}</div>}
          <HudInput
            value={coreInput}
            onChange={setCoreInput}
            onSubmit={() => sendCoreTurn(coreInput)}
            placeholder="Dime algo…"
          />
          <div style={{ height: 8 }} />
          <HudBtn active={listening} onClick={startVoiceInput}>
            {listening ? 'Escuchando' : 'Activar voz'}
          </HudBtn>
          <HudBtn onClick={() => sendCoreTurn(coreInput)}>Enviar mensaje</HudBtn>
          <HudBtn active={clapWakeEnabled} onClick={() => setClapWakeEnabled(!clapWakeEnabled)}>
            {clapWakeEnabled ? 'Aplauso activo' : 'Activar aplauso'}
          </HudBtn>
          <HudBtn onClick={() => setBootState('DORMANT')}>Dormir sistema</HudBtn>
          {clapListening && <div className="voice-hint" style={{ marginTop: 8 }}>Escuchando tras aplauso…</div>}
        </HudPanel>
      )}
```

- [ ] **Step 6: Reemplazar House panel con HudPanel + HudBtn**

Reemplaza el bloque `{/* House panel */}` completo:

```tsx
      {/* House panel — solo aparece cuando mode=house pero aún no expandido */}
      {isPanelMode && zoomedMode === 'house' && (
        <HudPanel mode="Casa" className="mode-panel">
          {housePlans.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: '4px 0' }}>Sin habitaciones guardadas.</div>
          )}
          {housePlans.slice(0, 8).map(p => {
            const key = `${p.room}::${p.name}`
            return (
              <HudBtn key={key} onClick={() => { setHousePlanKey(key); setZoomedMode('space') }}>
                {p.room} · {p.name}
              </HudBtn>
            )
          })}
          <HudBtn onClick={() => setZoomedMode('plan2d')}>Editar plano 2D</HudBtn>
          <HudBtn onClick={() => setZoomedMode('plan3d')}>Ver en 3D</HudBtn>
        </HudPanel>
      )}
```

- [ ] **Step 7: Reemplazar Cloud panel**

Reemplaza el bloque `{/* Cloud panel */}` completo:

```tsx
      {/* Cloud panel */}
      {isPanelMode && zoomedMode === 'cloud' && (
        <HudPanel mode="Cloud" className="mode-panel">
          <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: '4px 0', letterSpacing: '0.06em' }}>
            Próximamente.
          </div>
        </HudPanel>
      )}
```

- [ ] **Step 8: Reemplazar System panel**

Reemplaza el bloque `{/* System panel */}` completo:

```tsx
      {/* System panel */}
      {isPanelMode && zoomedMode === 'system' && (
        <HudPanel mode="System" className="mode-panel">
          {SYSTEM_TELEMETRY_ENABLED ? (
            <>
              <div className="hud-stat">CPU · {(systemTelemetry?.host?.cpu?.usagePct ?? 0).toFixed(1)}%</div>
              <div className="hud-stat">GPU · {(systemTelemetry?.host?.gpu?.avgUtilizationPct ?? 0).toFixed(1)}%</div>
              <div className="hud-stat">
                Red · ↓{(systemTelemetry?.host?.network?.rxMbps ?? 0).toFixed(2)} ↑{(systemTelemetry?.host?.network?.txMbps ?? 0).toFixed(2)} Mbps
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--text-dim)', fontSize: 11, padding: '4px 0' }}>Telemetría desactivada.</div>
          )}
        </HudPanel>
      )}
```

- [ ] **Step 9: Reemplazar Voice toggle**

Reemplaza el bloque `{/* Voice toggle */}` completo:

```tsx
      {/* Voice toggle — floating top-right */}
      <GlassPanel style={{ position: 'fixed', top: 16, right: 24, padding: '6px 14px', zIndex: 100 }}>
        <HudBtn active={voiceEnabled} onClick={() => setVoiceEnabled(!voiceEnabled)}>
          Voz
        </HudBtn>
      </GlassPanel>
```

- [ ] **Step 10: Añadir `.hud-stat` al design-system.css**

Abre `frontend/src/styles/design-system.css` y añade al final:

```css
/* --- Stat line (System panel) --- */
.hud-stat {
  font-size: 11px;
  color: rgba(200,244,255,0.6);
  letter-spacing: 0.08em;
  padding: 5px 0;
  border-bottom: 1px solid rgba(0,240,255,0.06);
}
.hud-stat:last-child { border-bottom: none; }
```

- [ ] **Step 11: Verificar TypeScript**

```bash
cd frontend && npx tsc --noEmit
```
Resultado esperado: 0 errores.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/AwakeApp.tsx frontend/src/styles/design-system.css
git commit -m "feat(hud): AwakeApp usa HudPanel+HudBtn+HudInput, nav previousMode"
```

---

## Task 7: Tests + Build + Verificación

**Files:** ninguno nuevo

- [ ] **Step 1: Ejecutar tests frontend**

```bash
cd frontend && npm test -- --run
```
Resultado esperado:
```
Test Files  4 passed (4)
Tests       16 passed (16)
```

- [ ] **Step 2: Ejecutar tests backend**

```bash
cd backend && npm test -- --run
```
Resultado esperado:
```
Test Files  2 passed (2)
Tests       9 passed (9)
```

- [ ] **Step 3: Build de producción**

```bash
cd frontend && npm run build
```
Resultado esperado: `✓ built in <N>ms` sin errores TypeScript.

- [ ] **Step 4: Verificar manualmente en dev server**

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

Checklist manual en `http://localhost:5173`:
- [ ] Universo muestra exactamente 4 hologramas (HOME, HOUSE, CLOUD, SYSTEM)
- [ ] Click HOME → HudPanel aparece con borde que se dibuja secuencialmente en ~350ms
- [ ] HudBtns muestran `◇` en reposo, `◆` + scan + `→` en hover
- [ ] Input de HOME muestra sweep luminoso en la línea inferior al escribir
- [ ] Click HOUSE → holograma HOUSE desaparece, 3 sub-hologramas emergen desde centro con spring
- [ ] Sub-hologramas tienen delay escalonado (plan2d primero, space último)
- [ ] Assembly particles visibles durante el ensamblaje (~1.2s)
- [ ] Click sub-holograma → modo canvas carga normalmente
- [ ] Escape desde plan2d/plan3d/space (viniendo de house) → vuelve a sub-universo
- [ ] Escape desde sub-universo (house) → vuelve a universo principal
- [ ] Voice toggle top-right usa HudBtn

- [ ] **Step 5: Rebuild exe**

```bash
cd ..  # raíz de jarvis-desktop
npm run dist
```
Resultado esperado: `dist-electron/Jarvis Setup 1.0.0.exe` con timestamp de hoy.

- [ ] **Step 6: Commit final**

```bash
git add -A
git commit -m "feat: HUD holografico + sub-universo CASA completo"
```

---

## Notas de implementación

**HOUSE visible=false vs fade:** El hologram de HOUSE se oculta instantáneamente con `visible={!(mode === 'house' && houseExpanded)}`. Las partículas de ensamblaje cubren la transición visualmente. Un fade suave requeriría modificar opacity de cada Material individual — dejado para iteración futura.

**Sprint physics:** `stiffness=120, damping=0.88` (factor por frame × delta×60 normalizado). Si el spring oscila demasiado, reducir stiffness a 80. Si es muy lento, aumentar a 160.

**SubHologramNode vs HologramNode:** `SubHologramNode` no usa `HP[mode]` para su posición — esa la controla el `SpringNode` padre. No tiene la restricción `if (!zoomedMode)` en el click porque se clickea cuando `zoomedMode === 'house'`.

**previousMode navigation:** El `useEffect` de cleanup captura el valor de `zoomedMode` ANTES del cambio, almacenándolo en `prevZoomedModeRef`. Al presionar Back desde plan2d/plan3d/space, si `prevZoomedModeRef.current === 'house'`, vuelve al sub-universo en lugar de al universo principal.
