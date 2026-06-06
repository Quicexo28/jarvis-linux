# Jarvis Linux — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Jarvis on Linux without Electron — Node.js backend serves the frontend as static files, systemd starts all services on boot, Electron IPC removed from the frontend.

**Architecture:** Five systemd user services (backend, STT, TTS, wake-word, Chromium-UI) replace Electron. The Node.js backend gains a static file handler that serves `frontend/dist/` at `:8788`, so Chromium `--app=http://localhost:8788` is the only UI process. Electron-specific IPC calls in `App.tsx` are removed; boot-state transitions continue to work via the existing Zustand store (clap detection, double clap) without any bridge.

**Tech Stack:** Node.js ESM, Vitest, systemd user units, bash, Chromium `--app` mode, Python 3, openWakeWord (future plans), resemblyzer.

**Working directory:** All paths relative to the root of `jarvis-linux/`.

---

### Task 1: Extract and test the Linux network telemetry parser

Replace the `powershell Get-NetAdapterStatistics` call in `backend/src/handlers/telemetry.js` with a `/proc/net/dev` reader. Extract parsing logic into a named export so it can be unit-tested without touching the filesystem.

**Files:**
- Modify: `backend/src/handlers/telemetry.js`
- Create: `backend/tests/telemetry.unit.test.js`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/telemetry.unit.test.js`:

```js
import { test, expect } from 'vitest'
import { parseNetDev } from '../src/handlers/telemetry.js'

const SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  184836    1842    0    0    0     0          0         0   184836    1842    0    0    0     0       0          0
  eth0: 123456789  12345    0    0    0     0          0        0  987654321  9876    0    0    0     0       0          0`

test('parseNetDev sums rx bytes across all interfaces', () => {
  const { totalRx } = parseNetDev(SAMPLE)
  expect(totalRx).toBe(184836 + 123456789)
})

test('parseNetDev sums tx bytes across all interfaces', () => {
  const { totalTx } = parseNetDev(SAMPLE)
  expect(totalTx).toBe(184836 + 987654321)
})

test('parseNetDev returns zeros for header-only content', () => {
  const { totalRx, totalTx } = parseNetDev('Inter-|\n face |\n')
  expect(totalRx).toBe(0)
  expect(totalTx).toBe(0)
})

test('parseNetDev handles interface names without leading spaces', () => {
  const compact = `Inter-|\n face |\nwlan0:99    1    0    0    0     0          0         0   77    1    0    0    0     0       0          0`
  const { totalRx, totalTx } = parseNetDev(compact)
  expect(totalRx).toBe(99)
  expect(totalTx).toBe(77)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && npm test -- telemetry.unit
```

Expected: `Cannot find module` or `parseNetDev is not a function`.

- [ ] **Step 3: Replace `getNetworkTelemetry` and export `parseNetDev` in telemetry.js**

In `backend/src/handlers/telemetry.js`, replace the entire `getNetworkTelemetry` function and add the new export:

```js
// Replace the old getNetworkTelemetry function (the one with the powershell call)
// and add parseNetDev just above it.

import fs from 'node:fs/promises'

// Exported for unit testing.
export function parseNetDev(content) {
  let totalRx = 0
  let totalTx = 0
  const lines = content.split('\n').slice(2) // skip 2 header lines
  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const parts = line.slice(colonIdx + 1).trim().split(/\s+/)
    // /proc/net/dev columns (0-indexed after the colon):
    //  0=rx_bytes  1=rx_pkt  2=rx_err … 8=tx_bytes  9=tx_pkt …
    totalRx += parseInt(parts[0] ?? '0', 10) || 0
    totalTx += parseInt(parts[8] ?? '0', 10) || 0
  }
  return { totalRx, totalTx }
}

async function getNetworkTelemetry() {
  try {
    const content = await fs.readFile('/proc/net/dev', 'utf8')
    const { totalRx, totalTx } = parseNetDev(content)
    const now = Date.now()

    if (!lastNetSnapshot) {
      lastNetSnapshot = { totalRx, totalTx, ts: now }
      return { rxMbps: 0, txMbps: 0 }
    }

    const dt = Math.max(1, now - lastNetSnapshot.ts)
    const rxMbps = ((totalRx - lastNetSnapshot.totalRx) * 8) / dt / 1000
    const txMbps = ((totalTx - lastNetSnapshot.totalTx) * 8) / dt / 1000
    lastNetSnapshot = { totalRx, totalTx, ts: now }
    return { rxMbps: Math.max(0, rxMbps), txMbps: Math.max(0, txMbps) }
  } catch {
    return { rxMbps: 0, txMbps: 0 }
  }
}
```

