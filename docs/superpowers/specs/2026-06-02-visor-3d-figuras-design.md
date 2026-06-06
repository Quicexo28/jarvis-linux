# Visor 3D de figuras + rotación por gesto mejorada — Diseño

**Fecha:** 2026-06-02
**Estado:** aprobado (diseño), pendiente de plan de implementación

## 1. Objetivo

Que Jarvis muestre, por voz, modelados 3D de estructuras complejas —incluidas
representaciones de figuras de dimensiones superiores (teseracto y más)— en un
visor interactivo donde los gestos controlan la cámara y la figura:

- **pinch** → zoom (acercar/alejar).
- **grab (puño)** → rotar la figura.

Aprovechando esto, se rediseña el **gesto de rotación del ring**, hoy impreciso
e incómodo, con el mismo modelo de rotación que las figuras (consistencia).

## 2. Decisiones tomadas (brainstorming)

1. **Generación:** motor **paramétrico** (superficies por fórmula) + generación
   de **politopos N-dimensionales** (4D+). No un catálogo cerrado: Jarvis puede
   construir cualquier superficie y politopos de cualquier dimensión.
2. **Ubicación:** **overlay dedicado** a pantalla casi-completa, disparado por
   voz (patrón del DisplayCard). Aislado del ring.
3. **Rotación del ring:** se mejora a **drag continuo + snap** (no solo las
   figuras). Modelo de gesto compartido.
4. **Evaluación de fórmulas:** librería **mathjs** (sandbox matemático seguro,
   no ejecuta JS arbitrario).

## 3. Arquitectura

Piezas aisladas, cada una con un propósito y una interfaz clara:

### 3.1 Motor de geometría (`frontend/src/lib/geometry/`)

Convierte un `spec` (JSON) en geometría Three.js. Sin estado, testeable solo.

- **`parametric.ts`** — `buildParametricGeometry(spec): THREE.BufferGeometry`.
  Evalúa `x(u,v)`, `y(u,v)`, `z(u,v)` (strings) con mathjs sobre una grilla
  `segments × segments` en los rangos dados → `ParametricGeometry`/buffer de
  vértices + normales. Cubre superboloide, toro, Klein, Möbius, helicoide, etc.
- **`polytope.ts`** — objetos N-dimensionales:
  - Generadores por dimensión: `hypercube(n)` (2^n vértices = combinaciones de
    ±1; aristas entre vértices que difieren en 1 coordenada), `simplex(n)`,
    `cross(n)` (ortoplex). O `{ vertices: number[][], edges: [i,j][] }` explícito.
  - **Rotación N-D**: matrices de rotación en planos de ejes (XY, XW, YW, ZW…).
    Se acumula un ángulo por plano y se rota el conjunto de vértices N-D.
  - **Proyección N→3D**: perspectiva sucesiva. De dimensión `d` a `d-1`:
    `factor = dist / (dist - coord_d)`, escalar las primeras `d-1` coords. Repetir
    hasta 3D. Resultado: posiciones 3D de vértices + lista de aristas.
  - Render: aristas como `LineSegments`, vértices como `InstancedMesh` de esferas.

### 3.2 Estado (`frontend/src/state/model3dStore.ts`)

Zustand: `{ open: boolean, spec: Model3DSpec | null, show(spec), hide() }`.
Una sola responsabilidad: qué se muestra y si el visor está abierto.

### 3.3 Visor (`frontend/src/components/Model3DViewer.tsx`)

`Canvas` R3F montado en AwakeApp (condicional a `model3dStore.open`). Lee `spec`,
construye la geometría con el motor, y en `useFrame`:
- aplica zoom de cámara desde `pinch.zoom` (dolly).
- aplica rotación de la figura desde el hook de rotación (trackball).
- para politopos: avanza la auto-rotación 4D.

Fondo oscuro, estética Jarvis (cyan). Cierra con voz (`hide_3d`) o Esc.

### 3.4 Rotación por gesto compartida (`frontend/src/lib/gestures/useGestureRotation.ts`)

**La pieza central de la mejora.** Encapsula:
- **Clutch (embrague):** puño cerrado (`grab.active`) engancha; abrir suelta. Al
  enganchar captura la posición base; el delta se mide desde ahí.
- **Suavizado EMA:** filtro pasa-bajos sobre el delta — mata el jitter de
  MediaPipe.
- **Zona muerta:** deltas < ε se ignoran (micro-temblor).
- **Sensibilidad no-lineal:** respuesta suave cerca del centro, más rápida lejos
  (precisión fina + alcance).
