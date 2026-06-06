const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, powerSaveBlocker, screen, globalShortcut, shell, dialog } = require('electron')

// Evita que Chromium duerma el renderer cuando la ventana está oculta
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const IS_DEV = !app.isPackaged

let mainWindow = null
let tray = null
let xttsProc = null
let sttProc = null
let backendProc = null
let claudeProc = null

const LOG_BUFFER_MAX = 200
const procLogBuffers = { xtts: [], stt: [], backend: [] }

function forwardProcLog(service, stream, text) {
  const entry = { service, stream, text: String(text), timestamp: Date.now() }
  if (!procLogBuffers[service]) procLogBuffers[service] = []
  procLogBuffers[service].push(entry)
  if (procLogBuffers[service].length > LOG_BUFFER_MAX) procLogBuffers[service].shift()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('proc:log', entry)
  }
}


function getBackendPath() {
  return IS_DEV
    ? path.join(__dirname, '..', 'backend', 'src', 'server.js')
    : path.join(process.resourcesPath, 'backend', 'src', 'server.js')
}

// Locates Python venv + TTS service script. Engine order:
//   1. edge_tts_service.py  (Edge "Read Aloud" — free, internet, smooth)
//   2. xtts_service.py      (local XTTS-v2 voice clone — needs GPU)
//   3. cosyvoice_service.py (CosyVoice 2 — heavier model)
// Override via TTS_ENGINE=edge|xtts|cosyvoice.
function findTtsPaths() {
  const baseDirs = []
  if (IS_DEV) {
    baseDirs.push(path.join(__dirname, '..', 'backend', 'voice', 'python'))
  } else {
    baseDirs.push(path.join(process.resourcesPath, 'backend', 'voice', 'python'))
    baseDirs.push('C:\\proyecto\\jarvis-desktop\\backend\\voice\\python')
  }
  const engineHint = String(process['env']['TTS_ENGINE'] || '').toLowerCase()
  const order = engineHint === 'cosyvoice'
    ? ['cosyvoice_service.py']
    : engineHint === 'xtts'
      ? ['xtts_service.py']
      : engineHint === 'edge'
        ? ['edge_tts_service.py']
        : ['edge_tts_service.py', 'xtts_service.py', 'cosyvoice_service.py']

  for (const dir of baseDirs) {
    const xttsPy = path.join(dir, '.venv', 'Scripts', 'python.exe')
    const cosyPy = path.join(dir, '.venv-cosy', 'Scripts', 'python.exe')
    for (const scriptName of order) {
      const script = path.join(dir, scriptName)
      if (!fs.existsSync(script)) continue
      if (scriptName === 'cosyvoice_service.py') {
        if (!fs.existsSync(cosyPy)) continue
        const modelDir = path.join(dir, 'CosyVoice', 'pretrained_models', 'CosyVoice2-0.5B')
        if (!fs.existsSync(modelDir)) continue
        return { python: cosyPy, script, cwd: dir, engine: 'cosyvoice' }
      }
      if (scriptName === 'edge_tts_service.py') {
        if (!fs.existsSync(xttsPy)) continue
        return { python: xttsPy, script, cwd: dir, engine: 'edge' }
      }
      if (!fs.existsSync(xttsPy)) continue
      return { python: xttsPy, script, cwd: dir, engine: 'xtts' }
    }
  }
  return null
}

function findXttsPaths() { return findTtsPaths() }

