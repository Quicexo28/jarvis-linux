# Jarvis (Android) — una sola app: remoto + companion + PC remoto

App Kotlin nativa (`android-companion/`), sideload directo — nunca pasa por
Play Store. Es un **WebView sobre la GUI remota** (`frontend/src/modes/remote/`)
más las piezas que un navegador no puede dar. Todo lo visible se sirve desde el
backend, así que un cambio de UI llega al móvil **sin recompilar el APK**.

## Qué hay dentro

| Parte | Dónde vive | Qué hace |
|---|---|---|
| Chat con Jarvis | web (`ChatTab`) | `POST /api/jarvis/turn`, mismas herramientas del escritorio |
| Casa | web (`HomeTab`) | `POST /api/jarvis/device-action` |
| PC remoto | web (`PcTab`) | máquinas del hub: sysinfo, procesos, búsqueda, Wake-on-LAN |
| Estado | web (`StatusTab`) | telemetría del portátil, dispositivos vistos, descarga del APK |
| Reporte en segundo plano | nativo (`ReporterService`) | batería / ubicación / presencia → `/api/mobile/ctx/…` |
| Dictado | nativo (`MainActivity`) | `SpeechRecognizer` — el WebView de Android **no tiene** SpeechRecognition |

Puente JS: `window.JarvisNative` (`version`, `reporterRunning`, `startVoice`,
`openSettings`, `battery`). En un navegador normal no existe y la web cae al
equivalente web (o lo oculta). El servicio foreground es tipo location
(notificación "Jarvis conectado"), `START_STICKY`, se relanza al reboot.

## Widgets de pantalla de inicio

Tres widgets nativos (`app/src/main/java/com/jarvis/companion/widget/`). Todo el
dibujo estético sale de `ui/Holo.kt` (Canvas puro), porque `RemoteViews` no sabe
de gradientes: el holograma es un bitmap.

| Widget | Tamaño | Toque |
|---|---|---|
| **Jarvis** (holograma) | 2×2 | **Escucha** — abre `voice/VoiceActivity`, NO la app |
| **Tailscale** | 2 filas × 4 col | cuerpo = abre Tailscale · botón redondo = conectar/desconectar |
| **Moonlight · máquinas** | 1 fila × 2 col | una zona por máquina: mitad izquierda una, mitad derecha la otra |

- **Jarvis = asistente de voz, no lanzador.** El toque abre un overlay
  translúcido que escucha (`SpeechRecognizer`, es-CO), pregunta al MISMO cerebro
  que el chat (`POST /api/jarvis/turn`, sesión + herramientas MCP) y habla la
  respuesta (`POST /api/jarvis/tts` → PCM float32 24 kHz → `AudioTrack`). El
  holograma es el indicador: cian respirando al escuchar, ámbar al pensar, y
  pulsando con la voz de Jarvis al responder. Registrado para
  `android.intent.action.ASSIST`, así que se puede elegir como asistente del
  sistema (Ajustes → Apps predeterminadas → Asistente digital) en lugar de Bixby.
- **Tailscale** se conmuta con un broadcast explícito a
  `com.tailscale.ipn/.IPNReceiver` (`CONNECT_VPN`/`DISCONNECT_VPN`, el mismo
  gancho que usa Tasker). El estado NO se le pregunta a Tailscale: se lee del
  sistema — una IPv4 en `100.64.0.0/10` existe sólo mientras el túnel está
  arriba.
- **Escritorio remoto**: un solo widget con TODAS las máquinas, una zona tocable
  cada una (hasta 3). Sin pantalla de configuración: la lista se descubre de
  `/api/skills/desktop/remote` y se cachea, así que una máquina nueva (o recién
  encendida por WoL) aparece sola. Cada zona entra directo a su PC vía
  `com.limelight.ShortcutTrampoline` con el extra `UUID`; sin UUID cae a la lista
  de PCs de Moonlight. El escritorio web (pc-remote) sigue en la pestaña **PC** de
  la app, no en el widget.

Refresco: `updatePeriodMillis` de 30 min más lo gratis — cada tick del
`ReporterService` y cada `onResume` de la app ya saben si el portátil responde.

## Compartir → Jarvis (archivos a la bóveda)

`ShareActivity` entra en la hoja de compartir del sistema para **cualquier tipo**
(`*/*`, `SEND` y `SEND_MULTIPLE`). Desde cualquier app: PDF, foto, captura,
texto seleccionado, URL. No tiene UI — es translúcida, `noHistory`, fuera de
recientes; sólo enseña un Toast.

