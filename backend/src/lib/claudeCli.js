import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, linkSync, copyFileSync, statSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const CLAUDE_CMD = process.platform === 'win32' ? 'claude.cmd' : 'claude'

// Test/offline short-circuit: when JARVIS_FAKE_CLAUDE is set, never spawn the
// real CLI — return a canned reply instantly. Contract tests assert response
// structure, not Claude output, and shouldn't depend on CLI cold-start (~6 s)
// against vitest's 5 s timeout.
const FAKE_CLAUDE = () => !!process['env']['JARVIS_FAKE_CLAUDE']
const FAKE_REPLY = 'respuesta de prueba'

// Claude CLI cold-start with the user's full config dir runs every SessionStart
// hook + skills/plugins/MCP discovery on each spawn — ~24 s for a one-line
// haiku reply, which dominates voice latency. We point the config-dir env var at
// a lean dir (empty settings.json, no hooks/skills/plugins) so startup drops to
// ~6 s. Auth is shared via a hardlink to the real auth file, so OAuth token
// refreshes stay in sync with the user's main config dir.
let leanConfigDir = null
let leanConfigDirMcp = null

// Resolve the absolute path to the Jarvis MCP server. Works in dev
// (backend/mcp-server/jarvis-mcp.js relative to this file) and in the packaged
// EXE (electron-builder extraResources copies backend/ into process.resourcesPath).
function resolveMcpServerPath() {
  // process.resourcesPath is set only inside Electron's main/renderer. The
  // backend currently runs in-process with Electron, so this works at runtime;
  // outside Electron we fall back to the source layout.
  const here = dirname(fileURLToPath(import.meta.url))
  const devPath = resolve(here, '..', '..', 'mcp-server', 'jarvis-mcp.js')
  if (existsSync(devPath)) return devPath
  if (process['resourcesPath']) {
    const exePath = join(process['resourcesPath'], 'backend', 'mcp-server', 'jarvis-mcp.js')
    if (existsSync(exePath)) return exePath
  }
  return devPath
}

// Path to the official @modelcontextprotocol/server-filesystem entry point.
// Installed under backend/mcp-server/node_modules, which electron-builder copies
// whole into the EXE (extraResources filter "mcp-server/**"). Same dev/EXE
// resolution shape as resolveMcpServerPath above.
function resolveFilesystemServerPath() {
  const rel = join('@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js')
  const here = dirname(fileURLToPath(import.meta.url))
  const devPath = resolve(here, '..', '..', 'mcp-server', 'node_modules', rel)
  if (existsSync(devPath)) return devPath
  if (process['resourcesPath']) {
    const exePath = join(process['resourcesPath'], 'backend', 'mcp-server', 'node_modules', rel)
    if (existsSync(exePath)) return exePath
  }
  return existsSync(devPath) ? devPath : ''
}

// The Obsidian vault root, if configured AND it exists on disk. The voice
// session gets DIRECT filesystem access to this dir (read/write/edit/search)
// via the filesystem MCP server below — no HTTP bridge, same primitives a
// normal Claude has over a project. Returns '' when not usable so we simply
// omit the server.
function getVaultDir() {
  const raw = process['env']['JARVIS_OBSIDIAN_VAULT']
  if (!raw || !raw.trim()) return ''
  const dir = raw.trim()
  try {
    return statSync(dir).isDirectory() ? dir : ''
  } catch {
    return ''
  }
}

// Jarvis's own source code, for self-development: the voice session can read and
// edit its own code via the filesystem MCP server. Configured via JARVIS_CODE_DIR
// (e.g. the dev repo C:\proyecto\jarvis-desktop). Returns '' when unset/missing.
export function getCodeDir() {
  const raw = process['env']['JARVIS_CODE_DIR']
  if (!raw || !raw.trim()) return ''
  const dir = raw.trim()
  try {
    return statSync(dir).isDirectory() ? dir : ''
  } catch {
    return ''
  }
}

