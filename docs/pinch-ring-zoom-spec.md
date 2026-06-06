# Pinch-to-Zoom-Into-Hologram Specification

## Objetivo

Usar el gesto pinch (mano derecha) para hacer zoom en el holograma enfocado del ring carousel, transicionando suavemente hacia el modo seleccionado. El pinch ya produce un valor continuo de zoom (0.5–3.0) que actualmente NO esta conectado a ninguna accion UI.

---

## Arquitectura Actual

### Estado del Ring

```
jarvisStore:
  ringLevel: 'main' | 'house-sub'
  activeRingMode: Mode           // holograma enfocado actualmente
  zoomedMode: Mode | null        // modo entrado (null = en el ring)
  rotateRing(dir)                // rota el ring ±1
  setZoomedMode(mode)            // entra a un modo
```

### Flujo Actual de Entrada a un Modo

```
Ring (WorldScene) → click gesture → setZoomedMode(activeRingMode) → overlay aparece
```

### Pinch Output Disponible

```typescript
gestureOutput.pinch = {
  active: boolean,     // esta haciendo pinch?
  zoom: number,        // 0.5 a 3.0 (smoothed)
  paused: boolean,     // pausado por pinky modifier
}
```

---

## Archivos Involucrados

| Archivo | Rol | Que Modificar |
|---------|-----|---------------|
| `frontend/src/scenes/WorldScene.tsx` | Renderiza el ring 3D con los hologramas | Leer pinchZoomProgress, escalar/mover holograma activo |
| `frontend/src/state/jarvisStore.ts` | Estado global del ring y modos | Agregar `pinchZoomProgress: number` |
| `frontend/src/AwakeApp.tsx` | Conecta gestos → acciones | Agregar efecto: pinch → pinchZoomProgress → setZoomedMode |
| `frontend/src/modes/Plan3DViewer.tsx` | Escena 3D con OrbitControls | Conectar pinch.zoom al camera.zoom (dentro del modo) |
| `frontend/src/modes/SpaceViewer.tsx` | Vista inmersiva FP | Conectar pinch.zoom al FOV de camera |
| `frontend/src/gestures/output.ts` | Produce pinch.zoom | No modificar — ya funciona |
| `frontend/src/gestures/config.ts` | Thresholds de pinch | No modificar (o ajustar si zoom range no alcanza) |
| `frontend/src/state/gestureStore.ts` | Expone gesture output | No modificar — ya expone pinch |

---

## Comportamiento Propuesto

### Desde el Ring (sin zoomedMode)

1. Usuario hace pinch con mano derecha
2. `pinch.zoom` sube de 1.0 hacia 3.0
3. El holograma enfocado escala proporcionalmente:
   - `scale = baseScale * (1 + pinchZoomProgress * 2)`
   - Se mueve hacia la camara (reduce Z)
4. Cuando `pinch.zoom > 2.0` (threshold configurable):
   - Ejecutar `setZoomedMode(activeRingMode)`
   - Transicion suave al overlay del modo
5. Si suelta pinch antes del threshold:
   - Holograma vuelve a su escala/posicion normal (animado)

### Dentro de Canvas Modes (plan3d, space)

- **Plan3DViewer**: `pinch.zoom` controla `camera.zoom` del OrbitControls
- **SpaceViewer**: `pinch.zoom` controla `camera.fov` (mapear zoom 0.5–3.0 a FOV 110–60)

### Guards (Que NO Romper)

| Gesto | Funcion | Guard |
|-------|---------|-------|
| Grab (izq) | Rotar ring | Solo si pinch NO esta activo |
| Click (peace_sep release) | Entrar modo | Sigue funcionando igual |
| Back (peace_close release) | Salir modo | Sigue funcionando igual |
| Pinky extended | Pausar zoom | Congela pinch.zoom |
| Point (izq) | Puntero visual | Independiente del pinch |

---

## Implementacion Paso a Paso

### Paso 1: Agregar estado en jarvisStore

```typescript
// frontend/src/state/jarvisStore.ts
interface JarvisState {
  // ... existente ...
  pinchZoomProgress: number  // 0 a 1 (0=ring normal, 1=entrar modo)
  setPinchZoomProgress: (v: number) => void
}
```

### Paso 2: Efecto en AwakeApp

