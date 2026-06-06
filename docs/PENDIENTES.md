# Pendientes — jarvis-desktop

Registro de tareas abiertas, en progreso, y consideraciones que deben sobrevivir entre sesiones.

Última actualización: 2026-05-16

---

## Estado actual (snapshot)

- Rama: `master`, 35 commits adelante de `origin/master` (sin pushear).
- Rama default remota: `feat/mobile-qr-pairing` (HEAD de origin).
- Ramas extra locales: `feat/holo-universe`, `wip/2026-05-09-pre-merge`.
- Working tree con cambios sin commit en: speech pipeline, ML gesture/clap, pinch-to-zoom, electron startup, samples eliminados.

---

## 🔴 BUGS / ROTURAS A RESTAURAR

### 1. Vínculo Jarvis ↔ Claude CLI en `/api/jarvis/turn` — ✅ RESUELTO 2026-05-16
- Commit `f887eef`. `backend/src/lib/claudeCli.js` centraliza spawn+stdin+timeout.
- `handleJarvisTurn`, `runClaudeWake` y `handleProcessSpeech` lo consumen.
- Memoria de conversación se mantiene; contexto de `focusedEntity` se inyecta en el user prompt.

### 2. Telemetry hardcodeada — ✅ RESUELTO 2026-05-16
- Commit `18c2c02`. Endpoint `GET /api/system/config` devuelve `telemetryEnabled` desde `JARVIS_TELEMETRY_ENABLED`.
- AwakeApp pollea config en mount; el ciclo de telemetría solo arranca si está habilitado.

### 3. Cloud placeholder vacío — ✅ RESUELTO 2026-05-16
- Commit `aaaa843`. Texto descriptivo de features planeadas (sync Obsidian, planos, historial).

### 4. Vault sin botón "Abrir bóveda" — ✅ RESUELTO 2026-05-16
- Commit `33680ad`. `vault:open` IPC + `electronBridge.openVault` + botón en `ObsidianStatusBadge`.

### 5. Enrollment UX guard — ✅ RESUELTO 2026-05-16
- Commit `eb2d4e0`. Banner en `SpeakerIdPanel` cuando `voiceEnabled && samples.length === 0`. Toast one-time en `AwakeApp.handleSttFinal` si no hay `speakerName`.

---

## 🟡 EN PROCESO (cambios sin commit, riesgo si se pierden)

### Backend
- `handlers/speech.js`, `handlers/stt.js`, `handlers/speakerId.js` — pipeline de voz offline.
- `lib/attentionState.js`, `lib/intentClassifier.js`, `lib/conversationMemory.js`.
- `routes.js` ya wirea todos los endpoints nuevos.
- Python: `stt_service.py`, `speaker_id.py`, `prepare_samples.py`, `start_stt.cmd`, `requirements.txt`.

### Frontend
- `gestures/ml/{classes,model,recognizer}.ts` — recognizer ML híbrido (TF.js MLP).
- `audio/ml/{classes,features,model,recognizer}.ts` — clap ML pipeline.
- Componentes: `GestureMonitor`, `GestureDebugView`, `GestureTrainer`, `ClapTrainer`, `SpeakerIdPanel`, `VoiceHalo`, `PlanSelectorOverlay`.
- `audio/localStt.ts`, `audio/feedbackSounds.ts`, `hooks/useLocalStt.ts`.
- `AwakeApp.tsx` — pinch-to-zoom implementado (líneas 156-170), vignette, panel-by-proximity.
- `state/jarvisStore.ts` — agregó `pinchZoomProgress`.

### Datos sueltos
- `Debug gesture/` (10 archivos de debug + 1 JSON dataset).
- `ML dataset save/` (vacío o pendiente revisar).
- `backend/voice/samples/jarvis-01.mp3` (referencia XTTS, untracked).
- Eliminados (en working tree): `Jarvis voz.mp3`, `voz mejorada.mp3`, varios `_test_*.wav`.

---

## 📂 Estructura de `backend/voice/samples/` (ACLARACIÓN del usuario)

- **`samples/*.mp3|.wav`** (raíz, fuera de `speaker/`) → audio de referencia para **clonado de voz XTTS-v2**.
  - Confirmado en `xtts_service.py:43` (`SAMPLES_DIR = HERE.parent / 'samples'`) y `pick_references()` que toma archivos en la raíz, excluyendo los que empiezan con `_`.
  - Actualmente: `jarvis-01.mp3` (el archivo "fuera del speaker folder" que mencionó el user).
- **`samples/speaker/`** → audios para enrollment de **Speaker ID** (resemblyzer).
  - Confirmado en CLAUDE.md: `_init_speaker_id()` lanza si está vacío y todos los turns se ignoran (`speaker_confidence = 0`).
  - Actualmente: vacío. **Bloquea el flujo de voz hasta que haya ≥1 sample.**
- Documentado en `samples/README.txt` (solo cubre la parte XTTS, no la de Speaker ID).

---

## 🔴 ABIERTO — Features pendientes