Also remove the old `import fs` if already present at top, deduplicate.

- [ ] **Step 4: Run tests — all 4 must pass**

```bash
cd backend && npm test -- telemetry.unit
```

Expected: `4 passed`.

- [ ] **Step 5: Run full backend test suite — no regressions**

```bash
cd backend && npm test
```

Expected: all tests pass (same count as before).

- [ ] **Step 6: Commit**

```bash
git add backend/src/handlers/telemetry.js backend/tests/telemetry.unit.test.js
git commit -m "feat(linux): replace PowerShell telemetry with /proc/net/dev parser"
```

---

### Task 2: Static file handler — backend serves frontend/dist/

The Node.js backend needs to serve the built frontend so Chromium can load it from `http://localhost:8788` without a separate Vite process.

**Files:**
- Create: `backend/src/handlers/static.js`
- Modify: `backend/src/server.js`
- Create: `backend/tests/static.unit.test.js`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/static.unit.test.js`:

```js
import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from '../src/handlers/static.js'

let distDir

function makeRes() {
  const headers = {}
  let body = null
  return {
    headers,
    setHeader(k, v) { headers[k] = v },
    end(data) { body = data ?? null },
    body: () => body,
  }
}

function makeReq(method, url) {
  return { method, url, headers: { host: 'localhost' } }
}

beforeAll(async () => {
  distDir = await mkdtemp(join(tmpdir(), 'jarvis-static-'))
  await writeFile(join(distDir, 'index.html'), '<html>Jarvis</html>')
  await mkdir(join(distDir, 'assets'))
  await writeFile(join(distDir, 'assets', 'main.js'), 'console.log("hi")')
  await writeFile(join(distDir, 'assets', 'style.css'), 'body{}')
})

afterAll(async () => {
  await rm(distDir, { recursive: true, force: true })
})

test('serves index.html for root path', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/'), res, distDir)
  expect(handled).toBe(true)
  expect(res.headers['Content-Type']).toContain('text/html')
  expect(res.body().toString()).toBe('<html>Jarvis</html>')
})

test('serves JS asset with correct content-type', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/assets/main.js'), res, distDir)
  expect(handled).toBe(true)
  expect(res.headers['Content-Type']).toContain('javascript')
})

test('serves CSS asset with correct content-type', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/assets/style.css'), res, distDir)
  expect(handled).toBe(true)
  expect(res.headers['Content-Type']).toContain('text/css')
})

test('returns false for any /api/* path — never served as static', async () => {
  const res = makeRes()
  // API routes must fall through to dispatch() even when path has no extension
  // (without this guard, /api/health would be caught by the SPA fallback and
  //  served as index.html instead of going to the health handler).
  const handled = await serveStatic(makeReq('GET', '/api/health'), res, distDir)
  expect(handled).toBe(false)
})

test('SPA fallback: unknown path without extension serves index.html', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/some/deep/route'), res, distDir)
  expect(handled).toBe(true)
  expect(res.body().toString()).toBe('<html>Jarvis</html>')
})

test('returns false for non-GET/HEAD methods', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('POST', '/'), res, distDir)
  expect(handled).toBe(false)
})

test('HEAD request returns headers without body', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('HEAD', '/index.html'), res, distDir)
  expect(handled).toBe(true)
  expect(res.body()).toBeNull()
  expect(res.headers['Content-Type']).toContain('text/html')
})

