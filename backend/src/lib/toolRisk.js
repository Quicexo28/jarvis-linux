/**
 * Risk-based authorization for MODEL tool calls.
 *
 * The permission model used to be a static list of intent tags
 * (`LIMITED_INTENTS` in speakerContext.js) checked ONCE, before the Claude turn.
 * After that gate the model could call any of the ~70 MCP tools, so an intent
 * classified "chat" could still end up running `code_task`, `system_power` or a
 * remote `exec` on another machine. The only real barrier for the worst actions
 * was a sentence in the system prompt asking the model to confirm first — a
 * prompt is not a permission.
 *
 * This classifies every backend route the tools reach by RISK and enforces a
 * policy per speaker mode at the single dispatch choke point.
 *
 *   read        — observing state. Anyone, including an unrecognised voice.
 *   write       — changes something recoverable (timers, views, notes, lights).
 *   destructive — hard or impossible to undo, or reaches outside this machine:
 *                 own source code, power, remote agents, PC input injection,
 *                 unlocking the vault.
 *
 * IMPORTANT — only requests marked `X-Jarvis-Origin: model` are gated. The GUI,
 * the phone companion and the tablet hit these same routes, and the speaker mode
 * is a singleton describing whoever spoke LAST; applying it to UI traffic would
 * block the user's own clicks based on an unrelated stale voice turn.
 *
 * This composes with, and does not replace, the two existing barriers:
 * `webAuth`'s local-only DANGEROUS_PATHS (WHERE a request comes from) and each
 * handler's own confirmation flow (e.g. system/power needs confirm:true).
 * This one answers WHO.
 */

import { getSpeakerMode, getSpeakerName } from './speakerContext.js'
import { getLastInteractionAgo } from './attentionState.js'

export const RISK = { READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive' }

// Exact paths first, then prefixes. Anything unlisted defaults to WRITE: a new
// route is assumed to change something until someone classifies it, which fails
// safe (a read wrongly treated as a write only blocks unknown speakers).
const DESTRUCTIVE_PREFIXES = [
  '/api/skills/code/',      // Jarvis editing/restarting its own source
  '/api/agents/rpc',        // arbitrary RPC to another machine
  '/api/agents/control',
  '/api/agents/wake',
  '/api/pc/',               // input injection + process kill on the PC
  '/api/security/',         // vault unlock
]
const DESTRUCTIVE_EXACT = new Set([
  '/api/skills/system/power',      // shutdown / reboot
  '/api/skills/system/terminal',   // arbitrary shell
  '/api/skills/system/process',    // kill processes
  '/api/skills/desktop/pair',      // pairs a remote-desktop client to this host
])

// NOTE: /api/skills/vision/* is deliberately NOT listed as a read. It changes
// nothing, but a screenshot carries whatever is on screen — passwords, private
// messages — so an unrecognised voice must not be able to ask Jarvis to look.
// Unlisted ⇒ WRITE ⇒ owner/known only.

// Reads: listing, status, current state, search. Safe for anyone to ask.
const READ_EXACT = new Set([
  '/api/skills/timer/list', '/api/skills/chrono/list', '/api/skills/reminder/list',
  '/api/skills/view/current', '/api/skills/time/now', '/api/skills/gestures/status',
  '/api/skills/projector/status', '/api/skills/cloud/list', '/api/skills/obsidian/tasks',
  '/api/skills/obsidian/search', '/api/skills/mobile/where', '/api/skills/mobile/routine',
  '/api/skills/desktop/remote', '/api/skills/rgb/state', '/api/skills/rgb/presets',
  // Leer el grafo del propio vault no cambia nada (y es el camino para
  // responder "qué sabes sobre X"). `vault/focus` queda sin listar ⇒ write:
  // mueve la cámara del renderer, o sea toca la pantalla del señor.
  '/api/skills/vault/graph',
  // El estado del día (tareas, tarjetas, hábitos) solo se lee.
  '/api/skills/day/brief',
  '/api/skills/code/task/status', '/api/agents/list', '/api/system/telemetry',
  '/api/system/config', '/api/jarvis/stats', '/api/jarvis/memory',
])

/**
 * Classify one route.
 * @param {string} path
 * @returns {'read'|'write'|'destructive'}
 */
export function riskOf(path) {
  const p = String(path ?? '').split('?')[0]
  // code/task/status is a read even though it lives under the destructive prefix.
  if (READ_EXACT.has(p)) return RISK.READ
  if (DESTRUCTIVE_EXACT.has(p)) return RISK.DESTRUCTIVE
  if (DESTRUCTIVE_PREFIXES.some((pre) => p.startsWith(pre))) return RISK.DESTRUCTIVE
  return RISK.WRITE
}

// Who may do what. LOW_CONF is "I am not sure who is talking": it may look, not
// touch — the same stance the STT gate already takes for executing commands.
const POLICY = {
  OWNER:    { read: true, write: true,  destructive: true },
  KNOWN:    { read: true, write: true,  destructive: false },
  UNKNOWN:  { read: true, write: false, destructive: false },
  LOW_CONF: { read: true, write: false, destructive: false },
}

// A destructive action needs a RECENT owner match, not one from hours ago. The
// speaker mode is sticky between turns, so without this a single morning
// identification would authorise a shutdown all afternoon.
// Read per call, not at import: a module-level const cannot be tuned at runtime
// (and made the staleness rule untestable).
const OWNER_FRESH_MS = () => Number(process['env']['JARVIS_RISK_OWNER_FRESH_MS'] || 15 * 60e3)

const ENABLED = () => process['env']['JARVIS_RISK_GATE'] !== '0'

/**
 * Decide whether a model tool call may proceed.
 *
 * @param {object} req  node request (needs headers + url)
 * @returns {{allowed: boolean, risk: string, mode: string, reason?: string, spoken?: string}}
 */
export function checkToolRisk(req) {
  const path = String(req?.url ?? '').split('?')[0]
  const risk = riskOf(path)
  const mode = getSpeakerMode()

  // Not a model tool call → not our business (GUI, companion app, internal).
  if (req?.headers?.['x-jarvis-origin'] !== 'model') {
    return { allowed: true, risk, mode, reason: 'not_model_origin' }
  }
  if (!ENABLED()) return { allowed: true, risk, mode, reason: 'gate_disabled' }

  const policy = POLICY[mode] ?? POLICY.UNKNOWN
  if (!policy[risk]) {
    return {
      allowed: false,
      risk,
      mode,
      reason: `${mode}_cannot_${risk}`,
      spoken: risk === RISK.DESTRUCTIVE
        ? 'Esa acción solo puedo hacerla para el señor, y necesito reconocer su voz primero.'
        : 'No reconozco su voz lo suficiente para hacer eso.',
    }
  }

  if (risk === RISK.DESTRUCTIVE) {
    const ago = getLastInteractionAgo()
    if (ago > OWNER_FRESH_MS()) {
      return {
        allowed: false,
        risk,
        mode,
        reason: 'owner_match_stale',
        spoken: 'Hace rato que no confirmo su voz. Dígamelo otra vez, por favor.',
      }
    }
  }

  return { allowed: true, risk, mode, speaker: getSpeakerName() }
}
