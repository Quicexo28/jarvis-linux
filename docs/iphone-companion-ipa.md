# Jarvis Companion para iPhone (.ipa)

Cliente privado de Jarvis para iOS, hermano del APK de la tablet
(`docs/tablet-companion-apk.md`). Mismo diseño: la app **es** la GUI remota
(`frontend/src/modes/remote/`) dentro de un `WKWebView`, y en Swift solo vive lo
que una página web no puede hacer — reporte en segundo plano, dictado, widgets de
pantalla de inicio y reproducción del TTS.

Código en `ios-companion/`. Nada de Xcode local: el proyecto se describe en
`project.yml` (XcodeGen) y lo compila un runner macOS de GitHub Actions.

---

## 1. Los tres muros de iOS (y qué se hizo con cada uno)

### Firma: cuenta gratuita + AltStore (AltServer en `main`)

Un `.ipa` no se instala solo. Con **Apple ID gratuito**:

- El certificado dura **7 días** → AltStore lo refirma solo mientras AltServer
  corra en `main` y el iPhone esté en la misma WiFi. (SideStore hace lo mismo sin
  PC, con un túnel WireGuard local; se descartó porque su emparejamiento inicial
  también exige un ordenador y `main` ya está disponible.)
- Máximo **3 apps** sideloadeadas y **10 App IDs por semana**. La app + la
  extensión de widgets consumen **2**, y AltStore ocupa otra plaza de app.
- **No hay App Groups, ni push (APNs), ni iCloud**: son entitlements de pago.

Por eso el binario **no declara ningún entitlement** — así se firma sin
fallar. Consecuencia concreta y única: la extensión de widgets **no puede leer el
token de la app**, así que los widgets que necesitan red llevan su propio campo
«Enlace de emparejamiento» (mantener pulsado el widget → *Editar widget*). El
widget de Tailscale no necesita nada; lee el estado del sistema.

Al pasar a **Apple Developer ($99/año)**: añadir el App Group
`group.com.jarvis.companion` a los dos targets en `project.yml`. `Config` ya lo
intenta primero, así que los widgets empiezan a leer la configuración de la app y
el campo manual queda ignorado. Cero cambios de código.

### Build: sin Mac

`ios-companion/project.yml` es la fuente de verdad; el `.xcodeproj` se genera y
está en `.gitignore`. El workflow `.github/workflows/ios-companion.yml` corre en
`macos-15`: `brew install xcodegen` → `xcodegen generate` → `xcodebuild` con
`CODE_SIGNING_ALLOWED=NO` → empaqueta `Payload/` en `jarvis-companion.ipa`.

**El repo es público, así que los minutos de macOS son gratis.** En un repo
privado el mismo job gastaría el multiplicador ×10 contra la cuota mensual (plan
Free = 2000 min → ~200 min de macOS, unas 25-40 builds). No hace falta pagar ni
cambiar la visibilidad.

### Reporte periódico: no existe el foreground service

Android mantiene `ReporterService` vivo para siempre. iOS no tiene equivalente.
Lo que sí tiene, y es lo que usa `Reporter.swift`:

| Mecanismo | Qué garantiza |
|---|---|
| Sesión de ubicación con permiso **Siempre** + `UIBackgroundModes: location` | El proceso sigue vivo con la app cerrada, así que el `Timer` de N minutos sigue disparando. **Es el mecanismo principal.** |
| `startMonitoringSignificantLocationChanges()` | iOS **relanza la app terminada** cuando cambias de celda. Recupera el reporte tras un cierre forzado. |
| `BGAppRefreshTask` | Extra oportunista. iOS decide si corre; nunca se depende de él. |

**Precio aceptado a propósito**: flecha de ubicación en la barra de estado y
~3-8%/día de batería. La alternativa (solo geofences) es casi gratis pero se
queda muda durante horas si el teléfono no se mueve.

