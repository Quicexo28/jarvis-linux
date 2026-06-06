# Jarvis Desktop — Rediseño Total UI/UX

**Fecha:** 2026-05-02  
**Autor:** Santiago Quiceno  
**Estado:** Aprobado para implementación

---

## Contexto

El frontend actual de Jarvis es funcional pero visualmente inconsistente: mezcla paneles HTML planos con escenas Three.js sin un sistema de diseño unificado. El objetivo es un rediseño total — estética holográfica atómica coherente en todos los modos, máquina de estados de arranque en 3 fases, y UI limpia y profesional. Todo en Three.js para los fondos 3D + HTML/CSS glass para los controles.

---

## 1. Arquitectura Electron — Ventana Única Transparente

### Configuración de BrowserWindow

```js
new BrowserWindow({
  fullscreen: true,
  transparent: true,
  frame: false,
  skipTaskbar: true,          // cambia a false en estado AWAKE
  alwaysOnTop: false,
  backgroundColor: '#00000000',
  hasShadow: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(__dirname, 'preload.js'),
  },
})
```

La ventana siempre existe, solo cambia su comportamiento:
- **DORMANT:** `opacity=0`, `setIgnoreMouseEvents(true, { forward: true })`, `skipTaskbar=true`
- **LISTENING:** `opacity=1` (solo el dot es visible), sigue `setIgnoreMouseEvents(true, { forward: true })`, `skipTaskbar=true`
- **AWAKE:** `setIgnoreMouseEvents(false)`, `skipTaskbar=false`

### IPC channels — `preload.js`

```js
contextBridge.exposeInMainWorld('electronBridge', {
  platform: process.platform,
  // Boot state
  onBootState: (cb) => ipcRenderer.on('boot:state', (_, s) => cb(s)),
  setBootState: (state) => ipcRenderer.invoke('boot:setState', state),
  // Window control
  hideWindow:  () => ipcRenderer.invoke('window:hide'),
  showWindow:  () => ipcRenderer.invoke('window:show'),
})
```

### `main.js` — ipcMain handlers

```
boot:setState('LISTENING') → setIgnoreMouseEvents(true, {forward:true}), skipTaskbar(true)
boot:setState('AWAKE')     → setIgnoreMouseEvents(false), skipTaskbar(false), win.focus()
boot:setState('DORMANT')   → setIgnoreMouseEvents(true, {forward:true}), skipTaskbar(true)
```

---

## 2. Máquina de Estados — `state/bootStore.ts`

```ts
type BootState = 'DORMANT' | 'LISTENING' | 'AWAKE'

interface BootStore {
  bootState: BootState
  setBootState: (s: BootState) => void
}
```

### Flujo de estados

```
DORMANT ──[doble clap]──▶ LISTENING ──[wake word | jarvis directo]──▶ AWAKE
   ▲                           ▲                                         │
   │                           └──────[timeout 30s sin wake]─────────────┘
   └──────────────────[cmd voz "Jarvis, duerme" | timeout 5min]──────────┘
```

**Triggers:**
- `DORMANT → LISTENING`: `useClapDetection` dispara callback → `setBootState('LISTENING')`
- `LISTENING → AWAKE`: `classifyIntent` → `'wake_call'` → `setBootState('AWAKE')`
- `AWAKE → DORMANT`: comando "duerme/descansa" o timeout 5 min sin interacción
- `LISTENING → DORMANT`: timeout 30s sin wake word

### Capas React en `App.tsx`

```tsx
// App.tsx root
<>
  <DormantLayer />           {/* solo audio, siempre montado */}
  {bootState !== 'DORMANT' && <ListeningLayer />}
  {bootState === 'AWAKE' && <AwakeLayer />}
</>
```

---

## 3. Animaciones de Transición

### `<ListeningLayer />` — Estado LISTENING

Componente React puro (sin Three.js):

**Dot:**
- Posición: `position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%)`
- Núcleo: `width: 12px; height: 12px; border-radius: 50%; background: #00f0ff`
- `box-shadow: 0 0 16px #00f0ff, 0 0 32px #00f0ff44`
- Ring 1: `border: 1px solid #00f0ff; opacity: 0.6; width: 28px; height: 28px`
  - `animation: ping 1.2s ease-in-out infinite`
