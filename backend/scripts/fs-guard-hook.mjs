#!/usr/bin/env node
/**
 * PreToolUse hook for the VOICE session: no writing into Jarvis's own repo
 * through the filesystem MCP server.
 *
 * The voice brain needs write access to the Obsidian vault (tasks, notes), and
 * the filesystem server cannot be write-scoped per root — so the same tools
 * that write a daily note could also rewrite backend/src, with no checkpoint,
 * no tests, and no risk gate (that gate only sees the jarvis MCP server's HTTP
 * calls), even in a turn that just read a web page. Self-modification goes
 * through code_task. Exit 2 blocks the call and the reason reaches the model.
 *
 * Input: the hook JSON on stdin ({ tool_name, tool_input, cwd }).
 */
import { realpathSync, existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

function real(p) {
  // The target may not exist yet (write_file creates it): resolve its nearest
  // existing ancestor so symlinks (~/jarvis-linux -> the repo) can't sneak by.
  let cur = p
  const tail = []
  while (!existsSync(cur) && dirname(cur) !== cur) { tail.unshift(cur.slice(dirname(cur).length + 1)); cur = dirname(cur) }
  try { return resolve(realpathSync(cur), ...tail) } catch { return p }
}

function inside(child, parent) {
  return child === parent || child.startsWith(parent + sep)
}

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let input
  try { input = JSON.parse(raw) } catch { process.exit(0) }
  const codeDir = process.env.JARVIS_CODE_DIR
  if (!codeDir) process.exit(0)
  const repo = real(resolve(codeDir))
  const args = input?.tool_input || {}
  const targets = [args.path, args.source, args.destination].filter((p) => typeof p === 'string' && p)
  for (const t of targets) {
    if (inside(real(resolve(input?.cwd || process.cwd(), t)), repo)) {
      process.stderr.write(
        'Bloqueado: el código propio de Jarvis no se escribe con herramientas de archivos. ' +
        'Para cambiarlo usa code_task (hace checkpoint, corre los tests y aplica).\n',
      )
      process.exit(2)
    }
  }
  process.exit(0)
})