test('rejects path traversal attempts', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/../../../etc/passwd'), res, distDir)
  expect(handled).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && npm test -- static.unit
```

Expected: `Cannot find module '../src/handlers/static.js'`.

- [ ] **Step 3: Create `backend/src/handlers/static.js`**

```js
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Override via env var for testing or alternate deployments.
const DEFAULT_DIST = path.resolve(__dirname, '..', '..', '..', 'frontend', 'dist')

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.json':  'application/json',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.webp':  'image/webp',
  '.glb':   'model/gltf-binary',
  '.wav':   'audio/wav',
  '.mp3':   'audio/mpeg',
}

/**
 * Try to serve a static file from distPath (defaults to frontend/dist/).
 * Returns true if the response was handled; false to fall through to API routes.
 * Signature: (req, res, distPath?) => Promise<boolean>
 */
export async function serveStatic(req, res, distPath = process.env.JARVIS_FRONTEND_DIST ?? DEFAULT_DIST) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false

  const url = new URL(req.url, 'http://localhost')
  const normalized = path.normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '')
  let filePath = path.join(distPath, normalized)

  // Security: reject any path that escapes distPath after normalization.
  if (!filePath.startsWith(path.resolve(distPath))) return false

  // Never serve static for API routes — let them fall through to dispatch().
  if (url.pathname.startsWith('/api/')) return false

  let stat = null
  try { stat = await fs.stat(filePath) } catch {}

  // SPA fallback: path with no file extension and not an API route → index.html
  if ((!stat || !stat.isFile()) && !path.extname(url.pathname)) {
    filePath = path.join(distPath, 'index.html')
    try { stat = await fs.stat(filePath) } catch {}
  }

  if (!stat || !stat.isFile()) return false

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME[ext] ?? 'application/octet-stream'

  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', stat.size)

  if (req.method === 'HEAD') { res.end(); return true }

  const content = await fs.readFile(filePath)
  res.end(content)
  return true
}
```

- [ ] **Step 4: Run tests — all 8 must pass**

```bash
cd backend && npm test -- static.unit
```

Expected: `8 passed`.

- [ ] **Step 5: Wire `serveStatic` into server.js**

In `backend/src/server.js`, add the import and call it before `dispatch()`:

```js
// Add this import near the top (after existing imports):
import { serveStatic } from './handlers/static.js'
```

Replace the `http.createServer` callback:

```js
const server = http.createServer(async (req, res) => {
  try {
    // Serve built frontend before API routes. Returns false when no file matches,
    // allowing API dispatch to proceed normally.
    if (await serveStatic(req, res)) return
    await dispatch(req, res)
  } catch (err) {
    console.error('unhandled', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'internal' }))
    }
  }
})
```

- [ ] **Step 6: Run full backend suite — no regressions**

```bash
cd backend && npm test
```

Expected: all prior tests + 8 new static tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/handlers/static.js backend/src/server.js backend/tests/static.unit.test.js
git commit -m "feat(linux): backend serves frontend/dist as static files at :8788"
```

---

### Task 3: Remove Electron IPC from App.tsx

`App.tsx` has two `useEffect` blocks that use `window.electronBridge`. These are the only Electron-specific calls in the frontend. Removing them leaves boot state transitions (clap detection, UI buttons) working through the Zustand store directly.

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Run current frontend tests to establish baseline**

```bash
cd frontend && npm test -- --run
```

Note the passing count. Expected: 126 passed.

- [ ] **Step 2: Remove the two `electronBridge` useEffect blocks from App.tsx**

Find and delete these two blocks (they are adjacent, roughly lines 33–52):

```tsx
// DELETE this block:
useEffect(() => {
  const bridge = (window as any).electronBridge
  if (!bridge?.onBootState) return
  return bridge.onBootState((s: string) => {
    if (s === 'DORMANT' || s === 'AWAKE') {
      setBootState(s)
    }
  })
}, [setBootState])

// AND DELETE this block:
useEffect(() => {
  const bridge = (window as any).electronBridge
  bridge?.setBootState?.(bootState)
}, [bootState])
```

