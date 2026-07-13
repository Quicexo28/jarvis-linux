# Jarvis Companion — APK privada para la tablet Samsung

App Kotlin nativa (`android-companion/`), sideload directo — nunca pasa por
Play Store. Cero dependencias externas, APK diminuta. Reporta a los endpoints
`/api/mobile/ctx/*` existentes con `device:"tablet"`.

## Qué reporta

| Señal | Cuándo | Endpoint |
|---|---|---|
| Batería + cargando | Cada N min + al conectar/desconectar cargador | `/ctx/battery` |
| Ubicación | Cada N min (LocationManager, sin Play Services) | `/ctx/location` |
| Presencia (en uso) | Pantalla on/off + cada N min | `/ctx/presence` |

Servicio foreground tipo location (notificación persistente "Jarvis
conectado"), `START_STICKY`, se relanza al reboot (BootReceiver; en Android 15
puede requerir abrir la app una vez tras reiniciar).

## Compilar

```bash
cd android-companion
ANDROID_HOME=~/Android/Sdk ~/Android/gradle-8.11.1/bin/gradle assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Firma: `jarvis.keystore` + `keystore.properties` (ambos gitignored, generados
localmente). Si se pierden, regenerar con `keytool` — pero desinstalar la app
vieja antes de instalar una firmada con key nueva.

## Instalar en la tablet

1. Copiar APK a la tablet (opción fácil: se copia a `frontend/dist/` y se
   descarga desde `http://<IP-del-PC>:8788/jarvis-companion.apk` en el
   navegador de la tablet — misma red).
2. Abrir el archivo → permitir "instalar apps desconocidas" para el navegador.
3. Abrir **Jarvis Companion**:
   - URL del backend (tunnel Cloudflare/Tailscale para fuera de casa, o
     `http://<IP>:8788` solo LAN),
   - Token = `MOBILE_INGEST_TOKEN` (en `backend/data/secrets.local.json`),
   - Dispositivo `tablet`, intervalo 15 min.
4. Botón **Permisos de ubicación** → conceder, luego "Permitir siempre".
5. Botón **Ignorar optimización de batería** → aceptar (crítico en Samsung:
   One UI mata servicios sin esto).
6. **Guardar y arrancar** → notificación persistente = funcionando.

Verificar: `curl -s http://localhost:8788/api/mobile/ctx/current -H "Authorization: Bearer $TOKEN"`
debe mostrar `devices.tablet`.

La app permite cleartext (`usesCleartextTraffic`) para que `http://IP:8788`
funcione en LAN; para fuera de casa usa el tunnel https o Tailscale.
