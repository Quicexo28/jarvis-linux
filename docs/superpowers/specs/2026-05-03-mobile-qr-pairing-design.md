# Mobile QR Pairing — Design Spec

**Date:** 2026-05-03  
**Project:** jarvis-desktop  
**Status:** Approved for implementation

## Overview

The PC runs everything (backend Node server + React frontend). The phone connects as a thin client — it runs nothing locally, it only renders the React app served by the PC and sends requests to the backend. A QR code displayed in the System mode lets the user pair the phone without typing an IP address.

---

## Goals

- Phone connects to PC from any network (Tailscale) or same WiFi (LAN fallback)
- Pairing is done by scanning a QR code — zero manual IP entry on the phone
- Session persists across browser closes; re-scan only required if PC restarts
- Mobile UI is simplified: Jarvis chat, quick-action device buttons, system mini-stats

## Non-goals

- PWA / offline mode (future phase)
- WebSocket real-time push (future phase; polling is sufficient for now)
- Multi-user auth / per-device permissions
- Voice sidecar (separate spec)

---

## Architecture

```
PC
├── backend/src/server.js        listens on 0.0.0.0:8788 (changed from 127.0.0.1)
│   ├── GET  /api/mobile/token   returns token + QR URLs
│   ├── POST /api/mobile/auth    validates token, marks session active
│   └── GET  /api/mobile/status  connection status (polled by System mode)
│
└── frontend/                    same React build, served by backend or Vite
    ├── App.tsx                  detects ?token= on load → auth → mobile mode
    ├── modes/MobileClient.tsx   new component — single-scroll mobile UI
    └── AwakeApp.tsx             new "Conexión Móvil" section in the System panel

PHONE (browser)
└── Opens http://<tailscale-ip>:8788?token=<token>
    → React app loads, detects token, POSTs /api/mobile/auth
    → Stores token + API base in localStorage
    → Renders MobileClient.tsx
```

### Connection priority

1. **Tailscale** (primary): backend shells out `tailscale ip -4` — if it returns an IP, the QR URL uses that IP. Works from any network (4G, home, office).
2. **LAN** (fallback): if Tailscale is not installed or not running, QR uses the PC's local LAN IP (`os.networkInterfaces()` — first non-loopback IPv4). Works only on same WiFi.

The System mode panel shows both URLs as text regardless of which is used in the QR.

---

## Backend Changes

### 1. Bind to `0.0.0.0`

`backend/src/server.js` currently binds to `127.0.0.1`. Change to `0.0.0.0` so LAN and Tailscale clients can reach it. Controlled via `HOST` env var (already supported).

Default: `HOST=0.0.0.0` in the startup script.

### 2. Token store (in-memory)

```js
// backend/src/state/mobileSession.js
{
  token: string,          // 32-char hex, generated on server start
  expiresAt: number,      // Date.now() + 10min — only applies before first auth
  activated: boolean,     // true once a phone has successfully authed
  connectedAt: number | null,
  lastSeen: number | null,
  userAgent: string | null,
  via: 'tailscale' | 'lan' | null
}
```

Token lifecycle:
- Generated once at server startup
- `activated = false` → expires 10 min after generation if nobody scans
- `activated = true` → session lives until server restart (no expiry)
- `POST /api/mobile/token/refresh` regenerates token (resets session)

### 3. New endpoints

**`GET /api/mobile/token`**
```json
{
  "token": "a3f9c2...",
  "lanUrl": "http://192.168.1.45:8788",
  "tailscaleUrl": "http://100.89.x.x:8788",
  "qrUrl": "http://100.89.x.x:8788?token=a3f9c2...",
  "expiresAt": 1746280800000,
  "activated": false
}
```
- `tailscaleUrl` is `null` if `tailscale ip -4` fails or times out (2s timeout)
- `qrUrl` uses tailscale if available, lan otherwise

**`POST /api/mobile/auth`**  
Body: `{ "token": "a3f9c2..." }`  
Response 200: `{ "ok": true, "via": "tailscale" | "lan" }`  
Response 401: `{ "ok": false, "reason": "expired" | "invalid" }`  
- Sets `activated = true`, records `connectedAt`, `userAgent`, `via`

**`GET /api/mobile/status`**  
Response: `{ "connected": true, "lastSeen": 1746280700000, "via": "tailscale" }`  
- Used by the System mode panel to show "X dispositivos conectados" and last-seen time

**`POST /api/mobile/token/refresh`** (desktop only)  
Regenerates token and resets session state. Called when user clicks "NUEVO QR".

### 4. Tailscale detection

```js
// backend/src/lib/tailscale.js
import { execFile } from 'child_process'

export function getTailscaleIp() {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim())
    })
  })
}
```

Called lazily when `/api/mobile/token` is requested. Result is not cached — always fresh (Tailscale IP rarely changes but could after reconnect).

---

## Frontend Changes

### 1. `types.ts` — add `'mobile'` to `Mode` union

```ts
export type Mode = 'home' | 'house' | 'plan2d' | 'plan3d' | 'space' | 'cloud' | 'system' | 'mobile'
```

### 2. `App.tsx` — token detection on load