After deleting, also remove `setBootState` from the destructured `useBootStore` call if it is no longer used anywhere else in this component. Check the remaining code first — `setBootState` may still be used by `mobileState` logic. If it is, keep the destructure.

The comment `// Listen for boot state pushes from the Electron tray menu` above the first block should also be deleted.

- [ ] **Step 3: Run frontend tests — same count, no regressions**

```bash
cd frontend && npm test -- --run
```

Expected: 126 passed (same as baseline).

- [ ] **Step 4: Verify no remaining `electronBridge` references in frontend src**

```bash
grep -r "electronBridge" frontend/src/
```

Expected: no output (zero matches).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(linux): remove Electron IPC bridge from App.tsx"
```

---

### Task 4: Delete Electron files and update package.json

Remove Electron from the project root. The Linux version uses systemd + Chromium directly.

**Files:**
- Delete: `electron/main.js`, `electron/preload.js`, `electron/config.js`
- Delete: `electron/` directory (entire folder once files removed)
- Modify: `package.json` (root)

- [ ] **Step 1: Delete Electron source files**

```bash
git rm electron/main.js electron/preload.js
git rm -r electron/
```

If `electron/assets/` contains only the Windows `.ico` icon (not needed on Linux), remove it too. Confirm:

```bash
ls electron/assets/
```

If only `icon.ico`, `icon.png`, `ICON_REQUIRED.txt` → remove them all.

- [ ] **Step 2: Update root `package.json`**

Replace the entire file with this Linux-specific version:

```json
{
  "name": "jarvis-linux",
  "version": "1.0.0",
  "description": "Jarvis system shell for Linux",
  "private": true,
  "scripts": {
    "build:frontend": "cd frontend && npm run build",
    "dev:backend":    "cd backend && npm run dev",
    "dev:frontend":   "cd frontend && npm run dev",
    "test:backend":   "cd backend && npm test",
    "test:frontend":  "cd frontend && npm test -- --run"
  }
}
```

- [ ] **Step 3: Verify build still works**

```bash
npm run build:frontend
```

Expected: `frontend/dist/` is generated without errors (`vite build` success).

- [ ] **Step 4: Run both test suites — no regressions**

```bash
cd backend && npm test
cd ../frontend && npm test -- --run
```

Expected: backend all pass, frontend 126 pass.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(linux): remove Electron, replace with Linux-native package.json"
```

---

### Task 5: Create systemd user service files

Five service files that manage the Jarvis daemon stack. Installed to `~/.config/systemd/user/` by the install script in Task 6.

**Files:**
- Create: `scripts/linux/jarvis-backend.service`
- Create: `scripts/linux/jarvis-stt.service`
- Create: `scripts/linux/jarvis-tts.service`
- Create: `scripts/linux/jarvis-wake.service`
- Create: `scripts/linux/jarvis-ui.service`

- [ ] **Step 1: Create `scripts/linux/` directory**

```bash
mkdir -p scripts/linux
```

- [ ] **Step 2: Create `scripts/linux/jarvis-backend.service`**

```ini
[Unit]
Description=Jarvis Backend (Node.js API + static frontend)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/jarvis-linux/backend
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=8788
Environment=HOST=127.0.0.1

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Create `scripts/linux/jarvis-stt.service`**

```ini
[Unit]
Description=Jarvis STT Service (faster-whisper)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/jarvis-linux/backend/voice/python
ExecStart=%h/jarvis-linux/backend/voice/python/.venv/bin/python stt_service.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Create `scripts/linux/jarvis-tts.service`**

```ini
[Unit]
Description=Jarvis TTS Service (edge-tts / XTTS)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/jarvis-linux/backend/voice/python
ExecStart=%h/jarvis-linux/backend/voice/python/.venv/bin/python edge_tts_service.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 5: Create `scripts/linux/jarvis-wake.service`** (placeholder for Plan 2)

```ini
[Unit]
Description=Jarvis Wake Word Daemon (openWakeWord)
After=jarvis-backend.service