function scheduleFillerRender(delayMs) {
  setTimeout(() => {
    try {
      const tts = findTtsPaths()
      if (!tts) {
        console.warn('[fillers] no tts engine; skipping render')
        return
      }
      const script = path.join(tts.cwd, 'render_fillers.py')
      if (!fs.existsSync(script)) {
        console.warn('[fillers] render_fillers.py not found, skipping')
        return
      }
      console.log('[fillers] rendering bridge audios via', tts.engine)
      const proc = spawn(tts.python, [script], {
        cwd: tts.cwd,
        env: Object.assign({}, process['env']),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      proc.stdout.on('data', (d) => { process.stdout.write('[fillers] ' + d); forwardProcLog('fillers', 'stdout', d) })
      proc.stderr.on('data', (d) => { process.stderr.write('[fillers] ' + d); forwardProcLog('fillers', 'stderr', d) })
      proc.on('exit', (code) => { console.log('[fillers] render done code=' + code) })
      proc.on('error', (err) => { console.warn('[fillers] spawn error:', err && err.message) })
    } catch (e) {
      console.warn('[fillers] schedule failed:', e && e.message)
    }
  }, delayMs)
}

function startXttsService() {
  const tts = findTtsPaths()
  if (!tts) {
    console.warn('[tts] no engine available; voice cloning disabled.')
    return
  }
  console.log('[tts:' + tts.engine + '] starting:', tts.python, tts.script)
  xttsProc = spawn(tts.python, [tts.script], {
    cwd: tts.cwd,
    env: Object.assign({}, process['env'], { COQUI_TOS_AGREED: '1' }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tag = 'tts:' + tts.engine
  xttsProc.stdout.on('data', (d) => { process.stdout.write('[' + tag + '] ' + d); forwardProcLog(tag, 'stdout', d) })
  xttsProc.stderr.on('data', (d) => { process.stderr.write('[' + tag + '] ' + d); forwardProcLog(tag, 'stderr', d) })
  xttsProc.on('exit', (code, sig) => {
    console.log('[' + tag + '] exited code=' + code + ' sig=' + sig)
    xttsProc = null
  })
  xttsProc.on('error', (err) => {
    console.warn('[' + tag + '] spawn error:', err && err.message)
    xttsProc = null
  })
}

function stopXttsService() {
  if (xttsProc && !xttsProc.killed) {
    try { xttsProc.kill() } catch {}
  }
  xttsProc = null
}

function startSttService() {
  const xtts = findXttsPaths()
  if (!xtts) {
    console.warn('[stt] venv not found, local STT disabled (browser fallback)')
    return
  }
  const sttScript = path.join(xtts.cwd, 'stt_service.py')
  if (!fs.existsSync(sttScript)) {
    console.warn('[stt] stt_service.py not found, skipping')
    return
  }
  // Speaker samples must always live in the installed resources dir (where Node backend writes)
  const speakerSamplesDir = IS_DEV
    ? path.join(__dirname, '..', 'backend', 'voice', 'samples', 'speaker')
    : path.join(process.resourcesPath, 'backend', 'voice', 'samples', 'speaker')
  console.log('[stt] starting:', xtts.python, sttScript, '| SPEAKER_SAMPLES_DIR=' + speakerSamplesDir)
  sttProc = spawn(xtts.python, [sttScript], {
    cwd: xtts.cwd,
    // HF_HUB_DISABLE_SYMLINKS: copy model files instead of symlinking — Windows
    // without Developer Mode/admin throws WinError 1314 on the symlink step,
    // which aborts the large-v3-turbo download on first GPU boot.
    env: Object.assign({}, process.env, {
      SPEAKER_SAMPLES_DIR: speakerSamplesDir,
      HF_HUB_DISABLE_SYMLINKS: '1',
      HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  sttProc.stdout.on('data', (d) => { process.stdout.write(`[stt] ${d}`); forwardProcLog('stt', 'stdout', d) })
  sttProc.stderr.on('data', (d) => { process.stderr.write(`[stt] ${d}`); forwardProcLog('stt', 'stderr', d) })
  sttProc.on('exit', (code, sig) => {
    console.log('[stt] exited code=' + code + ' sig=' + sig)
    sttProc = null
  })
  sttProc.on('error', (err) => {
    console.warn('[stt] spawn error:', err && err.message)
    sttProc = null
  })
}

function stopSttService() {
  if (sttProc && !sttProc.killed) {
    try { sttProc.kill() } catch {}
  }
  sttProc = null
}

function startBackendService() {
  const backendPath = getBackendPath()
  const speakerDir = IS_DEV
    ? path.join(__dirname, '..', 'backend', 'voice', 'samples', 'speaker')
    : path.join(process.resourcesPath, 'backend', 'voice', 'samples', 'speaker')
  console.log('[backend] starting:', backendPath, '| SPEAKER_SAMPLES_DIR=' + speakerDir)
  backendProc = spawn(process.execPath, [backendPath], {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', SPEAKER_SAMPLES_DIR: speakerDir }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendProc.stdout.on('data', d => { process.stdout.write(`[backend] ${d}`); forwardProcLog('backend', 'stdout', d) })
  backendProc.stderr.on('data', d => { process.stderr.write(`[backend] ${d}`); forwardProcLog('backend', 'stderr', d) })
  backendProc.on('exit', (code, sig) => {
    console.log('[backend] exited code=' + code + ' sig=' + sig)
    backendProc = null
    if (code === 99) {
      console.log('[backend] self-build restart requested, relaunching in 800ms...')
      setTimeout(startBackendService, 800)
    }
  })
  backendProc.on('error', err => {
    console.warn('[backend] spawn error:', err && err.message)
    backendProc = null
  })
}

function stopBackendService() {
  if (backendProc && !backendProc.killed) {
    try { backendProc.kill() } catch {}
  }
  backendProc = null
}

// Obsidian Local REST API plugin only listens while the Obsidian app is
// running. Fire the obsidian:// URI on boot so the user doesn't have to
// remember to open it manually. Obsidian registers itself as the handler
// for that scheme at install time; if it isn't installed, this no-ops.
function autoOpenObsidian() {
  const vaultPath = process['env'].JARVIS_OBSIDIAN_VAULT
  if (!vaultPath) return
  const vaultName = path.basename(vaultPath)
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}`
  shell.openExternal(uri).catch((err) => {
    console.warn('[obsidian] auto-open failed:', err && err.message)
  })
}

function getFrontendPath() {
  return path.join(__dirname, '..', 'frontend', 'dist', 'index.html')
}

function getIconPath() {
  const base = IS_DEV ? path.join(__dirname, 'assets') : path.join(process.resourcesPath, 'electron', 'assets')
  return path.join(base, 'icon.png')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    // Neutral initial size; never shown at this size — the window boots hidden
    // (show:false) and DormantLayer immediately pushes DORMANT, which resizes
    // to a 1×1 off-screen rect. AWAKE later expands to full primary display.
    width: 480,
    height: 320,
    fullscreen: false,
    frame: false,
    transparent: true,
    title: 'Jarvis',
    show: false,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // Voice replies play via Web Audio with no user click to unlock the
      // AudioContext — without this the context stays suspended and TTS is
      // silent even though the WS streamed PCM fine.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // Electron does NOT prompt the user for microphone/camera the way Chrome
  // does — without these handlers, getUserMedia({audio:true}) /
  // getUserMedia({video:true}) silently fails with PermissionDeniedError.
  // We auto-grant for media on the local app since the OS-level prompt
  // already gated install. Other permissions still default-deny.
  const mediaPermissions = new Set(['media', 'audioCapture', 'videoCapture', 'microphone', 'camera'])
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(mediaPermissions.has(permission))
  })
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    return mediaPermissions.has(permission)
  })

  if (IS_DEV) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(getFrontendPath())
  }

  mainWindow.on('close', (e) => {
    e.preventDefault()
    pushBootState('DORMANT')
  })
}

// Apply window geometry/visibility for a given boot state.
function applyBootState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (state === 'DORMANT') {
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
    if (mainWindow.isSimpleFullScreen()) mainWindow.setSimpleFullScreen(false)
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setResizable(false)
    mainWindow.setBounds({ x: -100, y: -100, width: 1, height: 1 })
    mainWindow.setOpacity(0)
    if (!mainWindow.isVisible()) mainWindow.show()
    return
  }

  if (state === 'AWAKE') {
    // Full screen takeover. On Windows, frameless+transparent BrowserWindow
    // is buggy with the OS-native setFullScreen path: the window can land 1-2
    // pixels off the left edge or pick the wrong display when the previous
    // bounds straddled an edge. setSimpleFullScreen is a "draw at given
    // bounds" fullscreen and doesn't toggle the OS fullscreen mode, so it
    // sidesteps those edge cases entirely. We pin to the primary display's
    // full bounds (including taskbar area) so the takeover is total.
    mainWindow.setOpacity(1)
    mainWindow.setResizable(true)
    mainWindow.setAlwaysOnTop(false)
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
    if (mainWindow.isSimpleFullScreen()) mainWindow.setSimpleFullScreen(false)
    const display = screen.getPrimaryDisplay()
    mainWindow.setPosition(display.bounds.x, display.bounds.y)
    mainWindow.setSize(display.bounds.width, display.bounds.height)
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.setSimpleFullScreen(true)
    mainWindow.focus()
  }
}

// Tell the renderer to move to a given state. Renderer will round-trip
// through ipcMain.handle('boot:setState') which calls applyBootState.
function pushBootState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('boot:state', state)
}

// The renderer normally round-trips boot-state changes back to the main process
// to call applyBootState. If the renderer is in a non-DORMANT branch (mobile
// QR, expired, checking) DormantLayer never mounts and that round-trip breaks.
// Calling applyBootState here too ensures the window opens regardless.
function forceBootState(state) {
  pushBootState(state)
  applyBootState(state)
}

function clearRendererStorage() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents
    .executeJavaScript("(() => { try { localStorage.clear(); sessionStorage.clear(); return true } catch (e) { return String(e) } })()")
    .then(() => mainWindow.webContents.reload())
    .catch((err) => console.warn('[storage] clear failed:', err && err.message))
}

function openRendererDevTools() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible()) applyBootState('AWAKE')
  mainWindow.webContents.openDevTools({ mode: 'detach' })
}

function createTray() {
  const iconPath = getIconPath()
  let icon
  try {
    icon = nativeImage.createFromPath(iconPath)
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('Jarvis')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Despertar',              click: () => forceBootState('AWAKE')     },
      { label: 'Despertar ahora',         click: () => forceBootState('AWAKE')     },
      { label: 'Pausar (DORMANT)',        click: () => forceBootState('DORMANT')   },
      { type: 'separator' },
      { label: 'Limpiar sesion movil',    click: () => clearRendererStorage()      },
      { label: 'Abrir DevTools',          click: () => openRendererDevTools()      },
      { type: 'separator' },
      { label: 'Salir', click: () => { if (mainWindow) mainWindow.destroy(); app.quit() } },
    ])
  )
  tray.on('double-click', () => forceBootState('AWAKE'))
}

app.whenReady().then(async () => {
  startBackendService()

  // Voice cloning service (XTTS-v2 or CosyVoice 2). Loads in ~10s; meanwhile
  // any pending TTS calls 502 and the renderer logs but doesn't crash.
  startXttsService()

  // Local STT service (faster-whisper). Runs on CPU alongside TTS on GPU.
  startSttService()

  // Bridge fillers: pre-render short ack WAVs once the TTS sidecar is warm.
  // Runs ~45 s after boot so warmup has finished. If the cache dir already
  // has the WAVs, render_fillers writes new versions over them — cheap, and
  // ensures they always match the active engine's timbre.
  scheduleFillerRender(45000)

  // Open Obsidian so its Local REST API plugin starts listening on 27124.
  autoOpenObsidian()

  createWindow()
  createTray()
  powerSaveBlocker.start('prevent-app-suspension')

  ipcMain.handle('boot:setState', (_, state) => {
    applyBootState(state)
  })

  ipcMain.handle('proc:getServices', () => ({
    xtts: !!xttsProc,
    stt: !!sttProc,
    backend: !!backendProc,
    buffers: procLogBuffers,
  }))

  ipcMain.handle('proc:claudeExec', (_, { prompt }) => {
    if (claudeProc && !claudeProc.killed) {
      return { error: 'Claude ya está procesando' }
    }
    claudeProc = spawn('claude', ['--print', '--model', 'sonnet', prompt], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })
    claudeProc.stdout.on('data', (d) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proc:claudeStream', { stream: 'stdout', text: String(d) })
      }
    })
    claudeProc.stderr.on('data', (d) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proc:claudeStream', { stream: 'stderr', text: String(d) })
      }
    })
    claudeProc.on('exit', () => {
      claudeProc = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proc:claudeStream', { stream: 'done', text: '' })
      }
    })
    claudeProc.on('error', (err) => {
      claudeProc = null
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('proc:claudeStream', { stream: 'error', text: err.message })
      }
    })
    return { ok: true }
  })

  ipcMain.handle('vault:open', async (_, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string') return 'invalid_path'
    return shell.openPath(vaultPath)
  })

  // Mouse virtual (gesto point). Inyecta input real en la ventana vía sendInputEvent —
  // funciona sobre DOM (botones HUD) y canvas R3F (hologramas). Coords en DIP relativos al
  // content; window.innerWidth/Height del renderer ya son DIP, así que el mapeo es directo.
  ipcMain.handle('mouse:move', (_, { x, y }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
  })

  ipcMain.handle('mouse:click', (_, { x, y }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const wc = mainWindow.webContents
    const px = Math.round(x), py = Math.round(y)
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py })
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp',   x: px, y: py, button: 'left', clickCount: 1 })
  })

  // Native OS file/folder picker. Lets the owner point at a file visually
  // instead of dictating a path. Returns { canceled, paths }.
  ipcMain.handle('dialog:pickFile', async (_, opts = {}) => {
    const properties = []
    properties.push(opts.directory ? 'openDirectory' : 'openFile')
    if (opts.multiple) properties.push('multiSelections')
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const res = await dialog.showOpenDialog(parent, {
      title: typeof opts.title === 'string' ? opts.title : 'Selecciona',
      properties,
    })
    return { canceled: res.canceled, paths: res.filePaths || [] }
  })

  // Reveal a file/folder in the OS explorer.
  ipcMain.handle('shell:showInFolder', (_, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p)
  })

  // Silent wake: OS-wide hotkey that opens Jarvis full-screen without sound.
  // Works even when Jarvis isn't the focused window. Default: Ctrl+Alt+J.
  // Override with env JARVIS_WAKE_HOTKEY (e.g. "Super+Space").
  const hotkey = process['env'].JARVIS_WAKE_HOTKEY || 'Control+Alt+J'
  const ok = globalShortcut.register(hotkey, () => forceBootState('AWAKE'))
  if (!ok) console.warn('[hotkey] failed to register', hotkey)
  else console.log('[hotkey] silent wake on', hotkey)

  app.setLoginItemSettings({ openAtLogin: false })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('before-quit', () => {
  stopXttsService()
  stopSttService()
  stopBackendService()
})

app.on('window-all-closed', () => {})

app.on('activate', () => {
  pushBootState('AWAKE')
})
