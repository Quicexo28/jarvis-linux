import { spawn, spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, linkSync, copyFileSync, statSync, readFileSync, watch } from 'fs'
import { tmpdir, homedir } from 'os'
import { randomUUID } from 'crypto'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { kvGet, kvSet } from './turnStore.js'
import { voiceDisallowedTools } from './voiceTools.js'

// Which `claude` binary to spawn. Overridable because the npm-installed one can
// be unusable on a given machine while a different build of the SAME version
// works: 2.1.243's glibc binary segfaults at startup on glibc 2.44 (crash inside
// free() called from __newlocale — nothing to do with Jarvis, `claude --version`
// dies too), and the musl build of the same version runs fine. Pointing this at
// a working binary is how Jarvis stays on a new release instead of pinning an
// old one.
const CLAUDE_CMD = process['env']['JARVIS_CLAUDE_BIN']
  || (process.platform === 'win32' ? 'claude.cmd' : 'claude')

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

// Enumerate fixed Windows drive roots (C:\ .. Z:\), skipping floppy A:/B:.
// Used when JARVIS_ALL_DRIVES=1 to grant the voice session access to every disk.
function listWindowsDrives() {
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
    for (const d of listWindowsDrives()) add(d)
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

// --- Credential reconciliation across config dirs ----------------------------
// Jarvis spawns Claude with CLAUDE_CONFIG_DIR pointed at lean dirs for fast
// cold-start. Each dir holds its OWN .credentials.json with its own OAuth refresh
// token. Anthropic ROTATES the refresh token on every refresh, invalidating the
// previous one — so when the long-lived voice session refreshes its lean-dir
// token, the real ~/.claude token silently dies and the next interactive `claude`
// run forces a re-login. syncAuthToDir only ran at spawn time; the persistent
// session almost never respawns, so the divergence went unhealed for hours.
//
// Fix: watch every config dir's credentials file and propagate the newest copy
// to all others the instant any of them changes. Single source of truth, always.
function authConfigDirs() {
  const real = process['env']['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
  return [
    real,
    join(homedir(), '.jarvis-claude-cfg'),
    join(homedir(), '.jarvis-claude-cfg-mcp'),
  ].filter((d, i, a) => a.indexOf(d) === i)
}

function credFileName() {
  // The CLI may name it .credentials.json (Linux/macOS file store). Discover the
  // actual ".cred*" filename from whichever dir already has one.
  for (const dir of authConfigDirs()) {
    try {
      const name = readdirSync(dir).find((f) => f.startsWith('.cred'))
      if (name) return name
    } catch {}
  }
  return '.credentials.json'
}

// Copy the newest credentials file to every other existing config dir, skipping
// dirs whose copy is already byte-identical (prevents watch ping-pong loops).
function reconcileAuthAllDirs() {
  try {
    const name = credFileName()
    const entries = []
    for (const dir of authConfigDirs()) {
      const p = join(dir, name)
      if (existsSync(p)) entries.push({ dir, p, m: statSync(p).mtimeMs })
    }
    if (entries.length < 2) return
    entries.sort((a, b) => b.m - a.m)
    const newest = entries[0]
    const src = readFileSync(newest.p)
    for (const e of entries.slice(1)) {
      try {
        if (Buffer.compare(src, readFileSync(e.p)) === 0) continue
        copyFileSync(newest.p, e.p)
      } catch {}
    }
  } catch {}
}

let authWatchStarted = false
function startAuthSync() {
  if (authWatchStarted) return
  authWatchStarted = true
  reconcileAuthAllDirs()
  const name = credFileName()
  let timer = null
  const onChange = () => {
    if (timer) clearTimeout(timer)
    // Debounce: the CLI writes via temp+rename, firing several events per update.
    timer = setTimeout(reconcileAuthAllDirs, 300)
  }
  for (const dir of authConfigDirs()) {
    try {
      mkdirSync(dir, { recursive: true })
      // Watch the DIRECTORY (not the file): atomic temp+rename replaces the inode,
      // so a file-level watch would go deaf after the first refresh.
      watch(dir, (_event, fn) => { if (fn === name) onChange() })
    } catch {}
  }
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
// Build the { mcpServers } config object: the Jarvis tools server + (when a
// vault/code dir is configured) direct filesystem access. Shared by the CWD
// .mcp.json writer and the explicit --mcp-config file below.
function buildMcpConfig() {
  const mcpServers = { jarvis: jarvisMcpServerDef() }
  const fsDef = filesystemMcpServerDef()
  if (fsDef) mcpServers.filesystem = fsDef
  return { mcpServers }
}

function writeMcpProjectJson(cwd) {
  try {
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(buildMcpConfig(), null, 2), 'utf-8')
  } catch {}
}

// Write the MCP config to a stable absolute path and return it, for passing to
// the CLI via --mcp-config. This is the RELIABLE way to load MCP servers in
// non-interactive --print mode: the older CWD-.mcp.json + enableAllProjectMcpServers
// path stopped connecting on Claude CLI 2.1.216 (persistent voice sessions came
// up with ZERO MCP tools — verified: no mcp child procs — so the voice brain
// reported the 3D viewer, timers, nav, etc. all as "no disponible"). An explicit
// --mcp-config file is honored deterministically, independent of project-trust.
function writeMcpConfigFile() {
  const cfgPath = join(tmpdir(), 'jarvis-session', 'mcp-config.json')
  mkdirSync(dirname(cfgPath), { recursive: true })
  writeFileSync(cfgPath, JSON.stringify(buildMcpConfig(), null, 2), 'utf-8')
  return cfgPath
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
    startAuthSync()
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
    startAuthSync()
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
    multiline = false,
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
      // Default keeps the historical behavior: take the LAST line, which drops
      // any CLI noise printed before a one-line answer. Callers whose answer is
      // itself multi-line (JSON blocks, lists) must pass multiline:true or they
      // silently receive only the final character line — e.g. a pretty-printed
      // array arrived as "]".
      const text = multiline ? out.trim() : out.trim().split('\n').pop()?.trim()
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

// Session continuity is opt-out: JARVIS_SESSION_RESUME=0 restores the old
// behavior (every respawn starts a blank conversation).
const SESSION_RESUME = () => process['env']['JARVIS_SESSION_RESUME'] !== '0'
// Auto-compaction window for the long-lived voice sessions. The CLI compacts
// its own history instead of growing until the context blows up. 'auto' lets
// the CLI pick; a token count (100k–1M) pins it.
const SESSION_AUTOCOMPACT = () => process['env']['JARVIS_SESSION_AUTOCOMPACT'] || 'auto'

// Does the `claude` on this machine understand a given flag? The binary is NOT
// pinned to the code: the service PATH resolves one install (/usr/bin/claude ->
// /opt, frozen with DISABLE_UPDATES=1) while an interactive shell may resolve a
// much newer one, and JARVIS_CLAUDE_BIN can point anywhere. Passing a flag the
// binary never heard of is FATAL: commander aborts before the session starts,
// the CLI dies ~350 ms in, every turn falls back to "no tengo respuesta", and
// (worse, silently) the <5 s death trips the resumeBroken path, so the session
// id rotates and the conversation is lost on each boot. `--autocompact` did
// exactly that against 2.1.220. One cached `--help` (~230 ms, paid once at
// warmup) buys immunity in BOTH directions -- older or newer binary.
const flagSupport = new Map()
function cliSupportsFlag(flag) {
  if (flagSupport.has(flag)) return flagSupport.get(flag)
  let ok = false
  try {
    const r = spawnSync(CLAUDE_CMD, ['--help'], { encoding: 'utf-8', timeout: 15000 })
    const help = `${r.stdout || ''}${r.stderr || ''}`
    // No output at all means the probe itself failed (missing binary, timeout).
    // Treat that as "unknown" rather than caching a false negative forever.
    if (!help.trim()) { console.warn(`[jarvis-session] flag probe got no output from ${CLAUDE_CMD}`); return false }
    ok = help.includes(flag)
    if (!ok) console.warn(`[jarvis-session] ${CLAUDE_CMD} does not support ${flag} — omitting it`)
  } catch (e) {
    console.warn(`[jarvis-session] flag probe failed for ${flag}: ${e?.message || e}`)
    return false
  }
  flagSupport.set(flag, ok)
  return ok
}

/**
 * Recover a previously used session UUID.
 * `restored` distinguishes "this transcript already exists on disk, RESUME it"
 * from "brand new, CLAIM it with --session-id". Getting that backwards is what
 * made the conversation survive a CLI crash but not a backend restart: a fresh
 * process would re-claim the saved id as if it were new.
 * @returns {{id: string, restored: boolean}}
 */
function restoreSessionId(sessionKey) {
  if (!sessionKey || !SESSION_RESUME()) return { id: randomUUID(), restored: false }
  try {
    const saved = kvGet(`session:${sessionKey}`)
    if (saved) return { id: saved, restored: true }
  } catch {}
  const fresh = randomUUID()
  try { kvSet(`session:${sessionKey}`, fresh) } catch {}
  return { id: fresh, restored: false }
}

function persistSessionId(sessionKey, id) {
  if (!sessionKey || !id) return
  try { kvSet(`session:${sessionKey}`, id) } catch {}
}

class ClaudeSession {
  constructor(systemPromptText, model, sessionKey = '') {
    this.model = model
    this.queue = []
    this.current = null
    this.buf = ''
    this.proc = null
    this.alive = false
    // Conversation continuity across process death. The CLI owns the history,
    // so before this a crashed/killed session respawned EMPTY and silently —
    // Jarvis just started forgetting mid-conversation with nothing in the log.
    // We pin a stable UUID with --session-id on first spawn and --resume it
    // afterwards, so the transcript survives the process. The id is persisted
    // so it also survives a backend restart.
    this.sessionKey = sessionKey
    const restored = restoreSessionId(sessionKey)
    this.sessionId = restored.id
    // A restored id already has a transcript on disk, so the very first spawn
    // must RESUME rather than claim it.
    this.hasSpawned = restored.restored
    this.resumeBroken = false
    this.spawnedAt = 0
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
    // Pin the conversation to a stable id. FIRST spawn claims it with
    // --session-id; every later spawn RESUMES it, so a killed/crashed CLI comes
    // back knowing what was already said instead of silently starting over.
    // Verified end-to-end: a fact stated in one process is recalled by a fresh
    // process resuming the same id. If a resume ever fails (corrupt or pruned
    // transcript), resumeBroken flips and we fall back to a clean session.
    if (SESSION_RESUME()) {
      if (this.hasSpawned && !this.resumeBroken) args.push('--resume', this.sessionId)
      else args.push('--session-id', this.sessionId)
      // Bound the transcript so a session that lives for days compacts itself
      // instead of growing until it blows the context window. Only if the
      // installed CLI knows the flag — an unknown one kills the session outright.
      if (cliSupportsFlag('--autocompact')) args.push('--autocompact', SESSION_AUTOCOMPACT())
    }
    this.hasSpawned = true
    this.spawnedAt = Date.now()
    // What the voice session may NOT touch — built-ins that bypass the risk gate
    // plus MCP tools that belong to Claude Code, not to a spoken turn. The list
    // and the reason for each entry live in lib/voiceTools.js, next to the drift
    // guard that keeps it in sync with the system prompt.
    const disallowed = voiceDisallowedTools()
    if (disallowed) args.push('--disallowedTools', disallowed)

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
    // Load the jarvis + filesystem MCP servers EXPLICITLY via --mcp-config +
    // --strict-mcp-config. The legacy CWD-.mcp.json + enableAllProjectMcpServers
    // approach silently loaded ZERO servers on CLI 2.1.216 in --print mode, so
    // the voice brain had no tools ("el visor 3D no está disponible"). --strict
    // means ONLY these servers load (the lean config dir has no others). Falls
    // back to the CWD .mcp.json if writing the config file fails.
    if (mcpDir) {
      try {
        const cfgPath = writeMcpConfigFile()
        args.push('--mcp-config', cfgPath, '--strict-mcp-config')
      } catch {
        writeMcpProjectJson(this.cwd)
      }
    }
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
    // Keep the tail of stderr. It used to be dropped entirely, which meant an
    // exiting session left NO explanation anywhere — the only symptom was Jarvis
    // quietly losing the conversation.
    this.errTail = ''
    proc.stderr.on('data', (d) => { this.errTail = (this.errTail + String(d)).slice(-600) })
    proc.on('exit', () => this._onExit())
    proc.on('error', () => this._onExit())
  }

  _onExit() {
    this.alive = false
    this.proc = null
    // A resume that dies almost immediately means the transcript is unusable
    // (pruned, corrupt, or written by an incompatible CLI). Retrying it forever
    // would leave the voice permanently broken, so give up on resuming ONCE and
    // continue with a fresh session id.
    const upMs = Date.now() - this.spawnedAt
    if (SESSION_RESUME() && !this.resumeBroken && upMs < 5000) {
      this.resumeBroken = true
      this.sessionId = randomUUID()
      persistSessionId(this.sessionKey, this.sessionId)
      console.warn(
        `[jarvis-session] ${this.model} died ${upMs}ms after spawn — new session id.` +
        (this.errTail ? ` stderr: ${this.errTail.trim().slice(-300)}` : ' (no stderr)')
      )
    } else if (upMs < 60000) {
      console.warn(`[jarvis-session] ${this.model} exited after ${upMs}ms` +
        (this.errTail ? ` — stderr: ${this.errTail.trim().slice(-300)}` : ''))
    }
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
      // Which tools the model actually called this turn, and which of them
      // FAILED. Both were invisible before: the turn only ever surfaced the
      // spoken text, so "said it did it but didn't" was indistinguishable from
      // "did it" without reading journald by hand.
      if (msg.type === 'assistant' && this.current) {
        const blocks = msg.message?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool_use' && b.name) {
              this.current.tools.push(b.name)
              // The INPUT is what makes a postcondition checkable: knowing
              // open_view ran says nothing, knowing it ran with {view:'plan3d'}
              // lets us ask the renderer whether plan3d is actually on screen.
              this.current.toolCalls.push({ name: b.name, input: b.input ?? null })
              if (b.id) this.current.toolNames.set(b.id, b.name)
            }
          }
        }
        continue
      }
      if (msg.type === 'user' && this.current) {
        const blocks = msg.message?.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool_result' && b.is_error) {
              const name = this.current.toolNames.get(b.tool_use_id) || 'unknown'
              const detail = typeof b.content === 'string'
                ? b.content
                : JSON.stringify(b.content ?? '')
              this.current.toolErrors.push(`${name}: ${String(detail).slice(0, 200)}`)
            }
          }
        }
        continue
      }
      if (msg.type === 'result' && this.current) {
        const c = this.current
        this.current = null
        clearTimeout(c.timer)
        const resultText = typeof msg.result === 'string' ? msg.result.trim() : ''
        // The CLI reports the real session id it used (a resume can hand back a
        // different one after a fork); persist it so the NEXT spawn resumes the
        // conversation that actually exists.
        if (msg.session_id && msg.session_id !== this.sessionId) {
          this.sessionId = msg.session_id
        }
        persistSessionId(this.sessionKey, this.sessionId)
        if (c.onMeta) {
          const u = msg.usage || {}
          try {
            c.onMeta({
              sessionId: this.sessionId,
              model: this.model,
              tools: c.tools,
              toolCalls: c.toolCalls,
              toolErrors: c.toolErrors,
              isError: !!msg.is_error,
              costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
              durationMs: msg.duration_ms ?? null,
              ttftMs: msg.ttft_ms ?? null,
              numTurns: msg.num_turns ?? null,
              inTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
                        (u.cache_creation_input_tokens ?? 0),
              outTokens: u.output_tokens ?? 0,
            })
          } catch {}
        }
        c.resolve(resultText || (c.acc || '').trim() || c.fallbackReply)
        this._pump()
      }
    }
  }

  ask(message, timeoutMs, fallbackReply, onText = null, onMeta = null) {
    return new Promise((resolve) => {
      this.queue.push({
        message, timeoutMs, fallbackReply, resolve, timer: null, onText, onMeta,
        acc: '', tools: [], toolCalls: [], toolErrors: [], toolNames: new Map(),
      })
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
      if (item.onMeta) {
        try {
          item.onMeta({
            sessionId: this.sessionId, model: this.model, tools: item.tools,
            toolErrors: item.toolErrors, isError: true, error: `timeout after ${item.timeoutMs}ms`,
          })
        } catch {}
      }
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
  if (!sess) { sess = new ClaudeSession(systemPromptText, model, key); sessions.set(key, sess) }
  const message = extraContext ? `${extraContext}\n\nUsuario: ${userMessage}` : userMessage
  return sess.ask(message, timeoutMs, fallbackReply, null, opts.onMeta ?? null)
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
  if (!sess) { sess = new ClaudeSession(systemPromptText, model, key); sessions.set(key, sess) }
  const message = extraContext ? `${extraContext}\n\nUsuario: ${userMessage}` : userMessage
  return sess.ask(message, timeoutMs, fallbackReply, onText, opts.onMeta ?? null)
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
  const sess = new ClaudeSession(systemPromptText, model, key)
  sessions.set(key, sess)
  // Prime: fire one tiny turn so the cold-start completes now, not on turn 1.
  // Discarded; failures are non-fatal.
  sess.ask('hola', 30000, '').catch(() => {})
}
