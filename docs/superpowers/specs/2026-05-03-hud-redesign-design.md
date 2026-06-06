# Spec: HUD Holográfico + Sub-universo de CASA

**Fecha:** 2026-05-03
**Stack:** React 19 + TypeScript + R3F (Three.js) + CSS
**Rama:** master (continúa sobre feat/holo-universe mergeado)

---

## Objetivo

Reemplazar todos los botones y paneles actuales por una interfaz HUD holográfica elegante.
Consolidar los 7 hologramas en 4, moviendo Plan2D / Plan3D / Space al sub-universo de CASA.
Al hacer zoom en CASA el universo se transforma: los 3 sub-hologramas emergen desde el centro con efecto de ensamblaje y spring physics.

---

## Cambios de arquitectura

### Universo principal: 4 hologramas

| Modo | Holograma | Posición |
|------|-----------|----------|
| HOME | Neural Web | `[0, 1.5, -10]` |
| HOUSE | Blueprint Casa | `[-4, -0.5, -7]` |
| CLOUD | Data Spiral Galaxy | `[4, -0.5, -7]` |
| SYSTEM | Circuit Core | `[0, 3, -8]` |

Los hologramas PLAN2D, PLAN3D, SPACE se eliminan del universo principal.

### Sub-universo de CASA

Activado cuando `zoomedMode === 'house'`. Flujo completo:

```
1. Click HOUSE hologram
2. Cámara vuela hacia HOUSE (lerp existente)
3. HOUSE hologram: opacity 1 → 0 en 400ms
4. HouseSubUniverse monta — 3 sub-hologramas
5. Cada sub-holograma nace en [0, 0, -7] (origen de HOUSE)
6. Spring hacia posición final con delay escalonado:
   - PLAN2D  → [-4.5, 0.5, -8]   delay 0ms
   - PLAN3D  → [ 4.5, 0.5, -8]   delay 120ms
   - SPACE   → [ 0,  -1.8, -7]   delay 240ms
7. Ensamblaje: 20 partículas por holograma vuelan desde origen → posición final → absorción
8. Click sub-holograma → modo normal (Plan2DEditor / Plan3DViewer / SpaceViewer)
9. Escape / Back → desmonta HouseSubUniverse, HOUSE reaparece con fade-in
```

### Estado en `jarvisStore` — sin cambios

No se añade estado nuevo. `houseExpanded` se deriva directamente como `zoomedMode === 'house'` donde se necesite. Esto evita estado redundante.

### Navegación Back dentro del sub-universo

El comportamiento del botón Back y Escape depende del contexto:

| `zoomedMode` | Origen | Back/Escape navega a |
|---|---|---|
| `'house'` | universo principal | `setZoomedMode(null)` → universo principal |
| `'plan2d'` `'plan3d'` `'space'` viniendo de CASA | sub-universo | `setZoomedMode('house')` → sub-universo |
| `'home'` `'cloud'` `'system'` | universo principal | `setZoomedMode(null)` → universo principal |

Para distinguir el origen, `AwakeApp` trackea un `previousMode: Mode | null` ref que se actualiza cada vez que `zoomedMode` cambia. Si `previousMode === 'house'` y el modo actual es `plan2d/plan3d/space`, Back vuelve a `'house'`.

---

## Componentes nuevos

### `HudPanel` (`frontend/src/components/HudPanel.tsx`)

Reemplaza `GlassPanel` en todos los paneles de modo.

**Visual:**
- Sin `border-radius` — esquinas rectas
- Borde trazado con SVG `stroke-dashoffset`: 4 líneas (top, right, bottom, left) que se dibujan en secuencia en 350ms total
- Fondo: `rgba(0, 240, 255, 0.03)`, `backdrop-filter: blur(8px)`
- Header con `◈` + nombre de modo en mayúsculas + separador 1px
- El contenido interno aparece tras el borde (delay 300ms) con `opacity` fade-in

**Props:**
```ts
interface HudPanelProps {
  mode: string          // label del modo para el header
  children: ReactNode
  className?: string
  style?: CSSProperties
}
```

**Animación de entrada (CSS):**
```
@keyframes hud-border-draw {
  from { stroke-dashoffset: 1000 }
  to   { stroke-dashoffset: 0 }
}
@keyframes hud-content-reveal {
  from { opacity: 0; transform: translateY(4px) }
  to   { opacity: 1; transform: translateY(0) }
}
```

---

### `HudBtn` (`frontend/src/components/HudBtn.tsx`)

Reemplaza todas las instancias de `<button className="btn">`.

**Visual:**
```
◆  ENVIAR MENSAJE          →
◆  ACTIVAR VOZ             →
◇  DORMIR SISTEMA
```

