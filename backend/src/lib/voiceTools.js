/**
 * Tool surface of the VOICE session.
 *
 * The voice brain runs on haiku with ~70 MCP tools plus every built-in the CLI
 * ships. Two separate problems come from that:
 *
 *  1. Safety. The CLI's built-in Bash/Write/Edit bypass the risk gate entirely
 *     (lib/toolRisk.js only sees HTTP calls made by the MCP server), so a voice
 *     turn could run shell as the user — verified before this existed. And some
 *     MCP tools exist for Claude Code working ON the repo, not for a voice turn:
 *     arbitrary exec and file writes on OTHER machines, restarting the backend.
 *  2. Selection. A flat list of seventy near-synonymous names is a worse menu
 *     for a small fast model than a short one.
 *
 * This module is the single place that decides what the voice session may NOT
 * touch, with a reason per entry, plus a drift guard: nothing the system prompt
 * tells the model to call may appear here. That check is a test, because the two
 * lists live in different files and will otherwise diverge silently — the model
 * would be instructed to use a tool that no longer exists and would improvise.
 *
 * Override wholesale with JARVIS_VOICE_DISALLOWED_TOOLS.
 */

/**
 * CLI built-ins. Kept OUT: WebSearch/WebFetch (real capability the voice brain
 * uses), and the filesystem MCP server, which is scoped to the vault + code
 * roots and does go through a gate.
 */
export const DENIED_BUILTINS = {
  Bash: 'shell arbitrario como el usuario, esquiva por completo el gate de riesgo',
  Write: 'escritura fuera de las raíces del MCP de ficheros',
  Edit: 'edición fuera de las raíces del MCP de ficheros',
  NotebookEdit: 'mismo motivo que Edit',
  Task: 'un turno de voz lanzando subagentes es un multiplicador de coste sin techo',
  KillShell: 'sin Bash no hay shell que matar',
  BashOutput: 'sin Bash no hay salida que leer',
}

/**
 * MCP tools that exist for Claude Code operating on the repo/fleet, not for a
 * spoken turn. Each is ALSO gated server-side by lib/toolRisk.js; denying them
 * here is defense in depth and shortens the menu.
 *
 * Deliberately NOT here: run_terminal, system_power, system_process, launch_app,
 * code_task, code_run and code_rollback. The system prompt documents all of
 * them, the owner chose to have them, and they are classified destructive so the
 * risk gate demands a fresh owner match.
 */
export const DENIED_MCP = {
  remote_exec: 'ejecución arbitraria en OTRA máquina; la voz tiene sysinfo/search/wake para lo que necesita',
  remote_write_file: 'escritura arbitraria en otra máquina',
  remote_read_file: 'lectura arbitraria en otra máquina',
  code_restart: 'reiniciar el backend a mitad de un turno mata el propio turno; lo hace applyChanges al final de un job',
  code_checkpoint: 'commit del árbol entero; es una herramienta de mantenimiento, no de conversación',
}

const MCP_PREFIX = 'mcp__jarvis__'

/**
 * The value for --disallowedTools. Env override wins wholesale so a live system
 * can be widened or narrowed without a deploy.
 * @returns {string} comma-separated list, '' to disable the restriction
 */
export function voiceDisallowedTools() {
  const override = process['env']['JARVIS_VOICE_DISALLOWED_TOOLS']
  if (override !== undefined) return override.trim()
  return [
    ...Object.keys(DENIED_BUILTINS),
    ...Object.keys(DENIED_MCP).map((t) => `${MCP_PREFIX}${t}`),
  ].join(',')
}

/** Every denied name, bare (no MCP prefix) — for the drift guard. */
export function deniedBareNames() {
  return [...Object.keys(DENIED_BUILTINS), ...Object.keys(DENIED_MCP)]
}
