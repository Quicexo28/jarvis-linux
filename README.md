# Jarvis Desktop — Estado actual del proyecto

Este proyecto es una app web tipo **Jarvis** orientada a controlar y visualizar una casa virtual con tres capas:

1. **Diseño 2D** de habitaciones/muros.
2. **Construcción 3D** desde ese plano.
3. **Espacio inmersivo** para interacción por mirada con dispositivos.

Además, incluye un backend local para acciones y orquestación básica de Jarvis.

---

## Objetivo del sistema

Construir un entorno doméstico virtual donde:

- puedas modelar habitaciones rápido,
- ubicar muebles/dispositivos,
- definir un punto de vista,
- e interactuar con dispositivos desde una vista inmersiva,
- con integración progresiva al "cerebro" de Jarvis (turnos conversacionales + acciones).

---

## Arquitectura actual

## Frontend
Ruta: `frontend/`

Tecnologías principales:

- React + TypeScript
- Vite
- React Three Fiber + Drei

Módulos de UI principales:

- **Core (`home`)**: interacción con Jarvis por texto/voz.
- **Casa (`house`)**: hub de habitaciones y accesos.
- **Plano 2D (`plan2d`)**: editor de líneas sobre grid.
- **Espacio 3D (`plan3d`)**: edición de muros, objetos y bindings.
- **Inmersivo (`space`)**: primera persona (rotación fija) + foco por mirada.
- **Cloud / System**: vistas visuales adicionales.

## Backend
Ruta: `backend/`

Archivo principal:

- `src/server.js`

Endpoints implementados:

- `GET /health`
- `GET /modules`
- `POST /api/jarvis/turn`
- `POST /api/jarvis/device-action`
- `GET /api/system/telemetry` *(implementado, actualmente opcional desde frontend)*

---

## Flujo funcional del producto

## 1) Plano 2D

Editor basado en grid:

- Escala: **25 cm por celda**.
- Dibujar muros por arrastre lineal.
- Tipos de muro:
  - normal
  - pared baja
- Herramientas:
  - dibujar
  - borrar pared
  - deshacer
  - limpiar
- Guardado por:
  - **habitación** + **nombre**
- Persistencia en `localStorage`.

## 2) Espacio 3D (diseñador)

Carga un plano guardado y lo convierte a muros 3D.

Capacidades:

- Añadir muebles y dispositivos.
- Ajustar posición, rotación, tamaño y altura.
- Definir **punto de vista fijo** (x, y, z, yaw).
- Vincular skills/acciones por dispositivo.
- Seleccionar múltiples acciones mediante chips.

Representación visual:

- Estilo wireframe/contorno para entorno y objetos.
- Dispositivos con color más llamativo y formas geométricas diferenciadas.

## 3) Espacio inmersivo

Modo primera persona orientado a interacción, no juego.

Características:

- Cámara fija al punto de vista (solo rotación).
- Detección por mirada para enfocar dispositivo más cercano al centro visual.
- Priorización de foco cuando hay dispositivos cercanos entre sí.
- Popup HUD contextual con acciones del dispositivo.
- Popup persistente al mantenerlo en el centro de vista.
- Selector de acción con realce visual (activo).
- Crosshair central overlay por encima de todo.
- Zoom por rueda (FOV dinámico dentro de límites).

---

## Integración Jarvis (Core)

En modo Core:

- Input de texto para turnos de Jarvis.
- Reconocimiento de voz manual.
- Respuesta por TTS del navegador (voz global ON/OFF).
- Frase wake configurable (default: `jarvis`).
- Al detectar wake phrase, toma el comando posterior y lo envía a `/api/jarvis/turn`.

---

## Menús y navegación (estado actual)

- Barra principal: `Core`, `Casa`, `Cloud`, `System`.
- `Plano 2D`, `Espacio 3D` e `Inmersivo` se gestionan desde `Casa`:
  - puntos de interés (habitaciones guardadas)
  - submenú de edición desplegable
- Panel derecho de "Estado" fue removido.

---

## Telemetría de sistema

La capa de telemetría real está implementada en backend y en frontend, pero quedó **desactivada por consumo**.

Flag actual en frontend:

- `SYSTEM_TELEMETRY_ENABLED = false`

Si se quiere reactivar:

- cambiar a `true` en `frontend/src/App.tsx`.

---

## Persistencia (resumen)

`localStorage`:

- `jarvis.plan2d.saved.v1` → planos por habitación/nombre
- `jarvis.plan3d.entities.v1` → entidades por plano
- `jarvis.plan3d.viewpoint.v1` → viewpoint por plano

---

## Estado general

El proyecto está en una fase sólida de **MVP funcional** para:

- modelado de espacios,
- edición 3D,
- interacción inmersiva por mirada,
- y control básico vía backend Jarvis.

La base está lista para el siguiente proyecto/fase sin perder continuidad.