// Enumerate disk roots granted by JARVIS_ALL_DRIVES=1. Windows: fixed drive
// letters C:\ .. Z:\ (skipping floppy A:/B:). Linux/macOS: the filesystem root.
function listAllDrives() {
  if (process.platform !== 'win32') return ['/']
  const out = []
  for (let c = 67; c <= 90; c++) {        // 'C'..'Z'
    const d = `${String.fromCharCode(c)}:\\`
    try { if (statSync(d).isDirectory()) out.push(d) } catch {}
  }
  return out
}

// Directories the voice session gets full filesystem access to, in priority
// order: the Obsidian vault first (becomes the session CWD / primary MCP root),
// then Jarvis's own source code, then any extra dirs (JARVIS_EXTRA_DIRS, a
// ';'-separated list) and — when JARVIS_ALL_DRIVES=1 — every fixed disk root.
// The first entry is the CWD; the rest are added as extra MCP roots via
// --add-dir (client roots REPLACE the filesystem server's argv dirs, so each
// accessible dir must also be a root). Deduped, existence-checked.
function getFilesystemRoots() {
  const roots = []
  const add = (p) => { if (p && !roots.includes(p)) roots.push(p) }
  add(getVaultDir())
  add(getCodeDir())
  const extra = process['env']['JARVIS_EXTRA_DIRS']
  if (extra) {
    for (const p of extra.split(';').map((s) => s.trim()).filter(Boolean)) {
      try { if (statSync(p).isDirectory()) add(p) } catch {}
    }
  }
  if (process['env']['JARVIS_ALL_DRIVES'] === '1') {
    for (const d of listAllDrives()) add(d)
  }
  return roots
}