Sin permiso «Siempre» la app degrada sola: reporta solo mientras esté abierta, y
`SetupView` lo dice con esas palabras.

---

## 2. Instalación

**La firma se hace desde Windows `main`, no desde el portátil Linux.** AltServer
solo existe para Windows y macOS; en Linux habría que montar `usbmuxd` +
`AltServer-Linux`/`Sideloader` a mano, y `main` ya está ahí. El portátil solo
sirve los archivos.

0. **En `main` (una vez)**: instalar **iTunes** e **iCloud** descargados de
   `apple.com`, **no** de la Microsoft Store — las versiones de la Store están
   en sandbox y AltServer no alcanza sus DLLs. Después, AltServer desde
   `altstore.io`.
1. **Emparejar**: iPhone por USB a `main` → «Confiar en este ordenador» →
   bandeja de Windows → AltServer → *Install AltStore* → elegir el iPhone →
   Apple ID + contraseña (el 2FA sale ahí). En el iPhone: *Ajustes → General →
   VPN y gestión de dispositivos* → confiar en el certificado.
2. **Instalar Jarvis** (con Tailscale encendido en el iPhone): AltStore →
   *Sources* → `+` → pegar

   ```
   https://main-jarvis.tail361fcb.ts.net:8443/jarvis-source.json
   ```

   → *Browse* → Jarvis → **Free**. Alternativa sin fuente: abrir
   `…:8443/jarvis-companion.ipa` en Safari y compartirlo a AltStore.

   Los archivos salen de `frontend/public/` (gitignored, igual que el APK):
   `jarvis-companion.ipa`, `jarvis-source.json`, `jarvis-icon.png`. **Ojo: el
   backend sirve `frontend/dist`, no `public/`** — tras reemplazar el `.ipa`
   hay que correr `npm run build` en `frontend/` o se sigue sirviendo el viejo.

   El mismo `.ipa` sale como artifact del workflow, y un tag `ios-v1.0` publica
   además un **Release** de GitHub con su propio `jarvis-source.json`.

   **Refresco de los 7 días**: con AltServer corriendo en `main` y el iPhone en
   la misma WiFi, AltStore refirma solo. Si caduca, la app no abre hasta
   refrescarla — los datos no se pierden.
3. **Emparejar**: abrir la app y pegar el enlace del QR de Jarvis (trae URL y
   token juntos). «Probar conexión» distingue *el portátil no responde* de *el
   token no sirve* — desde el teléfono los dos fallos se parecen.
4. **Permisos**: Ubicación → **Siempre** (iOS lo pide en dos pasos, primero
   «Mientras se usa»), micrófono y reconocimiento de voz para el holograma.
5. **Widgets**: mantener pulsada la pantalla → `+` → Jarvis. En «Jarvis» y
   «Escritorio», mantener pulsado el widget → *Editar widget* → pegar el mismo
   enlace del QR (la cuenta gratuita no permite App Groups, ver §1). El de
   Tailscale funciona sin configurar nada.

---

## 3. Widgets

Los tres viven en **una sola extensión** (`JarvisWidgetBundle`) para no gastar
App IDs. Un widget no puede ejecutar código de la app: solo abrir una URL, así
que todos vuelven por `jarvis://…` y `RootView.handle(_:)` hace el trabajo — el
equivalente del *trampolín* invisible de los widgets de Android.

| Widget | Tamaños | Toque | Notas |
|---|---|---|---|
| **Jarvis** | small, medium | `jarvis://voice` → holograma escuchando | No abre la GUI: escucha. Estado por `/health`, que es público (pregunta por el portátil, nunca por el token). |
| **Tailscale** | small, medium | `jarvis://tailscale` → abre Tailscale | **Solo informa.** En iOS ninguna app puede encender la VPN de otra; el CONNECT_VPN de Android no tiene puerta equivalente. Estado leído del sistema: una IPv4 en `100.64.0.0/10` existe solo con el túnel arriba. |
| **Escritorio** | medium | `jarvis://desktop?uuid=…` → Moonlight | Una zona por máquina en la misma píldora, lista autodescubierta por `/api/skills/desktop/remote`. Sin pantalla de configuración. |