- `◆` relleno = activo o hover | `◇` vacío = inactivo/default
- Al hover: scan line de izq → der bajo el texto en 200ms (`@keyframes hud-scan`)
- Flecha `→` aparece al hover con `opacity: 0 → 1`
- Sin fondo, sin borde, sin `border-radius`
- `font-size: 11px`, `letter-spacing: 0.16em`, `text-transform: uppercase`
- Color base: `rgba(200, 244, 255, 0.55)` | hover/active: `#00f0ff` con `text-shadow: 0 0 8px`

**Props:**
```ts
interface HudBtnProps {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  className?: string
}
```

**Animación hover (CSS):**
```
@keyframes hud-scan {
  from { left: 0; width: 0; opacity: 0.6 }
  to   { left: 0; width: 100%; opacity: 0 }
}
```

---

### `HudInput` (`frontend/src/components/HudInput.tsx`)

Reemplaza `<input className="input">`.

**Visual:**
```
  Dime algo_                 ← placeholder + cursor parpadeante
─────────────────────────    ← línea inferior siempre visible (opacity 0.2)
▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░   ← sweep luminoso al focus/typing
```

- Sin borde lateral ni superior — solo línea inferior
- Al focus: sweep luminoso de izq → der que se repite mientras `value.length > 0`
- Cursor parpadeante CSS simulado con `::after` cuando está enfocado y vacío
- `font-size: 13px`, `letter-spacing: 0.04em`, color `var(--text)`

**Props:**
```ts
interface HudInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  placeholder?: string
}
```

---

### `HouseSubUniverse` (componente interno de `WorldScene.tsx`)

Componente R3F que renderiza los 3 sub-hologramas dentro del Canvas existente.

**Visibilidad:** montado solo cuando `zoomedMode === 'house'`.

**Sub-hologramas reutilizados:** `Plan2DGeo`, `Plan3DGeo`, `SpaceGeo` ya existentes en `WorldScene.tsx`, envueltos en `HologramNode` con posiciones del sub-universo.

**AssemblyParticles (sub-componente interno):**
- 20 puntos `Points` por holograma
- Posición inicial: `[0, 0, -7]` + jitter aleatorio `±0.3`
- En `useFrame`: cada partícula lerpa hacia la posición del holograma destino
- Al llegar (distancia < 0.1) se vuelve invisible (`opacity → 0`)
- Se limpia automáticamente a los 1200ms

**Spring manual (sin dependencia nueva):**
- `useRef` para posición actual y velocidad
- En `useFrame`: `vel += (target - pos) * stiffness * delta; pos += vel * delta; vel *= damping`
- `stiffness = 120`, `damping = 0.88` (factor por frame, no por segundo)

---

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `frontend/src/scenes/WorldScene.tsx` | Reducir a 4 hologramas, reposicionar, añadir `HouseSubUniverse`, derivar `zoomedMode === 'house'` |
| `frontend/src/AwakeApp.tsx` | Reemplazar `GlassPanel`+`btn`+`input` con `HudPanel`+`HudBtn`+`HudInput`; añadir `previousMode` ref para Back navigation |
| `frontend/src/state/jarvisStore.ts` | Sin cambios de estado |
| `frontend/src/styles/design-system.css` | Añadir tokens y keyframes HUD; conservar estilos Plan2D/3D/Space |
| `frontend/src/components/HudPanel.tsx` | Nuevo |
| `frontend/src/components/HudBtn.tsx` | Nuevo |
| `frontend/src/components/HudInput.tsx` | Nuevo |

`GlassPanel.tsx` se conserva (puede seguir en uso en Plan2D/3D si aplica).

---

## Tokens CSS nuevos

```css
--hud-line-h:    36px;           /* altura de cada HudBtn */
--hud-scan-dur:  200ms;          /* duración del scan en botones */
--hud-border-dur: 350ms;         /* duración del stroke-draw del panel */
--hud-reveal-delay: 280ms;       /* delay para revelar contenido del panel */
--hud-indicator: rgba(0,240,255,0.35);  /* color ◇ inactivo */
--hud-indicator-on: #00f0ff;     /* color ◆ activo */
```

---

## Posiciones finales de los 4 hologramas

```
            SYSTEM (0, 3, -8)

  HOUSE (-4, -0.5, -7)   CLOUD (4, -0.5, -7)

            HOME (0, 1.5, -10)
```

Cámara overview en `[0, 0, 0]` mirando `[0, 0.5, -1]`.

---

## Verificación

1. `tsc --noEmit` — sin errores TypeScript
2. `npm test -- --run` — 16 tests frontend + 9 backend pasan
3. `npm run build` — build limpio
4. Manual en Electron:
   - Universo arranca con 4 hologramas
   - Click HOME → HudPanel con borde animado, HudBtns visibles
   - Click HOUSE → cámara vuela, HOUSE fade-out, 3 sub-hologramas emergen con assembly
   - Click sub-holograma → modo canvas normal
   - Escape → sub-universo desmontado, HOUSE reaparece
   - Botones: hover muestra scan + flecha, active muestra `◆` iluminado
   - Input: focus lanza sweep en línea inferior