- Ring 2: mismo, `animation-delay: 0.6s`
- 4 micro-partículas en órbita con `@keyframes orbit`

**Texto:** `"· · ·"` bajo el dot, `font-size: 11px; color: #00f0ff88; letter-spacing: 6px`

### `<RadialTransition />` — LISTENING → AWAKE (800ms)

Canvas `position: fixed; inset: 0; z-index: 9999; pointer-events: none`

```
Origen: (window.innerWidth / 2, window.innerHeight - 24)  ← posición exacta del dot
Radio final: Math.sqrt(width² + height²)                   ← diagonal completa

Timeline:
  0–100ms   dot escala x1 → x3, glow máximo
  100–600ms requestAnimationFrame dibuja arco creciente
            fill: radialGradient(origen, #00f0ff → #0059ff → #03080d)
            leading edge: stroke #00f0ff, lineWidth 2, shadowBlur 20
  600ms     <AwakeLayer /> comienza opacity: 0 → 1 (200ms)
  700ms     canvas fade out (100ms)
  800ms     canvas unmount, estado AWAKE completo
```

### Transición inversa AWAKE → DORMANT

Misma animación en reversa (contracción), 600ms, luego dot pulsa 3 veces y desaparece.

---

## 4. Sistema de Diseño

### Paleta

| Token | Valor | Uso |
|-------|-------|-----|
| `--bg` | `#03080d` | Fondo principal |
| `--primary` | `#00f0ff` | Cyan neón — acentos, bordes, glow |
| `--accent` | `#0059ff` | Azul eléctrico — secundario |
| `--glass-bg` | `rgba(0,240,255,0.04)` | Fondo glass panels |
| `--glass-border` | `rgba(0,240,255,0.15)` | Bordes glass |
| `--glow-sm` | `0 0 12px #00f0ff66` | Glow pequeño |
| `--glow-md` | `0 0 24px #00f0ff44` | Glow medio |
| `--text` | `#c8f4ff` | Texto principal |
| `--text-dim` | `rgba(200,244,255,0.45)` | Texto secundario |

### Tipografía

- Fuente: `Space Grotesk` (import de Google Fonts)
- Títulos: 14px, `letter-spacing: 0.12em`, `text-transform: uppercase`
- Cuerpo: 13px, `letter-spacing: 0.04em`
- Micro: 11px, `letter-spacing: 0.06em`

### Glass Panel (componente reutilizable `<GlassPanel>`)

```css
.glass-panel {
  background: var(--glass-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  box-shadow:
    0 0 30px rgba(0,240,255,0.06) inset,
    0 4px 24px rgba(0,0,0,0.4);
}
```

### Botones

```css
.btn-holo {
  background: transparent;
  border: 1px solid rgba(0,240,255,0.35);
  color: #00f0ff;
  padding: 6px 16px;
  border-radius: 6px;
  font-family: 'Space Grotesk';
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-holo:hover {
  background: rgba(0,240,255,0.1);
  box-shadow: var(--glow-sm);
}
```

### Dock de Navegación (`<HoloDock>`)

- `position: fixed; bottom: 0; left: 50%; transform: translateX(-50%)`
- Glass panel horizontal, `padding: 10px 24px`
- 7 ítems: icono SVG + label bajo (visible solo al hover del ítem)
- Modo activo: dot cyan 4px bajo el icono
- El dock se oculta (`translateY(100%)`) cuando el modo es `space` (inmersivo)
- Aparece al mover mouse al borde inferior (`mousemove` detector)

---

## 5. Modos — Escenas 3D y Layouts

> **Principio unificador:** Todos los modos comparten el mismo "universo visual". Fondo negro-espacial (`#03080d`), partículas de polvo con `Points`, iluminación ambient cyan tenue + point light azul. El contenido 3D específico del modo es la variación temática.

### Fondo base (todos los modos) — `<CosmicBackground />`

```
- PointsMaterial: color #00f0ff, size 0.015, transparent, opacity 0.4
- 800 puntos distribuidos aleatoriamente en esfera r=30
- Rotación muy lenta: 0.0002 rad/frame en Y
- Ambient light: #00f0ff, intensity 0.15
- Point light: #0059ff, intensity 0.5, position [4,4,4]
```

