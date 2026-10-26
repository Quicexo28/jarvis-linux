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
  '/api/skills/computer/',  // agente que maneja ratón/teclado/pantalla del PC
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
  '/api/skills/claude/launch',     // lanza un agente Claude Code con permisos sobre un repo
  '/api/skills/claude/send',       // da nuevas órdenes a un agente (o reanuda uno cerrado)
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
  // El estado del día (tareas, tarjetas, hábitos, agenda) solo se lee. El
  // CORREO no va aquí a propósito: igual que la visión, leer el buzón expone
  // contenido privado, así que una voz desconocida no puede pedirlo (⇒ write).
  '/api/skills/day/brief', '/api/skills/calendar/agenda',
  '/api/skills/code/task/status', '/api/skills/computer/task/status', '/api/agents/list', '/api/system/telemetry',
  '/api/system/config', '/api/jarvis/stats', '/api/jarvis/memory',
  // Autodiagnóstico: sondear y listar incidentes no cambia nada (el remedio
  // que dispara un sondeo es el mismo que el vigilante aplica solo cada 3 min).
  '/api/skills/health/diagnose', '/api/jarvis/health/incidents',
  // Qué agentes Claude hay y cómo van: solo lectura (Agent Hub).
  '/api/skills/claude/list',
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

// A chat turn the owner authorised with tablet biometric/PIN + the special
// password (riskAuth.js). The probe is registered by claudeCli.js — not
// imported here, to keep this module free of the CLI's dependency tree — and
// answers "the ONLY turn in flight right now is that authorised one". One
// ticket = one turn; nothing carries over to the next voice turn.
let elevatedTurnProbe = () => false
export function setElevatedTurnProbe(fn) { elevatedTurnProbe = typeof fn === 'function' ? fn : () => false }

// Untrusted content in the turn ("Rule of Two"). Speaker-id proves WHO asked;
// it says nothing about what the model READ while answering. A web page, an
// email, a calendar invite from a stranger or whatever is on screen can carry
// instructions, and a turn that reads such content AND runs a destructive tool
// has all three legs of the lethal trifecta: private data (memory and vault are
// in every turn), untrusted input, and a way to act. Seen in the real traces:
// WebSearch → run_terminal in one turn. So once a turn pulls in outside
// content, destructive tools are refused for the rest of THAT turn; the model
// has to say what it was about to do, and the owner's "sí" arrives as the next
// turn, which starts clean. Names are the CLI's tool_use names. Residual: the
// CLI's own WebFetch never reaches this gate, so it can still be used to send
// data out in a tainted turn.
const UNTRUSTED_SOURCES = new Set([
  'WebSearch', 'WebFetch',
  'mcp__jarvis__mail_inbox', 'mcp__jarvis__mail_read',
  'mcp__jarvis__calendar_agenda', 'mcp__jarvis__day_brief',
  'mcp__jarvis__look_screen', 'mcp__jarvis__look_camera',
])
export function isUntrustedSource(toolName) { return UNTRUSTED_SOURCES.has(String(toolName ?? '')) }

// Registered by claudeCli.js, like the elevated probe: "a turn in flight has
// already read untrusted content".
let taintedTurnProbe = () => false
export function setTaintedTurnProbe(fn) { taintedTurnProbe = typeof fn === 'function' ? fn : () => false }
const TAINT_ENABLED = () => process['env']['JARVIS_TAINT_GATE'] !== '0'

// Last denial, so a chat turn can tell the app "this needed authorisation"
// instead of the app having to parse the model's apology.
let lastDenial = null
/** Denial recorded at or after `since` (ms epoch), or null. */
export function riskDeniedSince(since) {
  return lastDenial && lastDenial.at >= since ? lastDenial : null
}

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
  // Before the elevated ticket on purpose: the owner authorised the turn
  // before the outside content was read, not the action it now suggests.
  if (risk === RISK.DESTRUCTIVE && TAINT_ENABLED() && taintedTurnProbe()) {
    lastDenial = { at: Date.now(), risk, reason: 'tainted_turn' }
    return {
      allowed: false,
      risk,
      mode,
      reason: 'tainted_turn',
      spoken: 'En este turno leí contenido de fuera (web, correo, agenda o pantalla), así que no ejecuto ' +
        'acciones de riesgo en el mismo turno. Dígale al señor exactamente qué iba a hacer y pídale que lo ' +
        'confirme; si confirma, hágalo en el turno siguiente.',
    }
  }
  if (elevatedTurnProbe()) return { allowed: true, risk, mode, reason: 'elevated_turn' }

  const policy = POLICY[mode] ?? POLICY.UNKNOWN
  if (!policy[risk]) {
    lastDenial = { at: Date.now(), risk, reason: `${mode}_cannot_${risk}` }
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
      lastDenial = { at: Date.now(), risk, reason: 'owner_match_stale' }
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