On mount, before rendering any mode:
1. Check `new URLSearchParams(window.location.search).get('token')`
2. If token found:
   - POST `/api/mobile/auth` with token
   - On 200: store token in `localStorage['jarvis.mobile.token']`, call `setApiBase(window.location.origin)` (the IP:port the phone used to load the app), set mode to `'mobile'`, clear `?token=` from URL (`history.replaceState`)
   - On 401 expired: render `<MobileExpired />` — "El QR ha expirado. Pide al PC que genere uno nuevo."
   - On 401 invalid: render `<MobileExpired />` — "Token inválido."
3. If no token in URL: check `localStorage['jarvis.mobile.token']`
   - If found: POST `/api/mobile/auth` again (re-validate)
   - On 200: set mode to `'mobile'`
   - On 401: clear localStorage token, proceed to normal mode selection

All mobile requests include `Authorization: Bearer <token>` header via a wrapper in `api/client.ts`.

### 3. `modes/MobileClient.tsx` — single-scroll UI

Three sections stacked vertically, full-screen on mobile browser:

**Section 1 — Jarvis**
- Chat history (last 10 turns, stored in component state — not persisted)
- Text input + mic button (reuses `webkitSpeechRecognition` from existing voice pipeline)
- On submit: POST `/api/jarvis/turn` with `{ message, context: { source: 'mobile' } }`
- Reply rendered below input

**Section 2 — Acciones Rápidas**
- 2×N grid of hardcoded device action buttons (no device catalog API exists yet)
- Default buttons: Sala ON, Sala OFF, TV ON, TV OFF, AC ON, AC OFF
- Each button: POST `/api/jarvis/device-action` with `{ entity, action }`
- Configurable list is out of scope — hardcoded for this phase

**Section 3 — Sistema**
- Polls `GET /api/system/telemetry` every 30s
- Shows: CPU %, RAM used/total, GPU % (if available)
- If backend unreachable: shows "Sin conexión — reintentando..."

**Header (sticky)**
- "JARVIS" label + connection indicator dot (green = reachable, red = unreachable)
- Polls `/health` every 15s for the indicator

### 4. `AwakeApp.tsx` — "Conexión Móvil" section

New section added at the top of the System panel (`zoomedMode === 'system'`), above the existing telemetry block:

- Fetches `GET /api/mobile/token` on mount and after "NUEVO QR" click
- Renders QR using `qrcode` npm package (renders to `<canvas>`)
- Shows countdown timer (10 min from `expiresAt`) — stops if `activated = true`
- Shows Tailscale URL and LAN URL as copyable text
- Shows active session info from `GET /api/mobile/status` (polled every 10s)
- "NUEVO QR" button calls `POST /api/mobile/token/refresh` then re-fetches

---

## Data Flow Summary

```
Desktop (System mode)
  → GET /api/mobile/token → renders QR on canvas

User scans QR with phone camera
  → browser opens http://<ip>:8788?token=xxx
  → React app boots, detects ?token=
  → POST /api/mobile/auth → { ok: true }
  → stores token, setApiBase, mode = 'mobile'
  → URL cleaned (?token= removed)

Phone in mobile mode
  → POST /api/jarvis/turn (chat)
  → POST /api/jarvis/device-action (buttons)
  → GET /api/system/telemetry every 30s
  → GET /health every 15s (connection indicator)

Desktop (System mode, polling)
  → GET /api/mobile/status every 10s → shows "Samsung S24 · hace 3 min"
```

---

## Error States

| Scenario | Phone sees | Desktop sees |
|---|---|---|
| QR scanned after 10 min | "QR expirado — pide uno nuevo" | Session: inactive |
| PC restarts | 401 on re-auth → "Re-escanea el QR" | New token generated |
| Tailscale down, on same LAN | QR uses LAN IP — still works | Warning: "QR usa solo LAN" |
| No Tailscale installed | LAN only | Warning: "Tailscale no detectado" |
| Backend unreachable | "Sin conexión — reintentando..." header dot turns red | — |

---

## Dependencies

- **`qrcode`** npm package (frontend) — renders QR to canvas. No server-side QR needed.
- No new backend dependencies — uses existing `child_process` (already used for `nvidia-smi`).

---

## Files Touched

### New
- `backend/src/state/mobileSession.js`
- `backend/src/lib/tailscale.js`
- `backend/src/handlers/mobile.js`
- `frontend/src/modes/MobileClient.tsx`

### Modified
- `backend/src/routes.js` — add `/api/mobile/*` routes
- `backend/src/server.js` — default HOST to `0.0.0.0`
- `frontend/src/types.ts` — add `'mobile'` to `Mode`
- `frontend/src/App.tsx` — token detection on load
- `frontend/src/api/client.ts` — add `Authorization` header when mobile token exists
- `frontend/src/AwakeApp.tsx` — add "Conexión Móvil" section to System panel
- `frontend/package.json` — add `qrcode` dependency

---

## Out of Scope (Future)

- PWA manifest + service worker (installable on home screen)
- WebSocket / SSE for real-time push
- Multi-device support (currently 1 active session)
- Per-device permissions
- Voice sidecar integration on mobile