[Service]
Type=simple
WorkingDirectory=%h/jarvis-linux/backend/voice/python
ExecStart=%h/jarvis-linux/backend/voice/python/.venv/bin/python wake_service.py
Restart=on-failure
RestartSec=5
# This service will be functional after Plan 2 (wake_service.py is created then).

[Install]
WantedBy=default.target
```

- [ ] **Step 6: Create `scripts/linux/jarvis-ui.service`**

```ini
[Unit]
Description=Jarvis UI (Chromium app-mode)
After=jarvis-backend.service
Requires=jarvis-backend.service

[Service]
Type=simple
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/chromium \
  --app=http://localhost:8788 \
  --no-default-browser-check \
  --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream=false \
  --ozone-platform-hint=auto \
  --enable-features=UseOzonePlatform
Restart=on-failure
RestartSec=3
# Supports both X11 and Wayland. --ozone-platform-hint=auto picks at runtime.
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-0

[Install]
WantedBy=default.target
```

- [ ] **Step 7: Commit**

```bash
git add scripts/linux/
git commit -m "feat(linux): add systemd user service files for all Jarvis daemons"
```

---

### Task 6: Linux install script

A single `install.sh` that bootstraps Jarvis on a fresh EndeavourOS / Arch system. Idempotent — safe to re-run.

**Files:**
- Create: `scripts/linux/install.sh`

- [ ] **Step 1: Create `scripts/linux/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

JARVIS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
echo "[jarvis-install] Installing from: $JARVIS_DIR"

# ── System packages ──────────────────────────────────────────────────────────
echo "[jarvis-install] Installing system packages via pacman..."
sudo pacman -S --needed --noconfirm \
  nodejs npm \
  python python-pip \
  chromium \
  git \
  portaudio  # required by pyaudio / openWakeWord

# ── Node.js dependencies ─────────────────────────────────────────────────────
echo "[jarvis-install] Installing backend Node.js dependencies..."
cd "$JARVIS_DIR/backend" && npm install

echo "[jarvis-install] Installing frontend Node.js dependencies..."
cd "$JARVIS_DIR/frontend" && npm install

# ── Build frontend ────────────────────────────────────────────────────────────
echo "[jarvis-install] Building frontend..."
cd "$JARVIS_DIR/frontend" && npm run build

# ── Python virtual environment ────────────────────────────────────────────────
VENV="$JARVIS_DIR/backend/voice/python/.venv"
echo "[jarvis-install] Creating Python venv at $VENV..."
python -m venv "$VENV"

echo "[jarvis-install] Installing Python dependencies..."
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install -r "$JARVIS_DIR/backend/voice/python/requirements.txt"

# openWakeWord and resemblyzer (needed for Plans 2+)
"$VENV/bin/pip" install openWakeWord resemblyzer

# ── Config directory ──────────────────────────────────────────────────────────
CONFIG_DIR="$HOME/.config/jarvis"
echo "[jarvis-install] Creating config dir at $CONFIG_DIR..."
mkdir -p "$CONFIG_DIR"

# ── systemd user services ─────────────────────────────────────────────────────
SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

echo "[jarvis-install] Installing systemd user services..."
# NOTE: service files use %h which is the native systemd home-directory specifier.
# systemd expands it automatically — no sed replacement needed.
# This assumes Jarvis is cloned to ~/jarvis-linux (i.e. %h/jarvis-linux).
for svc in jarvis-backend jarvis-stt jarvis-tts jarvis-wake jarvis-ui; do
  cp "$JARVIS_DIR/scripts/linux/$svc.service" "$SYSTEMD_DIR/$svc.service"
  echo "  → $svc.service"
done

systemctl --user daemon-reload

# Enable but don't start wake yet (wake_service.py created in Plan 2)
for svc in jarvis-backend jarvis-stt jarvis-tts jarvis-ui; do
  systemctl --user enable "$svc"
  echo "  → enabled $svc"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Installation complete."
