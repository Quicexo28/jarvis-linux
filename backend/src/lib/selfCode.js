/**
 * Self-coding primitives — let the Jarvis voice session act as a real coding
 * agent over its OWN source: run shell commands, take git checkpoints, roll
 * back, and request a backend restart to apply changes.
 *
 * Pairs with the filesystem MCP server (read_text_file/write_file/edit_file),
 * which already gives the session file access scoped to JARVIS_CODE_DIR. This
 * module adds the missing executor loop (test/build/git/restart).
 *
 * SECURITY: by the owner's explicit choice, runCommand executes ARBITRARY shell
 * commands with no allowlist. It is reachable only through the MCP tool bridge,
 * which is OWNER-gated upstream. Output is captured and size/time-bounded.
 */

import { exec } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { getCodeDir } from './claudeCli.js'

const __dir = dirname(fileURLToPath(import.meta.url))
// backend/src/lib -> repo root is three levels up.
const REPO_ROOT = resolve(__dir, '..', '..', '..')

const MAX_OUTPUT = 20_000        // chars per stream returned to the model
const DEFAULT_TIMEOUT = 120_000  // 2 min
const MAX_TIMEOUT = 600_000      // 10 min

// Last checkpoint commit sha, so code_rollback works with no explicit sha.
let lastCheckpointSha = null

/** Resolve the working dir for self-coding: explicit arg -> code dir -> repo root. */
function resolveCwd(cwd) {
  if (cwd && existsSync(cwd)) return cwd
  const code = getCodeDir()
  if (code && existsSync(code)) return code
  return REPO_ROOT
}

function clip(s) {
  s = String(s ?? '')
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...(salida truncada)' : s
}

/**
 * Run an arbitrary shell command and capture its result.
 * @returns {Promise<{ok, exitCode, stdout, stderr, timedOut, cwd, command}>}
 */
export function runCommand({ command, cwd, timeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const cmd = String(command ?? '').trim()
    if (!cmd) {
      resolvePromise({ ok: false, error: 'empty_command' })
      return
    }
    const workdir = resolveCwd(cwd)
    const timeout = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT, MAX_TIMEOUT)
    exec(cmd, {
      cwd: workdir,
      timeout,
      maxBuffer: 1024 * 1024 * 16,
      env: process.env,
    }, (err, stdout, stderr) => {
      const timedOut = !!(err && err.killed && err.signal === 'SIGTERM')
      const exitCode = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0)
      resolvePromise({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        stdout: clip(stdout),
        stderr: clip(stderr),
        cwd: workdir,
        command: cmd,
      })
    })
  })
}

/** Promise wrapper around exec that resolves the raw result (never rejects). */
function git(args, cwd) {
  return runCommand({ command: `git ${args}`, cwd, timeoutMs: 60_000 })
}

/**
 * Commit the current working-tree state as a restore point BEFORE self-editing.
 * Returns the checkpoint sha so a later rollback can reset to it.
 */
export async function gitCheckpoint({ message } = {}) {
  const cwd = resolveCwd()
  const inside = await git('rev-parse --is-inside-work-tree', cwd)
  if (!inside.ok) return { ok: false, error: 'not_a_git_repo', cwd }

  const label = `jarvis-checkpoint: ${message || 'auto'} (${new Date().toISOString()})`
  await git('add -A', cwd)
  const commit = await git(`commit --allow-empty -m "${label.replace(/"/g, "'")}"`, cwd)
  if (!commit.ok) return { ok: false, error: 'commit_failed', detail: commit.stderr || commit.stdout, cwd }

  const head = await git('rev-parse HEAD', cwd)
  const sha = (head.stdout || '').trim()
  lastCheckpointSha = sha || lastCheckpointSha
  return { ok: true, sha, branch: await currentBranch(cwd), cwd }
}

async function currentBranch(cwd) {
  const b = await git('rev-parse --abbrev-ref HEAD', cwd)
  return (b.stdout || '').trim() || null
}

/**
 * Hard-reset the working tree back to a checkpoint. With no sha, uses the last
 * checkpoint taken this session. DESTRUCTIVE: discards uncommitted changes made
 * after the checkpoint — which is exactly the rollback intent.
 */
export async function gitRollback({ sha } = {}) {
  const cwd = resolveCwd()
  const target = (sha || lastCheckpointSha || '').trim()
  if (!target) return { ok: false, error: 'no_checkpoint', detail: 'No hay punto de control para revertir.' }
  const reset = await git(`reset --hard ${target}`, cwd)
  if (!reset.ok) return { ok: false, error: 'reset_failed', detail: reset.stderr || reset.stdout, cwd }
  return { ok: true, restoredTo: target, cwd }
}

/**
 * Apply backend code changes by exiting with code 99. Systemd service must be
 * configured with Restart=on-failure to pick this up as a restart signal.
 * Caller MUST send its HTTP response before this fires.
 */
export function scheduleRestart(delayMs = 600) {
  setTimeout(() => {
    console.log('[self-code] backend restart requested (exit 99)')
    process.exit(99)
  }, delayMs)
}