### Modo Core — `<AtomicNucleusScene />`

**Núcleo central:**
- `SphereGeometry(0.4, 32, 32)` con `MeshStandardMaterial({ emissive: '#00f0ff', emissiveIntensity: 2, color: '#001a1f' })`
- Corona: segunda esfera `0.45r`, `MeshBasicMaterial({ wireframe: true, color: '#00f0ff', opacity: 0.2 })`

**Anillos orbitales (3):**
- `TorusGeometry(1.2, 0.008, 8, 120)`
- Rotaciones iniciales: `[0°,0°,0°]`, `[60°,0°,0°]`, `[90°,60°,0°]`
- Velocidad base: `rotY += 0.004/frame`. Durante `voiceActive`: `rotY += 0.015/frame`
- Color: `#00f0ff` opacity 0.6

**Partículas en órbita (4 por anillo = 12 total):**
- `SphereGeometry(0.035)`, `emissive: '#00f0ff'`, `emissiveIntensity: 3`
- Posición calculada como punto en la circunferencia del torus según `angle += speed/frame`

**Panel de conversación:**
- Glass panel centrado, `width: 480px`, `bottom: 80px` (sobre el dock)
- Input de texto con `placeholder: "Dime algo..."`, borde cyan al focus
- Transcripción voz en tiempo real (texto gris encima del input)
- Respuesta Jarvis: `typewriter` efecto, `color: #00f0ff`
- Botones inline: `[● Voz]` `[▶ Enviar]`

### Modo Casa — `<HouseScene />`

**Escena 3D:**
- Los planes guardados se renderizan como estructuras holográficas miniatura flotando en el espacio (posiciones aleatorias estables con `useMemo`)
- Cada miniatura: muros del plan2D extruidos a escala 1:20, `MeshBasicMaterial wireframe`, color `#00f0ff` opacity 0.5
- `Float` de drei: `speed: 0.8, floatIntensity: 0.3`
- Click en miniatura → transición fade hacia plan3D/plan2D de esa habitación

**Panel de navegación (glass, derecha):**
- Lista de habitaciones con nombre + fecha
- `[+ Nueva habitación]`
- `[2D]` `[3D]` `[Inmersivo]` por habitación seleccionada

### Modo Plan2D — `<Plan2DScene />`

**Escena 3D de fondo (tenue):**
- Grid 3D flotando en perspectiva ligera (decorativo, muy opaco)
- Mismo `CosmicBackground` con menos partículas

**Editor SVG (overlay):**
- Fondo: negro con grid de **puntos** cyan cada `STEP` px (no líneas)
- Segmentos: `stroke: #00f0ff`, `strokeWidth: 2`, `filter: drop-shadow(0 0 4px #00f0ff)`
- Hover dot: `fill: #0059ff`
- Panel de herramientas: glass vertical izquierdo con iconos SVG

### Modo Plan3D — `<Plan3DScene />`

**Sin cambios funcionales, mejoras visuales:**
- Grid helper: `colorGrid: #00f0ff22`, `colorCenterLine: #00f0ff66`
- Muros: `MeshStandardMaterial({ color: '#001a2a', emissive: '#00304a', wireframe: false })`
  + overlay wireframe semitransparente `#00f0ff44`
- Entidades seleccionadas: borde outline cyan usando `@react-three/drei <Outlines>`
- Sidebar glass derecho: lista de entidades + panel de skills

### Modo Espacio Inmersivo — `<SpaceScene />`

**Sin cambios funcionales, mejoras visuales:**
- Muros: mismo material que Plan3D
- Crosshair: SVG inline `position: fixed; center`, cruz fina cyan `1px`, dot central `6px`
- Popup de acción: glass panel con `box-shadow glow-md`, entrada desde el lado derecho (slideIn 200ms)
- HUD esquina superior derecha: nombre del entity enfocado + skill activo
- Fondo: `CosmicBackground` visible a través de las "ventanas" (recortes en los muros)

### Modo Cloud — `<CloudScene />`