echo ""
echo " To start Jarvis now:"
echo "   systemctl --user start jarvis-backend"
echo "   systemctl --user start jarvis-stt"
echo "   systemctl --user start jarvis-tts"
echo "   systemctl --user start jarvis-ui"
echo ""
echo " On next login all services start automatically."
echo " Logs: journalctl --user -u jarvis-backend -f"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```

- [ ] **Step 2: Make install.sh executable**

```bash
chmod +x scripts/linux/install.sh
git add scripts/linux/install.sh
```

- [ ] **Step 3: Validate script syntax (no execution needed)**

```bash
bash --noexec scripts/linux/install.sh
```

Expected: no syntax errors, returns exit 0.

- [ ] **Step 4: Verify the sed substitution logic manually**

```bash
HOME=/home/testuser bash -c 'sed "s|%h|$HOME|g" scripts/linux/jarvis-backend.service | grep WorkingDirectory'
```

Expected output:
```
WorkingDirectory=/home/testuser/jarvis-linux/backend
```

- [ ] **Step 5: Commit**

```bash
git add scripts/linux/install.sh
git commit -m "feat(linux): add install.sh bootstrap script for EndeavourOS/Arch"
```

---

### Task 7: Optional — Hyprland window rules

For users running Hyprland, add a config snippet that removes window decorations and keeps Jarvis UI properly layered.

**Files:**
- Create: `scripts/linux/hyprland-jarvis.conf`

- [ ] **Step 1: Create `scripts/linux/hyprland-jarvis.conf`**

```ini
# Jarvis UI window rules for Hyprland
# Source this from ~/.config/hypr/hyprland.conf:
#   source = ~/jarvis-linux/scripts/linux/hyprland-jarvis.conf

# No window decorations (title bar, border) for Jarvis UI
windowrulev2 = noborder, class:^(chromium)$, title:^(Jarvis)$
windowrulev2 = noshadow,  class:^(chromium)$, title:^(Jarvis)$
windowrulev2 = noblur,    class:^(chromium)$, title:^(Jarvis)$

# Keep Jarvis always on top of other windows when AWAKE
windowrulev2 = pin, class:^(chromium)$, title:^(Jarvis)$

# Suppress animations for instant show/hide transitions
windowrulev2 = noanim, class:^(chromium)$, title:^(Jarvis)$
```

- [ ] **Step 2: Add usage note to README.md**

Append to the end of `README.md`:

```markdown

## Linux installation

```bash
git clone https://github.com/YOUR_USER/jarvis-linux.git ~/jarvis-linux
cd ~/jarvis-linux && bash scripts/linux/install.sh
```

**Hyprland users:** add this to `~/.config/hypr/hyprland.conf`:
```
source = ~/jarvis-linux/scripts/linux/hyprland-jarvis.conf
```
```

- [ ] **Step 3: Commit**

```bash
git add scripts/linux/hyprland-jarvis.conf README.md
git commit -m "feat(linux): add Hyprland window rules + README install instructions"
```

---

## Plan complete — check

After all tasks, verify end-state:

```bash
# Backend tests pass
cd backend && npm test

# Frontend tests pass
cd ../frontend && npm test -- --run

# No Electron references remain in frontend/src
grep -r "electronBridge\|ipcRenderer\|ipcMain" frontend/src/
# Expected: no output

# No Electron references remain in root package.json
grep -i "electron" package.json
# Expected: no output

# Systemd service files present
ls scripts/linux/*.service
# Expected: 5 files

# Install script executable
ls -la scripts/linux/install.sh
# Expected: -rwxr-xr-x
```

---

## What comes next

- **Plan 2:** Wake word daemon (`wake_service.py` using openWakeWord) + speaker identity system (OWNER/KNOWN/UNKNOWN modes, auto-enrollment, 50-sample FIFO cap)
- **Plan 3:** UI states (PIP drag mode, VOICE_MUTED state) + two-track response latency (instant ACK map + async function fire)
