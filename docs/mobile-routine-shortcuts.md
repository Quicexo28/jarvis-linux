# Monitoreo de rutina vía iPhone (web + Apple Shortcuts)

Jarvis se nutre de la rutina del usuario sin app nativa ni App Store. Dos fuentes:

1. **Página web** (`MobileClient`, abierta en Safari): reporta ubicación en vivo
   (botón "Activar ubicación") y presencia (foreground) mientras está abierta.
2. **Apple Shortcuts / Automatizaciones**: corren en background por evento y
   hacen POST a los endpoints de ingesta. Viven solo en tu iPhone — nada público.

## Endpoints de ingesta

Base = tu URL de backend (tunnel Cloudflare / Tailscale / LAN). Todos requieren
header `Authorization: Bearer <MOBILE_INGEST_TOKEN>`.

El token está en `backend/data/secrets.local.json` (`MOBILE_INGEST_TOKEN`).
Regenerar: `openssl rand -hex 32` → reiniciar `jarvis-backend`.

| Endpoint | Método | Body JSON | Evento |
|---|---|---|---|
| `/api/mobile/ctx/place` | POST | `{"event":"arrive"\|"leave","place":"casa"}` | Llegar/salir de un lugar |
| `/api/mobile/ctx/battery` | POST | `{"level":0.83,"charging":true}` | Cargador / nivel batería |
| `/api/mobile/ctx/focus` | POST | `{"mode":"Trabajo"}` | Cambio Modo Concentración |
| `/api/mobile/ctx/sleep` | POST | `{"state":"asleep"\|"awake"}` | Dormir / despertar |
| `/api/mobile/ctx/location` | POST | `{"lat":4.6,"lon":-74.1}` | Ubicación puntual |
| `/api/mobile/ctx/current` | GET | — | Estado actual (debug) |
| `/api/mobile/ctx/summary?date=YYYY-MM-DD` | GET | — | Resumen de rutina |

`level` acepta 0–1 o 0–100 (se normaliza).

## Cómo crear las automatizaciones (app Atajos → Automatización personal)

Para cada una: acción **"Obtener contenido de URL"**, Método **POST**,
Encabezado `Authorization` = `Bearer <token>`, Cuerpo de solicitud **JSON**.
Activar **"Ejecutar inmediatamente"** para que no pida confirmación.

1. **Al llegar a Casa**: Disparador "Llego a" Casa → POST `/api/mobile/ctx/place`
   JSON `{"event":"arrive","place":"casa"}`. Duplicar para Trabajo, Gym.
2. **Al salir de Casa**: Disparador "Salgo de" Casa → `{"event":"leave","place":"casa"}`.
3. **Cargador conectado**: Disparador "Cargador conectado" → `/api/mobile/ctx/battery`
   JSON `{"level":<Nivel de batería>,"charging":true}` (usa la variable Nivel de batería).
   Crear gemela "Cargador desconectado" con `"charging":false`.
4. **Concentración**: Disparador "Concentración" → `/api/mobile/ctx/focus`
   JSON `{"mode":"<nombre del modo>"}`.
5. **Hora de dormir / Despertar** (Salud o Alarma): → `/api/mobile/ctx/sleep`
   JSON `{"state":"asleep"}` / `{"state":"awake"}`.

## Cómo lo usa Jarvis

- **Contexto en cada respuesta**: el system prompt incluye una sección
  "CONTEXTO MÓVIL" con ubicación, batería, estado y resumen del día.
- **Consultas bajo demanda** (herramientas MCP): `mobile_where` ("¿dónde estoy?",
  "¿cuánta batería?") y `mobile_routine` ("resumen de mi rutina hoy").

Datos persistidos en `backend/data/mobile-context.json` (últimos 500 eventos).