- Salida: rotación continua acumulada (yaw/pitch) o un callback de delta suave.

Reutilizado por el ring y el visor → mismo "tacto", un solo lugar que afinar.

## 4. Rotación del ring (refactor)

- `jarvisStore`: el ángulo del ring pasa de **entero-por-slot** a **float
  continuo** (`ringAngle`). `rotateRing` legacy se mantiene para navegación por
  voz (pasos discretos), pero el gesto usa el ángulo continuo.
- Mientras el puño está enganchado: `ringAngle = base + rotación_suavizada`. El
  render del ring interpola a `ringAngle` (el carrusel sigue la mano).
- Al **soltar el puño**: snap animado al slot más cercano (`round(ringAngle)` →
  tween corto). El slot resultante fija `activeRingMode`.
- **Captura exclusiva:** cuando `model3dStore.open` es true, el handler grab→ring
  se desactiva (misma guarda que ya usa `zoomedMode` en AwakeApp).

## 5. Flujo de datos (invocación por voz)

```
voz → Claude (MCP) → show_3d(spec)
  → POST /api/skills/model3d/show
  → backend handler → bridgeToBus('model3d_show', spec)
  → primitiva model3d_show (renderer) → model3dStore.show(spec)
  → <Model3DViewer> renderiza
```

`hide_3d` simétrico (`model3d_hide` → `model3dStore.hide()`).

## 6. Formato del `spec` (parámetros de `show_3d`)

```js
// Superficie paramétrica
{ kind:'parametric', x:"cos(u)*(2+cos(v))", y:"sin(u)*(2+cos(v))", z:"sin(v)",
  uRange:[0,6.283], vRange:[0,6.283], segments:80, title:"Toro", color:"#38d5ff" }

// Politopo N-D
{ kind:'polytope', dimension:4, type:"hypercube", title:"Teseracto" }
//   type: hypercube | simplex | cross   (o { vertices, edges } explícitos)

```

El system prompt enseña a Jarvis a usar `parametric` con la fórmula correcta para
cualquier superficie conocida, y `polytope` para objetos N-dimensionales.
No hay presets: Jarvis construye la figura desde las fórmulas matemáticas.

## 7. Backend

- `mcp-server/jarvis-mcp.js`: tools `show_3d` (schema con kind/params) y `hide_3d`.
- `handlers/skillTools.js`: `handleModel3dShow/Hide` → `bridgeToBus`.
- `routes.js`: `/api/skills/model3d/show` y `/hide`.
- `handlers/speech.js`: `MODEL3D_PROMPT_SECTION` — cuándo y cómo invocar el visor
  (presets vs fórmula vs politopo), y que en voz solo describa, no recite fórmulas.

## 8. Testing

- **Motor de geometría** (unit, sin DOM): `hypercube(4)` → 16 vértices, 32
  aristas; proyección 4D→3D devuelve 16 posiciones; paramétrico de una esfera
  produce el nº de vértices esperado; mathjs rechaza expresiones no-matemáticas.
- **useGestureRotation** (unit): clutch engancha/suelta; EMA reduce varianza de
  una señal ruidosa; zona muerta filtra micro-deltas.
- **Ring snap** (unit): `ringAngle` arbitrario → slot más cercano correcto.
- Backend: las rutas nuevas responden (smoke), sin romper los 41 tests actuales.

## 9. Riesgos / consideraciones

- **mathjs** añade ~150 KB al bundle (ya grande). Aceptable; alternativa sería un
  parser propio, no vale la pena.
- **Rendimiento**: paramétrico con `segments` alto = muchos vértices; cap a ~120.
  Politopos de dimensión alta (n>6) = 2^n vértices/aristas; cap razonable + aviso.
- **Refactor del ring**: cambiar a ángulo continuo toca render + navegación por
  voz. Mantener `rotateRing` discreto para la voz evita romper los MCP tools de
  navegación (`ring_rotate`).
- **Captura de gestos**: verificar que ninguna otra vista (zoomedMode) compita con
  el visor; el visor tiene prioridad mientras `open`.
- **Evaluación de fórmulas**: mathjs es seguro (no eval JS), pero validar rangos y
  capturar NaN/Infinity por fórmula → degradar a wireframe o mensaje.

## 10. Fuera de alcance (YAGNI por ahora)

- Animación/morphing entre figuras.
- Exportar el modelo (STL/GLTF).
- Texturas/materiales avanzados; MVP usa wireframe + emissive cyan.
- Edición de la figura desde la UI (solo por voz).
