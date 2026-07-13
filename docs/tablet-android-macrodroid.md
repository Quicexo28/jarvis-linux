# Conectar la tablet Samsung (Android) — vía MacroDroid

Android sí permite conexión "directa": apps de automatización corren en
background con acceso real a sensores (ubicación, batería, pantalla, WiFi),
sin las limitaciones de iOS. Recomendado: **MacroDroid** (gratis, 5 macros en
plan free) o **Tasker** (~$3, sin límite). Ambas hacen HTTP POST a los mismos
endpoints de ingesta que ya usa el iPhone.

Todos los eventos llevan `"device":"tablet"` para que Jarvis distinga tablet
de iPhone (batería/lugar por dispositivo; sin el campo se asume iphone).

## Endpoints (mismos que iOS)

Base = URL del backend (tunnel/Tailscale/LAN). Header
`Authorization: Bearer <MOBILE_INGEST_TOKEN>` (token en
`backend/data/secrets.local.json`).

| Endpoint | Body JSON |
|---|---|
| `/api/mobile/ctx/battery` | `{"level":83,"charging":true,"device":"tablet"}` |
| `/api/mobile/ctx/place` | `{"event":"arrive","place":"casa","device":"tablet"}` |
| `/api/mobile/ctx/location` | `{"lat":4.6,"lon":-74.1,"device":"tablet"}` |
| `/api/mobile/ctx/focus` | `{"mode":"Trabajo","device":"tablet"}` |
| `/api/mobile/ctx/presence` | `{"foreground":true,"device":"tablet"}` |

## Macros MacroDroid (Añadir macro → Disparador / Acción)

Acción común: **HTTP Request** → método POST, Content-Type `application/json`,
header `Authorization` = `Bearer <token>`, body = JSON de la tabla.

1. **Batería/cargador**: Disparador "Power Connected" → POST battery con
   `{"level":{battery},"charging":true,"device":"tablet"}` (usa magic text
   `{battery}`). Gemela "Power Disconnected" con `"charging":false`.
2. **Llegar/salir de casa**: Disparador "Geofence" (entrar/salir zona) →
   POST place `arrive`/`leave`.
3. **Ubicación periódica** (opcional): Disparador "Regular Interval" 15 min +
   restricción "pantalla encendida" → acción "Get Location" → POST location
   con `{"lat":{lat},"lon":{lon},"device":"tablet"}`.
4. **En uso / inactiva**: Disparador "Screen On/Off" → POST presence
   `{"foreground":true|false,"device":"tablet"}`.

La página web mobile (QR) también funciona en la tablet: detecta Android por
user-agent y reporta `device:"tablet"` automáticamente.

## Alternativas Android

- **Tasker**: igual que MacroDroid, más potente, de pago.
- **Termux + termux-api**: scripts shell con cron (`termux-location`,
  `termux-battery-status`) → curl a los endpoints. Máximo control, más setup.
- **KDE Connect**: integra tablet↔escritorio (notificaciones, batería, media)
  pero no habla con el backend de Jarvis; complementario, no sustituto.
