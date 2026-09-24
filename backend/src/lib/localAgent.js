/**
 * The laptop as one more machine.
 *
 * The distributed-agents fleet only knows machines that connect a Rust agent to
 * the hub — which excludes the laptop the hub itself runs on. The remote app
 * listing "main" but not the machine hosting Jarvis is confusing, so the backend
 * answers for itself: this module implements the same read-only ops
 * (`sys_info`, `list_processes`, `search`) in Node and returns them in the
 * protocol's `OpResult` shape, so callers cannot tell local from remote.
 *
 * No exec / read_file / write_file here on purpose: running code on the laptop
 * already has its own gated routes (system terminal, code/*), all local-only.
 */
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { env } from 'node:process'
import { execCmd } from './exec.js'

/** Ops this module can serve. Anything else belongs to a real agent. */
export const LOCAL_OPS = new Set(['sys_info', 'list_processes', 'search'])

const CPU_SAMPLE_MS = 200
const SEARCH_DEFAULT_MAX = 25
const SEARCH_TIME_BUDGET_MS = 4000
/** Directories that are all noise in a "find my file" search. */
const SEARCH_SKIP = new Set([
  'node_modules', '.git', '.cache', '.venv', 'venv', '__pycache__',
  'target', 'dist', 'build', '.local', '.npm', '.cargo', '.rustup',
])

/** Logical name the UI addresses this machine by. */
export function localMachineName() {
  return env.JARVIS_LOCAL_MACHINE || os.hostname()
}

/**
 * Listing entry mirroring a hub machine, flagged so the UI can label it.
 * `name` stays the hostname because it is the address ops are sent to; `label`
 * is what a person reads — the app is used from a tablet, where "this PC" would
 * name the wrong machine.
 */
export function localMachineEntry() {
  return {
    name: localMachineName(),
    label: env.JARVIS_LOCAL_LABEL || 'Jarvis Main',
    os: 'Linux',
    agent_version: null,
    capabilities: ['SysInfo', 'Processes', 'Search'],
    online: true,
    local: true,
  }
}

/** Route one op locally. Returns a protocol OpResult (never throws). */
export async function localOp(op) {
  try {
    switch (op?.op) {
      case 'sys_info':      return await localSysInfo()
      case 'list_processes': return await localProcesses()
      case 'search':        return await localSearch(op.params ?? {})
      default:
        return { status: 'error', message: `op '${op?.op}' no disponible en el portátil`, denied: true }
    }
  } catch (e) {
    return { status: 'error', message: e.message, denied: false }
  }
}

/* ----- sys_info ----- */

/** Aggregate jiffies from /proc/stat's first line: [busy, total]. */
function parseProcStat(text) {
  const line = text.split('\n', 1)[0]
  const parts = line.trim().split(/\s+/).slice(1).map(Number)
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0) // idle + iowait
  return { busy: total - idle, total }
}

/**
 * CPU load over a short window. Like sysinfo on the Rust side, this is a delta
 * between two samples — a single reading of /proc/stat is uptime-averaged and
 * says nothing about now.
 */
async function cpuPercent() {
  const a = parseProcStat(await fs.readFile('/proc/stat', 'utf8'))
  await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS))
  const b = parseProcStat(await fs.readFile('/proc/stat', 'utf8'))
  const dTotal = b.total - a.total
  if (dTotal <= 0) return 0
  return Math.max(0, Math.min(100, ((b.busy - a.busy) / dTotal) * 100))
}

/**
 * Used memory the way a person means it: total minus MemAvailable. `os.freemem()`
 * excludes reclaimable page cache, so it would report a nearly-full machine.
 */
async function memoryMb() {
  const total = Math.round(os.totalmem() / 1048576)
  try {
    const meminfo = await fs.readFile('/proc/meminfo', 'utf8')
    const avail = /MemAvailable:\s+(\d+) kB/.exec(meminfo)
    if (avail) return { used: total - Math.round(Number(avail[1]) / 1024), total }
  } catch {}
  return { used: Math.round((os.totalmem() - os.freemem()) / 1048576), total }
}

async function diskGb() {
  try {
    const s = await fs.statfs('/')
    const total = s.blocks * s.bsize
    const avail = s.bavail * s.bsize
    return { used: Math.round((total - avail) / 1073741824), total: Math.round(total / 1073741824) }
  } catch {
    return { used: 0, total: 0 }
  }
}

async function localSysInfo() {
  const [cpu, mem, disk] = await Promise.all([cpuPercent(), memoryMb(), diskGb()])
  return {
    status: 'sys_info',
    cpu_percent: +cpu.toFixed(1),
    mem_used_mb: mem.used,
    mem_total_mb: mem.total,
    disk_used_gb: disk.used,
    disk_total_gb: disk.total,
    uptime_secs: Math.round(os.uptime()),
    hostname: os.hostname(),
  }
}

/* ----- list_processes ----- */

/** Exported for unit tests: parse `ps -eo pid=,rss=,pcpu=,comm=` output. */
export function parsePs(text) {
  const procs = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    procs.push({
      pid: Number(m[1]),
      name: m[4],
      cpu_percent: Number(m[3]),
      mem_mb: Math.round(Number(m[2]) / 1024),
    })
  }
  procs.sort((a, b) => b.mem_mb - a.mem_mb)
  return procs.slice(0, 50)
}

async function localProcesses() {
  const out = await execCmd('ps -eo pid=,rss=,pcpu=,comm= --sort=-rss')
  return { status: 'processes', processes: parsePs(out ?? '') }
}

/* ----- search ----- */

/**
 * Breadth-first name search under `root` (home by default), bounded by result
 * count AND wall clock: the phone is waiting on this, and an unbounded walk of
 * a home directory is not a search, it's a hang.
 */
async function localSearch({ query = '', root = null, max_results: maxResults = SEARCH_DEFAULT_MAX } = {}) {
  const needle = String(query).toLowerCase()
  const start = root?.raw ?? root ?? os.homedir()
  const cap = Math.max(1, Math.min(Number(maxResults) || SEARCH_DEFAULT_MAX, 200))
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS
  const hits = []
  const queue = [start]

  while (queue.length && hits.length < cap && Date.now() < deadline) {
    const dir = queue.shift()
    let entries = []
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (hits.length >= cap) break
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SEARCH_SKIP.has(e.name)) queue.push(full)
      }
      if (!needle || e.name.toLowerCase().includes(needle)) {
        let size = null
        try { if (e.isFile()) size = (await fs.stat(full)).size } catch {}
        hits.push({ path: { raw: full, os: 'Linux' }, size_bytes: size, is_dir: e.isDirectory() })
      }
    }
  }
  return { status: 'search', hits }
}