function syncAuthToDir(dir) {
  // Keep the lean dir's OAuth credentials in sync with the real Claude config
  // dir, BIDIRECTIONALLY. The CLI refreshes the access token (which expires in
  // ~hours) in whichever dir it runs — and the voice session runs with
  // CLAUDE_CONFIG_DIR = the lean dir, so the lean copy is frequently the NEWER
  // one. The old hardlink/one-way-copy approach clobbered that fresh token with
  // the stale ~/.claude copy, causing recurrent 401s. Now: newest mtime wins,
  // copied either way. No hardlinks — the CLI writes atomically (temp+rename),
  // which breaks hardlinks on the first refresh anyway.
  try {
    const realDir = process['env']['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
    const authName = readdirSync(realDir).find((f) => f.startsWith('.cred'))
    if (!authName) return
    const realAuth = join(realDir, authName)
    const leanAuth = join(dir, authName)
    const realM = existsSync(realAuth) ? statSync(realAuth).mtimeMs : 0
    const leanM = existsSync(leanAuth) ? statSync(leanAuth).mtimeMs : 0
    if (realM === 0 && leanM === 0) return
    if (leanM > realM) {
      // Voice session refreshed the token → propagate back to ~/.claude.
      copyFileSync(leanAuth, realAuth)
    } else if (realM > leanM) {
      // Real dir is newer (e.g. user ran `claude login`) → update the lean copy.
      copyFileSync(realAuth, leanAuth)
    }
  } catch {}
}

// The jarvis MCP server definition, shared by the .mcp.json writer below.
// process.execPath is Electron's binary in production; with ELECTRON_RUN_AS_NODE=1
// it behaves as a plain Node runtime so the MCP stdio server runs correctly.
// In dev (npm run dev backend), execPath is the system node — the env var is
// harmless there.
function jarvisMcpServerDef() {
  return {
    command: process.execPath,
    args: [resolveMcpServerPath()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      JARVIS_BACKEND_URL: 'http://localhost:8788',
    },
  }
}

// Official filesystem MCP server scoped to the vault + code dirs (passed as
// argv). Gives the voice session full, direct file access: read_text_file,
// write_file, edit_file, list_directory, directory_tree, search_files,
// move_file, etc. argv dirs are the fallback for clients that don't advertise
// roots; for the Claude CLI (which does), --add-dir in _spawn supplies the same
// dirs as roots. Returns null when no usable dir or server entry point.
function filesystemMcpServerDef() {
  const roots = getFilesystemRoots()
  if (!roots.length) return null
  const serverPath = resolveFilesystemServerPath()
  if (!serverPath) return null
  return {
    command: process.execPath,
    args: [serverPath, ...roots],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

// Write a project-scoped .mcp.json into the session's CWD. This is the ONLY
// place the Claude CLI actually reads `mcpServers` from — it ignores the
// `mcpServers` block in settings.json entirely. Combined with
// `enableAllProjectMcpServers: true` in the config dir's settings.json, the
// server auto-connects in --print (non-interactive) mode without the
// "pending approval" gate that would otherwise drop it.
function writeMcpProjectJson(cwd) {
  try {
    mkdirSync(cwd, { recursive: true })
    const mcpServers = { jarvis: jarvisMcpServerDef() }
    // Add direct filesystem access to the Obsidian vault when configured.
    const fsDef = filesystemMcpServerDef()
    if (fsDef) mcpServers.filesystem = fsDef
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2), 'utf-8')
  } catch {}
}

function buildLeanConfigDir({ withMcp, dirSuffix }) {
  const realDir = process['env']['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
  const authName = readdirSync(realDir).find((f) => f.startsWith('.cred'))
  if (!authName) return ''
  const dir = join(homedir(), dirSuffix)
  mkdirSync(dir, { recursive: true })
  // NOTE: `mcpServers` does NOT go here — the CLI ignores it in settings.json.
  // The actual server lives in a .mcp.json in the session CWD (writeMcpProjectJson).
  // settings.json only carries enableAllProjectMcpServers so that .mcp.json
  // server auto-approves in non-interactive mode.
  const settings = withMcp ? { enableAllProjectMcpServers: true } : {}
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8')
  syncAuthToDir(dir)
  return dir
}

function ensureLeanConfigDir() {
  if (leanConfigDir !== null) return leanConfigDir || undefined
  try {
    leanConfigDir = buildLeanConfigDir({ withMcp: false, dirSuffix: '.jarvis-claude-cfg' })
    return leanConfigDir || undefined
  } catch {
    leanConfigDir = ''
    return undefined
  }
}

// MCP-enabled variant — used only by the persistent voice session so Claude
// can call tools (timer, chrono, reminders, etc.) natively. one-shot runClaude
// keeps the plain lean dir to preserve its faster cold-start for parsers.
function ensureLeanConfigDirWithMcp() {
  if (leanConfigDirMcp !== null) return leanConfigDirMcp || undefined
  try {
    leanConfigDirMcp = buildLeanConfigDir({ withMcp: true, dirSuffix: '.jarvis-claude-cfg-mcp' })
    return leanConfigDirMcp || undefined
  } catch {
    leanConfigDirMcp = ''
    return undefined
  }
}

/**
 * Spawn Claude CLI with a system prompt file and user message via stdin.
 *
 * @param {string} userMessage
 * @param {object} opts
 * @param {string} opts.systemPromptText
 * @param {number} [opts.timeoutMs=30000]
 * @param {string|null} [opts.conversationContext]
 * @param {string} [opts.model='haiku']
 * @param {string} [opts.fallbackReply='No tengo respuesta en este momento.']
 * @param {string} [opts.namespace='jarvis-turn']
 * @returns {Promise<string>}
 */
export function runClaude(userMessage, opts = {}) {
  const {
    systemPromptText,
    timeoutMs = 30000,
    conversationContext = null,
    model = 'haiku',
    fallbackReply = 'No tengo respuesta en este momento.',
    namespace = 'jarvis-turn',
  } = opts

  if (FAKE_CLAUDE()) return Promise.resolve(FAKE_REPLY)

  const cwd = join(tmpdir(), namespace)
  const promptPath = join(cwd, 'system-prompt.txt')

  try {
    mkdirSync(cwd, { recursive: true })
    writeFileSync(promptPath, systemPromptText, 'utf-8')
  } catch {}

  return new Promise((resolve) => {
    const fullPrompt = conversationContext
      ? `Contexto de conversacion reciente:\n${conversationContext}\n\nUsuario ahora dice: ${userMessage}`
      : userMessage

    const args = ['--print', '--dangerously-skip-permissions', '--model', model, '--system-prompt-file', promptPath]
    const leanDir = ensureLeanConfigDir()
    const childEnv = Object.assign({}, process['env'])
    if (leanDir) childEnv['CLAUDE_CONFIG_DIR'] = leanDir
    // Voice latency: haiku is the fast path (chat, wake, device turns). Extended
    // thinking adds ~2.5 s of dead time before the first token, which is fatal
    // for spoken replies. Disable it for haiku; sonnet/opus (research/science)
    // keep thinking since those are deliberate, slower tasks.
    if (model === 'haiku') childEnv['MAX_THINKING_TOKENS'] = '0'
    const proc = spawn(CLAUDE_CMD, args, {
      cwd,
      env: childEnv,
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { proc.kill() } catch {}
      console.warn(`[${namespace}] timeout after ${timeoutMs}ms`)
      resolve(fallbackReply)
    }, timeoutMs)

    proc.stdout.on('data', (d) => { out += String(d) })
    proc.stderr.on('data', (d) => { err += String(d) })

    try {
      proc.stdin.write(fullPrompt)
      proc.stdin.end()
    } catch {}

    proc.on('close', (code) => {
      clearTimeout(timer)
      const text = out.trim().split('\n').pop()?.trim()
      if (!text) console.warn(`[${namespace}] empty stdout. exit=${code} stderr:`, err.slice(0, 200))
      resolve(text || fallbackReply)
    })

    proc.on('error', (e) => {
      clearTimeout(timer)
      console.warn(`[${namespace}] spawn error:`, e?.message)
      resolve(fallbackReply)
    })
  })
}

// --- Persistent session (reuse one process across turns) ---------------------
// One-shot runClaude pays the ~6 s cold-start on EVERY turn. A persistent
// stream-json process pays it once; later turns are ~1-2 s. The session owns the
// conversation history, so callers send only the new message (+ optional
// per-turn extra context) — no rolling-window injection needed.

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return Math.abs(h)
}

class ClaudeSession {
  constructor(systemPromptText, model) {
    this.model = model
    this.queue = []
    this.current = null
    this.buf = ''
    this.proc = null
    this.alive = false
    // The filesystem MCP server scopes file access to the MCP "roots" the Claude
    // CLI advertises, which it derives from its CWD (+ any --add-dir) — and roots
    // REPLACE the dirs we pass as argv (server-filesystem
    // updateAllowedDirectoriesFromRoots). So the primary accessible dir must BE
    // the CWD; the rest are added as roots via --add-dir in _spawn. Without any
    // configured dir we keep the neutral temp dir.
    this.cwd = getFilesystemRoots()[0] || join(tmpdir(), 'jarvis-session')
    // Always keep the system-prompt scratch file in a temp dir so we never write
    // Jarvis internals into the user's vault. --system-prompt-file takes an
    // absolute path, so it's independent of CWD.
    const scratchDir = join(tmpdir(), 'jarvis-session')
    try { mkdirSync(scratchDir, { recursive: true }) } catch {}
    this.promptPath = join(scratchDir, `system-${hashStr(systemPromptText)}.txt`)
    try { mkdirSync(this.cwd, { recursive: true }); writeFileSync(this.promptPath, systemPromptText, 'utf-8') } catch {}
    this._spawn()
  }

  _spawn() {
    const args = [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages',
      '--dangerously-skip-permissions', '--model', this.model,
      '--system-prompt-file', this.promptPath,
    ]
    // Extra filesystem roots beyond the CWD (e.g. Jarvis's own code dir when the
    // vault is the CWD). The Claude CLI advertises CWD + every --add-dir as MCP
    // roots, which the filesystem server uses as its allowed directories.
    for (const dir of getFilesystemRoots().slice(1)) {
      args.push('--add-dir', dir)
    }
    // The persistent voice session uses the MCP-enabled lean dir so Claude can
    // call tools (timer, chrono, reminders, ...) natively via the Jarvis MCP
    // server. One-shot parsers below keep the plain lean dir for speed.
    const mcpDir = ensureLeanConfigDirWithMcp()
    const leanDir = mcpDir || ensureLeanConfigDir()
    // Sync credentials on every spawn so a renewed OAuth token (common in
    // long-running EXE processes) is picked up without a full restart.
    if (leanDir) syncAuthToDir(leanDir)
    // Write the project-scoped .mcp.json into this session's CWD so the CLI
    // actually loads the jarvis MCP server (it ignores mcpServers in
    // settings.json). Only for the MCP-enabled session.
    if (mcpDir) writeMcpProjectJson(this.cwd)
    const childEnv = Object.assign({}, process['env'])
    if (leanDir) childEnv['CLAUDE_CONFIG_DIR'] = leanDir
    // The persistent voice session needs a SMALL thinking budget so haiku
    // reliably decides to CALL its MCP tools (timer, nav, reminders, ...) instead
    // of just replying conversationally. Thinking=0 made it skip tool calls
    // entirely ("contesta pero no pasa nada"). A small budget restores tool use
    // at ~1s latency instead of the ~2.5s of full thinking. Tuneable via env.
    if (this.model === 'haiku') {
      childEnv['MAX_THINKING_TOKENS'] = process['env']['JARVIS_VOICE_THINKING_TOKENS'] || '2048'
    }
    const proc = spawn(CLAUDE_CMD, args, {
      cwd: this.cwd, env: childEnv, shell: true, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc
    this.alive = true
    this.buf = ''
    proc.stdout.on('data', (d) => this._onData(String(d)))
    proc.stderr.on('data', () => {})
    proc.on('exit', () => this._onExit())
    proc.on('error', () => this._onExit())
  }

  _onExit() {
    this.alive = false
    this.proc = null
    if (this.current) {
      const c = this.current
      this.current = null
      clearTimeout(c.timer)
      c.resolve(c.fallbackReply)
    }
  }

  _onData(chunk) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim()
      this.buf = this.buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      // Incremental text token (from --include-partial-messages). Accumulate and
      // forward to the per-request onText callback so callers can stream
      // sentence-by-sentence to TTS instead of waiting for the full reply.
      if (msg.type === 'stream_event' && this.current) {
        const ev = msg.event
        if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          const t = ev.delta.text || ''
          if (t) {
            this.current.acc = (this.current.acc || '') + t
            if (this.current.onText) { try { this.current.onText(t) } catch {} }
          }
        }
        continue
      }
      if (msg.type === 'result' && this.current) {
        const c = this.current
        this.current = null
        clearTimeout(c.timer)
        const resultText = typeof msg.result === 'string' ? msg.result.trim() : ''
        c.resolve(resultText || (c.acc || '').trim() || c.fallbackReply)
        this._pump()
      }
    }
  }

  ask(message, timeoutMs, fallbackReply, onText = null) {
    return new Promise((resolve) => {
      this.queue.push({ message, timeoutMs, fallbackReply, resolve, timer: null, onText, acc: '' })
      this._pump()
    })
  }

  _pump() {
    if (this.current || !this.queue.length) return
    if (!this.alive) this._spawn()
    const item = this.queue.shift()
    this.current = item
    item.timer = setTimeout(() => {
      if (this.current !== item) return
      this.current = null
      // Kill + respawn: a late reply would desync the next turn's read.
      try { this.proc?.kill() } catch {}
      this.alive = false
      console.warn('[jarvis-session] timeout — respawning')
      item.resolve(item.fallbackReply)
      this._pump()
    }, item.timeoutMs)
    try {
      const payload = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: item.message }] } }
      this.proc.stdin.write(JSON.stringify(payload) + '\n')
    } catch {
      clearTimeout(item.timer)
      this.current = null
      item.resolve(item.fallbackReply)
    }
  }
}