El holograma es el mismo dibujo que el overlay de voz (`Sources/Shared/Holo.swift`),
hecho con formas SwiftUI y no con `Canvas`: son las primitivas que sobreviven al
archivado de una timeline de WidgetKit.

**Moonlight en iOS no acepta destino como en Android.** Allí
`com.limelight.ShortcutTrampoline` está exportado y toma el extra `UUID`; aquí
solo hay un esquema de URL sin parámetro documentado, así que `Desktop.swift`
intenta `moonlight://<uuid>`, cae a `moonlight://` y por último ofrece la App
Store.

---

## 4. Voz

`jarvis://voice` (widget, Siri o el botón de la web) abre `VoiceOverlay`:

`SFSpeechRecognizer` es-CO → `POST /api/jarvis/turn` → `POST /api/jarvis/tts`.

- Es **el mismo cerebro del chat** (sesión persistente con herramientas MCP), no
  un prompt suelto: una orden dicha aquí sí ejecuta cosas.
- El TTS llega como **PCM float32 LE mono a 24 kHz** (la variante WS es la que
  suena en el portátil). `PcmPlayer` lo mete en un `AVAudioEngine` según llega.
  **Cuidado al tocarlo**: un cuerpo HTTP *chunked* parte una muestra float32 por
  la mitad, así que los 1-3 bytes sobrantes se **arrastran** al siguiente trozo;
  descartarlos desfasa todo lo que sigue y la voz sale a ruido.
- El corte de turno lo pone la app (1,2 s sin transcripción nueva):
  `SFSpeechRecognizer` mantiene la sesión abierta mucho después de que dejes de
  hablar.
- Siri: `TalkToJarvisIntent` registra «Oye Siri, hablar con Jarvis». Siri **no**
  se puede sustituir en iOS (en la tablet el `ACTION_ASSIST` sí reemplaza a
  Bixby); esto es lo más cerca que se llega.

---

## 5. El puente `JarvisNative`

La página ya habla con el shell de Android por `window.JarvisNative`
(`frontend/src/modes/remote/native.ts`), y ese contrato es **síncrono**. WebKit
solo entrega mensajes en un sentido, así que `WebContainer` inyecta un shim en
`documentStart` que lee de un objeto `window.__jarvisState` que el lado nativo
rellena con `evaluateJavaScript`. La página no distingue iOS de Android y
`native.ts` no cambia.

`version()`, `reporterRunning()`, `battery()`, `openSettings()`, `startVoice()` y
`openMoonlight()` están cubiertos.

---

## 6. Qué NO se portó, y por qué

- **Toggle de Tailscale**: no hay API en iOS (ver arriba).
- **Push silencioso** para pedir un reporte desde el backend: requiere APNs y por
  tanto cuenta de pago. Cuando se pase a pago es la mejora obvia — el reporte
  dejaría de depender de la sesión de ubicación y la batería bajaría.
- **Reemplazar al asistente del sistema**: imposible en iOS.
- **Arranque automático tras reiniciar el teléfono**: iOS no lo permite; la app
  vuelve a la vida con el primer cambio significativo de ubicación o al abrirla.

---

## 7. Desarrollo

```bash
# Cambiar el proyecto = cambiar el spec, no un .pbxproj
$EDITOR ios-companion/project.yml

# Lanzar un build a mano (repo público → minutos macOS gratis)
gh workflow run "iOS companion (IPA)" --ref <rama>
gh run watch

# Publicar una versión instalable
git tag ios-v1.0 && git push origin ios-v1.0
```

El código Swift no compila en Linux: **el único gate real es el runner**. Tras
tocar `ios-companion/**`, mirar el job antes de dar nada por bueno.
