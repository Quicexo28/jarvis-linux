# Historial de decisiones cerradas

### Estudio 3D — ELIMINADO (2026-08-23)

El modo `studio` (documento de «planos» 3D guardables) y su captura de figuras con las manos se construyeron el 2026-08-22 y se **borraron enteros al día siguiente** a petición del usuario: engorroso y poco práctico. Se fueron `modes/Studio3D.tsx`, `state/studio3dStore.ts`, `state/shapeCaptureStore.ts`, `api/studio3d.ts`, `lib/handShapes/`, `components/studio/`, `handlers/studio3d.js` + sus rutas `/api/skills/studio3d/*`, `backend/data/studio3d/`, las tools MCP `studio_*`, el modo `'studio'` del anillo (Utilidades vuelve a 2 slots: timer/chrono) y su icono del dock. **No reconstruir sin que lo pidan.**

Lo que SÍ sigue vivo y no debe confundirse con esto: el **pipeline de gestos** entero (`frontend/src/gestures/`, `gestureStore.handsFrame`, `acquireLandmarks()`, panel de debug) y el **kind `polygon`** del `Model3DViewer`, que usa la voz por `show_3d`.

### Anillo 3D → Núcleo (2026-11-21)

El carrusel 3D de 6 hologramas (`scenes/WorldScene.tsx` + `scenes/holoKit.tsx`, React Three Fiber) se **sustituyó** por el **Núcleo**: un orbe de CSS (Jarvis) que abre un dial SVG de modos. Elegido entre 8 bocetos (ARC + VACÍO); se probó antes como maqueta HTML con ratón y teclado. Motivo: llegar a un modo exigía girar el carrusel y esperar; los objetivos eran pequeños para la mano; y todo el 3D del anillo cargaba la iGPU sin dar información. Los modos, sub-anillos y el store (`ringLevel`, `activeRingMode`, `zoomedMode`) **no cambian**; se añadió solo `menuOpen`. Fase 1b borra el código del anillo viejo tras confirmar en pantalla. Ver `architecture/frontend-ui.md` § Núcleo.