const sessions = new Map()

/**
 * Ask Claude through a persistent per-system-prompt session (reused process).
 * The session keeps conversation history itself, so pass only the new message
 * plus any per-turn extras (NOT the rolling conversation window).
 *
 * @param {string} userMessage
 * @param {object} opts
 * @param {string} opts.systemPromptText
 * @param {number} [opts.timeoutMs=30000]
 * @param {string|null} [opts.extraContext]
 * @param {string} [opts.model='haiku']
 * @param {string} [opts.fallbackReply]
 * @returns {Promise<string>}
 */
export function sessionAsk(userMessage, opts = {}) {
  const {
    systemPromptText,
    timeoutMs = 30000,
    extraContext = null,
    model = 'haiku',
    fallbackReply = 'No tengo respuesta en este momento.',
  } = opts
  if (FAKE_CLAUDE()) return Promise.resolve(FAKE_REPLY)
  const key = `${model}::${hashStr(systemPromptText)}`
  let sess = sessions.get(key)
  if (!sess) { sess = new ClaudeSession(systemPromptText, model); sessions.set(key, sess) }
  const message = extraContext ? `${extraContext}\n\nUsuario: ${userMessage}` : userMessage
  return sess.ask(message, timeoutMs, fallbackReply)
}

/**
 * Like sessionAsk, but invokes onText(deltaString) for each incremental text
 * chunk as Claude generates it (requires --include-partial-messages, already on).
 * Resolves with the full reply at completion. Lets callers stream sentences to
 * TTS so the first spoken word arrives ~1.5 s sooner than buffering the whole
 * reply.
 *
 * @param {string} userMessage
 * @param {object} opts  same shape as sessionAsk
 * @param {(delta: string) => void} onText
 * @returns {Promise<string>}
 */