Sube a `POST /api/vault/ingest` (`handlers/vaultIngest.js`), que escribe en
`Clippings/` de la bóveda. **Ahí acaba su trabajo**: `lib/pdfWatcher.js` ya
vigila el vault entero y convierte `pdf/docx/jpg/jpeg/png` a markdown, con OCR
`spa+eng` en las imágenes. Texto y URLs se escriben ya como `.md`, sin watcher.

- **El original se BORRA tras convertir** (lo hace el watcher, no el handler).
  La bóveda guarda el texto, no el binario. Es la conducta elegida.
- **Un PDF escaneado sale casi vacío**: `pdf-parse` lee la capa de texto, no
  hace OCR. Una foto de un recibo pasada a PDF por el móvil rinde un `.md` sin
  contenido. Las imágenes sueltas (jpg/png) sí van por tesseract — compartir la
  **foto** en vez del PDF es lo que funciona hoy.
- **El nombre lo resuelve la app antes de terminar** (`OpenableColumns.DISPLAY_NAME`):
  el permiso de lectura sobre el Uri compartido va atado a la activity y se
  pierde al hacer `finish()`.
- El nombre del cliente se trata como hostil: sólo basename (separadores de los
  dos sistemas), allowlist de extensiones, tope `JARVIS_VAULT_INGEST_MAX_MB`
  (25 por defecto) aplicado **mientras se lee**, y la ruta resuelta se
  re-comprueba contra la raíz del vault antes de escribir.
- El tope **no destruye el socket**: cortarlo impide que el 413 llegue y el
  usuario vería "sin conexión" en vez de "archivo muy grande". Se drena, con
  tope duro a 4×.
- Colisiones → `nombre (2).ext`.

Auth: el mismo `JARVIS_WEB_TOKEN` del emparejamiento. La ruta **no** está en
`DANGEROUS_PATHS` (la tablet tiene que alcanzarla).

Todo lo que se comparta acaba en la bóveda y por tanto en el contexto del
modelo. Es empuje manual a propósito: no hay sincronización automática de
carpetas.

## Seguridad del panel "PC remoto"

El móvil NO habla con `/api/agents/rpc` (local-only: puede lanzar procesos en
otra máquina). Usa `/api/agents/control`, que solo reenvía ops de lectura
(`sys_info`, `list_processes`, `search`) más `wake`. `exec`/`read_file`/
`write_file` devuelven `403 op_not_allowed` salvo que se arranque el backend con
`JARVIS_AGENTS_REMOTE_EXEC=1`.

## Compilar

```bash
cd android-companion
ANDROID_HOME=~/Android/Sdk ~/Android/gradle-8.11.1/bin/gradle assembleRelease
cp app/build/outputs/apk/release/app-release.apk ../frontend/public/jarvis-companion.apk
cd ../frontend && npm run build   # public/ → dist/, que es lo que sirve el backend
```

Firma: `jarvis.keystore` + `keystore.properties` (ambos gitignored). Mantener la
misma key permite actualizar encima; con una key nueva hay que desinstalar antes.
El APK vive en `frontend/public/` (gitignored) porque `vite build` vacía `dist/`.

## Instalar / actualizar

1. Descargar en el móvil:
   `https://main-jarvis.tail361fcb.ts.net:8443/jarvis-companion.apk` (Tailscale)
   o `http://<IP-del-PC>:8788/jarvis-companion.apk` (LAN).
2. Abrir el archivo → permitir "instalar apps desconocidas" para el navegador.
3. En **Jarvis** pegar el **enlace del QR** del escritorio
   (`https://…/?token=…`): trae URL y token juntos. Un solo token sirve para la
   GUI y para el reporte (el backend acepta `JARVIS_WEB_TOKEN` en ambos).
4. Botón **Permisos de ubicación y micrófono** → conceder, luego "Permitir siempre".
5. Botón **Ignorar optimización de batería** → aceptar (crítico en Samsung:
   One UI mata servicios sin esto).
6. **Guardar y abrir Jarvis** → arranca la GUI y la notificación persistente.

Los ajustes se reabren desde *Estado → Ajustes de la app*.

Verificar el reporte:
`curl -s http://localhost:8788/api/mobile/ctx/current -H "Authorization: Bearer $TOKEN"`
debe mostrar `devices.tablet`.

La app permite cleartext (`usesCleartextTraffic`) para que `http://IP:8788`
funcione en LAN; fuera de casa, Tailscale (`https://…ts.net:8443`).