### A. Integración con Obsidian (spec listo, implementación pendiente)
- **Spec completo**: `docs/obsidian-integration-spec.md`.
- **Decisiones definidas con el usuario**:
  - Obsidian NO está instalado — descarga + bóveda nueva dedicada.
  - Guardar: notas, device-actions, histórico conversación, tareas, **datos de personalización**.
  - Bidireccional: escritura (fs.writeFile) + lectura (Local REST API plugin).
  - Speaker ID: nombre amigable enrolado por usuario.
- **Etapas de implementación**:
  - ✅ A. Cimientos: `lib/obsidian.js`, `/api/obsidian/status`, `ObsidianStatusBadge` integrado. Skeleton auto-crea `_Templates/`, `Speakers/`, `System/{Actions,Daily}/`. HTTPS:27124 con self-signed cert + Bearer auth.
  - ✅ B. Escrituras pasivas: `appendDeviceAction` (System/Actions/YYYY-MM-DD.md) + `appendHistoryEntry` (Speakers/<name>/History/YYYY-MM-DD.md). Wired en `handleDeviceAction` y `handleProcessSpeech` con fire-and-forget. Falta: que el frontend incluya `speakerName` en el body (queda en Unknown).
  - ⏳ C. Intent classifier extendido (task_create, note_create, query_*, personalize).
  - ⏳ D. Lectura via REST API plugin + inyección al prompt de Claude.
  - ⏳ E. UI: campo nombre en SpeakerIdPanel, botón "abrir bóveda" vía Electron IPC.
- **Bloqueante práctico**: usuario debe instalar Obsidian + crear vault dedicada antes de Etapa D.

### B. Modo Cloud (placeholder)
- `AwakeApp.tsx:430` solo muestra "Próximamente". Decidir: implementar o quitar holograma del ring.

### C. Pinch-to-zoom dentro de canvas (parcial)
- Ring → canvas: ✅ hecho en `AwakeApp.tsx:156-170`.
- Dentro de `Plan3DViewer` (camera.zoom): pendiente verificar end-to-end.
- Dentro de `SpaceViewer` (camera.fov mapeo): pendiente verificar end-to-end.
- Spec completo en `docs/pinch-ring-zoom-spec.md`.

### D. UX de enrollment Speaker ID
- Hoy: sin samples → todos los turns se ignoran silenciosamente (gotcha del CLAUDE.md).
- Propuesta: bloquear voz hasta enrollment + indicador en `SpeakerIdPanel`.

### E. Telemetría desactivada
- `SYSTEM_TELEMETRY_ENABLED = false` en `AwakeApp.tsx:31`. Convertir a env var.

### F. Tests del pipeline de gestos v2
- Tests viejos borrados: `dispatcher.test.ts`, `dtw.test.ts`, `gestureStore.test.ts`.
- Tests nuevos existen para: `features`, `state`, `recognizer`, `output`. Falta cobertura de `pipeline`, hooks, ML recognizer.

### G. Limpieza de assets borrados
- `voice/samples/*.mp3/wav` eliminados (en working tree) — confirmar que ningún código los referencia antes de commitear el rm.

### H. Decisión sobre `Debug gesture/` y `ML dataset save/`
- Opciones: trackear, mover a `samples/training/`, o `.gitignore`.

---

## ⚙️ Convenciones que NO se deben romper

- Toda copy UI en español (Colombia).
- Bridge 2D→3D por composite key `room::name`.
- `localStorage` versionado (`.vN`) — bump si cambia schema, NO migración.
- IndexedDB `jarvis-gesture-model` per-browser-profile.
- `attentionState` y `conversationMemory` son globals en memoria del proceso — se resetean en restart.
- Electron `setSimpleFullScreen` para AWAKE state.
- Hotkey `Ctrl+Alt+J` (override: `JARVIS_WAKE_HOTKEY`).

---

## 📋 Plan de acción multi-fase

### Fase 1 — Consolidar el WIP ✅ COMPLETADA
1. ✅ Crear este archivo.
2. ✅ Decisión: rama destino = `master`.
3. ✅ Decisión: `Debug gesture/` y `ML dataset save/` → `.gitignore` (no trackear).
4. ⏸️ Diferido a Fase 3: restaurar vínculo Claude CLI en `/api/jarvis/turn`.
5. ✅ 8 commits temáticos hechos sobre master (43 ahead de origin):
   - docs · gitignore · samples · backend speech · python · frontend voice · gestures ML · UI/pinch.

### Fase 2 — Integración remota ⏸️ DIFERIDA
- Sin push todavía. Continuamos en local.

### Fase 3 — Features abiertas (EN PROGRESO)
- 🔄 A. Obsidian: spec creado en `docs/obsidian-integration-spec.md`. Implementación pendiente.
- ⏳ Bug: restaurar Claude CLI en `/api/jarvis/turn`.
- ⏳ B-G: ver lista arriba.

### Fase 2 — Integración remota
6. Rebase/merge contra rama default.
7. Push + PR.

### Fase 3 — Features abiertas
8. Obsidian integration (A).
9. Modo Cloud (B).
10. Pinch zoom en canvas modes (C).
11. Speaker enrollment UX (D).
12. Telemetry env-gated (E).
13. Tests gestures v2 (F).