**Escena 3D:**
- Nodo central: esfera `0.3r` con `emissive: #00f0ff`
- Nodos satélite: 4–8 esferas más pequeñas `0.15r` orbitando en posiciones fijas
- Líneas de conexión: `LineSegments` con `LineBasicMaterial({ color: '#00f0ff', opacity: 0.4 })`
- Nodos pulsan cuando hay actividad (emissiveIntensity animado)
- Temática: servicios/containers como nodos en una constelación

**Panel glass:**
- Lista de servicios con status indicators (dot verde/rojo/amarillo)
- Containers activos

### Modo System — `<SystemScene />`

**Escena 3D:**
- 3 anillos concéntricos a velocidades distintas (CPU, GPU, Network)
- Velocidad: `0.003 + metric/600`
- Anillo más interno: más pequeño y rápido (CPU)
- Anillo externo: más lento (Network)
- Partículas en los anillos que se densifican con la carga

**Panel glass — métricas:**
- CPU: semicírculo gauge SVG, valor %, color `lerp(#00f0ff, #ff4400, usage/100)`
- GPU: igual
- RAM: barra de progreso horizontal
- Network: Rx/Tx en tiempo real
- Tokens Codex: barra de progreso + número

---

## 6. Archivos a Crear / Modificar

### Nuevos

| Archivo | Propósito |
|---------|-----------|
| `frontend/src/state/bootStore.ts` | Máquina de estados DORMANT/LISTENING/AWAKE |
| `frontend/src/components/DormantLayer.tsx` | Solo audio/clap detector, invisible |
| `frontend/src/components/ListeningLayer.tsx` | Dot pulsando + texto |
| `frontend/src/components/RadialTransition.tsx` | Canvas animación radial |
| `frontend/src/components/GlassPanel.tsx` | Componente glass reutilizable |
| `frontend/src/components/HoloDock.tsx` | Barra de navegación inferior |
| `frontend/src/components/CosmicBackground.tsx` | Fondo espacial base (todos los modos) |
| `frontend/src/scenes/AtomicNucleusScene.tsx` | Escena 3D Core |
| `frontend/src/scenes/HouseScene.tsx` | Escena 3D Casa |
| `frontend/src/scenes/CloudScene.tsx` | Escena 3D Cloud |
| `frontend/src/scenes/SystemScene.tsx` | Escena 3D System (refactor de HoloScene) |
| `frontend/src/styles/design-system.css` | Variables CSS, glass, botones, tipografía |

### Modificados

| Archivo | Cambios |
|---------|---------|
| `electron/main.js` | Transparent window, IPC handlers para boot state |
| `electron/preload.js` | Exponer canales IPC: bootState, window control |
| `frontend/src/App.tsx` | Capas DormantLayer / ListeningLayer / AwakeLayer |
| `frontend/src/HoloScene.tsx` | Reemplazado por escenas específicas por modo |
| `frontend/src/modes/Plan2DEditor.tsx` | Rediseño visual: puntos en vez de grid lines, glow |
| `frontend/src/modes/Plan3DViewer.tsx` | Materiales cyan, outlines, sidebar glass |
| `frontend/src/modes/SpaceViewer.tsx` | Crosshair, popup glass, HUD |
| `frontend/src/index.css` | Fuente Space Grotesk, reset, variables globales |

---

## 7. Verificación / Testing

1. **Boot flow:**
   - `npm run dev` → app invisible en taskbar
   - Doble clap → dot aparece en centro inferior
   - Decir "jarvis" → animación radial, app abre
   - Decir "Jarvis, duerme" → contracción, dot desaparece

2. **Navegación:**
   - Hover borde inferior → dock aparece
   - Click en cada modo → transición sin flash

3. **Core:**
   - Anillos rotan en reposo
   - Al activar voz → anillos aceleran
   - Respuesta → efecto typewriter

4. **Funcionalidad existente:**
   - Plan2D: dibujar y guardar plano
   - Plan3D: añadir entidades, asignar skills
   - Space: gaze detection, popup, device-action

5. **Build de producción:**
   - `npm run build:app` → instala sin errores
   - Transparencia y click-through funcionan en la app empaquetada