```typescript
// frontend/src/AwakeApp.tsx
useEffect(() => {
  // Solo en el ring (sin modo abierto)
  if (zoomedMode != null) return
  
  if (!gestureOutput.pinch.active) {
    // Solto pinch, animar vuelta a 0
    setPinchZoomProgress(0)
    return
  }
  
  // Ignorar si grab esta activo (evitar conflicto)
  if (gestureOutput.grab.active) return
  
  // Mapear zoom [1.0, 2.0] → progress [0, 1]
  const progress = Math.max(0, Math.min(1, (gestureOutput.pinch.zoom - 1.0) / 1.0))
  setPinchZoomProgress(progress)
  
  // Threshold: entrar al modo
  if (progress >= 1.0) {
    setZoomedMode(activeRingMode)
    setPinchZoomProgress(0)
  }
}, [gestureOutput.pinch.zoom, gestureOutput.pinch.active, gestureOutput.grab.active, zoomedMode])
```

### Paso 3: Modificar WorldScene (holograma activo)

En el componente `RingHologram`, leer `pinchZoomProgress` del store:

```typescript
// frontend/src/scenes/WorldScene.tsx — dentro de RingHologram
const pinchProgress = useJarvisStore(s => s.pinchZoomProgress)
const isFocused = focus > 0.9  // solo el holograma frontal

// Aplicar al scale y posicion
const pinchScale = isFocused ? 1 + pinchProgress * 2 : 1
const pinchZ = isFocused ? pinchProgress * 3 : 0  // acercar a camara

// En el mesh/group:
<group
  scale={[baseScale * pinchScale, baseScale * pinchScale, baseScale * pinchScale]}
  position={[x, y, z + pinchZ]}
>
```

### Paso 4: Conectar pinch dentro de Plan3DViewer

```typescript
// frontend/src/modes/Plan3DViewer.tsx
const pinchZoom = useGestureStore(s => s.output.pinch)

useFrame(() => {
  if (pinchZoom.active && camera) {
    camera.zoom = pinchZoom.zoom
    camera.updateProjectionMatrix()
  }
})
```

### Paso 5: Conectar pinch dentro de SpaceViewer

```typescript
// frontend/src/modes/SpaceViewer.tsx
const pinchZoom = useGestureStore(s => s.output.pinch)

useFrame(() => {
  if (pinchZoom.active && camera instanceof THREE.PerspectiveCamera) {
    // Mapear zoom [0.5, 3.0] → FOV [110, 60]
    camera.fov = 110 - (pinchZoom.zoom - 0.5) * (50 / 2.5)
    camera.updateProjectionMatrix()
  }
})
```

### Paso 6: Guard en grab effect

```typescript
// frontend/src/AwakeApp.tsx — en el efecto de grab
useEffect(() => {
  // No rotar si esta haciendo pinch
  if (gestureOutput.pinch.active) return
  if (!gestureOutput.grab.active || zoomedMode != null) {
    grabStepRef.current = 0
    return
  }
  // ... resto del step logic
}, [gestureOutput.grab.deltaX, gestureOutput.grab.active, gestureOutput.pinch.active])
```

---

## Detalles Tecnicos del Ring (WorldScene.tsx)

### Geometria del Carousel

- Camara fija en origen, mirando -Z, FOV 72
- Main ring: 4 hologramas a 90 grados de separacion
- Sub ring: 3 hologramas a 120 grados
- Radio: R_ACTIVE=4 (enfocado), R_IDLE=7 (no enfocado)
- Posicion de cada holograma: `(R*sin(angle), 0, -R*cos(angle))`

### Focus Calculation

```typescript
focus = max(0, cos(angleFromFront))
// focus=1 → en frente, focus=0 → a los lados/atras
```

### Scale y Visibilidad

```
scale = 0.65 + 0.55 * focus       // rango: 0.65 a 1.2
visible = angleFromFront < 100°
opacity = f(focus)
```

### Animacion de Rotacion

```typescript
// Damping suave (~350ms para asentarse)
k = 1 - Math.pow(0.005, delta)
currentAngle += (targetAngle - currentAngle) * k
```

---

## Threshold y Configuracion Sugerida

```typescript
// Agregar a frontend/src/gestures/config.ts
export const PINCH_ENTER_THRESHOLD = 2.0      // zoom value para entrar al modo
export const PINCH_ENTER_HOLD_MS = 300        // ms que debe mantenerse en threshold
export const PINCH_SCALE_MULTIPLIER = 2.0     // cuanto escala el holograma
export const PINCH_APPROACH_DISTANCE = 3.0    // cuanto se acerca a la camara
```

---

## Resumen Visual

```
[Ring normal]
     |
     | pinch activo, zoom sube
     v
[Holograma crece + se acerca]  ←── pinchZoomProgress: 0→1
     |
     | zoom > 2.0 por 300ms
     v
[setZoomedMode → overlay del modo aparece]
     |
     | dentro del modo: pinch controla camera zoom
     v
[Camera zoom en Plan3D/Space]
```