export function sessionAskStream(userMessage, opts = {}, onText = null) {
  const {
    systemPromptText,
    timeoutMs = 30000,
    extraContext = null,
    model = 'haiku',
    fallbackReply = 'No tengo respuesta en este momento.',
  } = opts
  if (FAKE_CLAUDE()) { if (onText) { try { onText(FAKE_REPLY) } catch {} } return Promise.resolve(FAKE_REPLY) }
  const key = `${model}::${hashStr(systemPromptText)}`
  let sess = sessions.get(key)
  if (!sess) { sess = new ClaudeSession(systemPromptText, model); sessions.set(key, sess) }
  const message = extraContext ? `${extraContext}\n\nUsuario: ${userMessage}` : userMessage
  return sess.ask(message, timeoutMs, fallbackReply, onText)
}

/**
 * Pre-spawn AND prime a session at boot. Spawning alone isn't enough — the
 * first inference still pays cold-start, so the user's first question waited
 * ~2.6 s. Sending a throwaway message at boot pays that during startup; the
 * reply is discarded. After this, turn 1 is as fast as later turns (~1 s).
 * Safe to call repeatedly.
 */
export function warmSession(systemPromptText, model = 'haiku') {
  if (FAKE_CLAUDE()) return
  const key = `${model}::${hashStr(systemPromptText)}`
  if (sessions.has(key)) return
  const sess = new ClaudeSession(systemPromptText, model)
  sessions.set(key, sess)
  // Prime: fire one tiny turn so the cold-start completes now, not on turn 1.
  // Discarded; failures are non-fatal.
  sess.ask('hola', 30000, '').catch(() => {})
}
