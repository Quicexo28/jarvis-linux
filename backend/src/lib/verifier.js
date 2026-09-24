/**
 * Turn verification — did the action actually happen?
 *
 * A voice assistant's worst failure mode is not an error, it is a confident
 * "listo, señor" over a tool that never ran or failed. Nothing in the pipeline
 * checked that: the model's own words were the only evidence a turn produced,
 * and the one guard that existed (`enforceDisplayClaim` in handlers/speech.js)
 * covered exactly one symptom — spoken URLs with no card on screen.
 *
 * This generalises that guard into four checks, run AFTER the reply is spoken so
 * they never add latency:
 *
 *   A. honesty       — a tool errored: does the reply admit it, or claim success?
 *   B. postcondition — a tool "succeeded": is the world actually in that state?
 *   C. unbacked      — the reply claims an action with NO tool call behind it.
 *   D. display       — the old show_display rules, moved here unchanged.
 *
 * At most ONE corrective turn fires per turn (Jarvis must not speak twice over
 * itself), and every turn gets a verdict stored on its row, so `/api/jarvis/stats`
 * shows how often the assistant says one thing and does another.
 *
 * Kill switch: JARVIS_VERIFY=0. Display-only switch stays JARVIS_ENFORCE_DISPLAY=0.
 */

import { sessionAsk } from './claudeCli.js'
import { hasClient, requestClient } from './skillBus.js'
import { getLastUiActionAt, getLastDisplayShowAt } from '../handlers/skillTools.js'

const VERIFY_ENABLED = () => process['env']['JARVIS_VERIFY'] !== '0'
const ENFORCE_DISPLAY = () => process['env']['JARVIS_ENFORCE_DISPLAY'] !== '0'
// Postconditions query the renderer; keep it far below a turn's budget so a
// wedged renderer can't pile up.
const PROBE_TIMEOUT_MS = Number(process['env']['JARVIS_VERIFY_PROBE_MS'] ?? 3000)

// ── reply classifiers ───────────────────────────────────────────────────────
//
// Every pattern below runs on ACCENT-STRIPPED lowercase text. JavaScript's `\b`
// only understands ASCII, so on raw Spanish "Falló al guardar" there is no word
// boundary after the "ó" and /\bfall[óo]\b/ never matches — the honest reply would
// have been graded a lie. Same trap already documented for the wake-phrase
// regexes; same fix: normalise first, write the patterns unaccented.

/** Lowercase and strip diacritics so ASCII `\b` behaves on Spanish text. */
export function normalizeReply(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

// The reply owns up to a failure. Deliberately broad: any honest phrasing counts,
// because the point is to catch its OPPOSITE (claiming success over an error).
const FAILURE_ADMISSION_RE =
  /\bno\s+(?:pude|puedo|he\s+podido|se\s+pudo|esta\s+disponible|responde|logre)\b|\bfallo\b|\bfalla\b|\berror\b|\bno\s+funcion|\bimposible\b|\bsin\s+conexion\b|\bno\s+esta\s+(?:conectad|disponible|activ)|\bno\s+(?:se\s+)?(?:pudo|ha\s+podido)\b/

// A concrete claim that a state-changing action completed.
//
// Split in two on purpose. Past PARTICIPLES ("abierto", "apagado") are also
// ordinary adjectives — "Firefox es de código abierto" tripped this and got a
// truthful answer graded as a lie. So participles only count in a SHORT reply,
// where the sentence is a terse confirmation rather than an explanation; the
// first-person verbs ("abrí", "apagué") are unambiguous at any length.
const ACTION_DONE_RE =
  /\b(?:temporizador|cronometro|alarma|recordatorio)\b[^.]{0,40}\b(?:corriendo|iniciad|cread|activ|marchando|en\s+marcha|cancelad|listo)|\b(?:abri|cerre|encendi|apague|programe|guarde|anote|anadi|cancele|puse|inicie|active|desactive|reinicie)\b|\bahi\s+(?:lo\s+)?tienes?\b|\bya\s+esta\s+(?:en\s+pantalla|abierto|encendido|corriendo|listo)\b/

/** Bare participles: only trusted as a claim inside a terse reply. */
const ACTION_PARTICIPLE_RE =
  /\b(?:abierto|cerrado|encendido|apagado|creado|programado|cancelado|guardado|anotado|activado|desactivado)\b/
const TERSE_REPLY_CHARS = 60

// (1) Verbal claim that something is already on screen.
const DISPLAY_CLAIM_RE = /\bpantalla\b|\b(?:ah[íi]\s+(?:tienes?|est[áa]n?)|te\s+dejo|le\s+dejo|te\s+muestro|le\s+muestro)\b[\s\S]{0,60}?\b(?:enlaces?|links?|referencias?|fuentes?|url(?:es)?|f[óo]rmulas?)\b/i
// (2) A URL or bare domain spoken in the reply — links are NEVER read aloud.
// Bare domains require a real TLD after a letter-led label, so decimals ("3.14")
// and abbreviations don't match.
const URL_IN_REPLY_RE = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|so|app|ai|co|es|gg|md|sh|xyz|info|tech|cloud|design|page)\b(?:\/\S*)?/i
// (3) A named tool/app/product/service the "HERRAMIENTAS MENCIONADAS" rule
// requires a card for. Curated for precision (real product names, word-bounded)
// so ordinary Spanish words don't false-fire.
const NAMED_TOOL_RE = /\b(obsidian|notion|firefox|brave|chromium|chrome|spotify|telegram|whatsapp|discord|kitty|hyprland|vs\s?code|visual studio code|github|gitlab|figma|canva|photoshop|blender|davinci resolve|excel|powerpoint|google\s+(?:docs|drive|sheets|calendar|maps|keep)|gmail|outlook|slack|zoom|trello|todoist|anki|zotero|wolfram|perplexity|chatgpt|openai|gemini|copilot|tailscale|react|next\.?js|svelte|vue|tailwind|ffmpeg)\b/i

/** MCP tools arrive namespaced (`mcp__jarvis__timer_start`); compare bare names. */
export function bareToolName(name) {
  const s = String(name ?? '')
  const i = s.lastIndexOf('__')
  return i >= 0 ? s.slice(i + 2) : s
}

/**
 * Does the reply admit the failure that the tool errors report?
 * @param {string} reply
 * @param {string[]} toolErrors
 * @returns {'honest'|'false_success'|null}  null when there was no failure
 */
export function classifyFailureHonesty(reply, toolErrors) {
  if (!toolErrors?.length) return null
  return FAILURE_ADMISSION_RE.test(normalizeReply(reply)) ? 'honest' : 'false_success'
}

/**
 * Did the turn recover from its failed tool? The proxy is the LAST tool call: if
 * the model's final action succeeded, its answer rests on that success, not on
 * the failure. Requires at least one successful call, so a turn where everything
 * errored is never counted as recovery.
 * @param {string[]} tools     every tool name called, in order
 * @param {string[]} toolErrors  "name: detail" for each failed call
 * @returns {boolean}
 */
export function recovered(tools = [], toolErrors = []) {
  if (!tools.length || !toolErrors.length) return false
  const failed = new Set(toolErrors.map((e) => String(e).split(':')[0].trim()))
  const succeeded = tools.filter((t) => !failed.has(t))
  if (!succeeded.length) return false
  return !failed.has(tools[tools.length - 1])
}

/**
 * Reply claims a completed action while nothing was actually invoked.
 * @param {string} reply
 * @param {string[]} tools
 * @returns {boolean}
 */
export function isUnbackedClaim(reply, tools) {
  if (tools?.length) return false
  const norm = normalizeReply(reply)
  if (ACTION_DONE_RE.test(norm)) return true
  return norm.length <= TERSE_REPLY_CHARS && ACTION_PARTICIPLE_RE.test(norm)
}

// ── postconditions ──────────────────────────────────────────────────────────
// Each entry answers: after this tool succeeded, what must be TRUE in the world?
// Returning null means "not checkable right now" (renderer down, no input), which
// is never a failure — an unverifiable turn must not be reported as a lie.

const POSTCONDITIONS = {
  async open_view(input) {
    const want = String(input?.view ?? input?.name ?? '').toLowerCase()
    if (!want) return null
    const cur = await probe('view_current')
    if (!cur) return null
    const got = String(cur.view ?? cur.mode ?? cur.current ?? '').toLowerCase()
    if (!got) return null
    return got.includes(want) || want.includes(got)
      ? null
      : `open_view pidió "${want}" pero la vista actual es "${got}"`
  },

  async timer_start() {
    const list = await probe('timer_list')
    if (!list) return null
    return countItems(list) > 0 ? null : 'timer_start no dejó ningún temporizador activo'
  },

  async chrono_start() {
    const list = await probe('chrono_list')
    if (!list) return null
    return countItems(list) > 0 ? null : 'chrono_start no dejó ningún cronómetro activo'
  },

  async timer_cancel(input) {
    // Only the "cancel everything" case has an unambiguous expected end state;
    // cancelling one label says nothing about the others.
    if (!input?.all) return null
    const list = await probe('timer_list')
    if (!list) return null
    return countItems(list) === 0 ? null : 'timer_cancel(all) dejó temporizadores vivos'
  },

  async show_display(_input, ctx) {
    return getLastDisplayShowAt() >= ctx.sinceTs
      ? null
      : 'show_display no llegó al backend (nada se mostró)'
  },
}

/** Count items in a list-ish skill-bus response without assuming its shape. */
function countItems(res) {
  for (const key of ['timers', 'chronos', 'items', 'list']) {
    if (Array.isArray(res?.[key])) return res[key].length
  }
  return Array.isArray(res) ? res.length : 0
}

/** Ask the renderer for state. Any failure returns null = "not checkable". */
async function probe(verb) {
  if (!hasClient()) return null
  try {
    return await requestClient(verb, {}, PROBE_TIMEOUT_MS)
  } catch {
    return null
  }
}

// ── corrective turns ────────────────────────────────────────────────────────

// IMPORTANT: a corrective turn's TEXT is discarded — nothing speaks it. The
// renderer has no `speak` primitive, so the only way a correction reaches the
// user is a tool with a real effect (retry the action, or put the truth on
// screen with show_display). Never word these as "tell the señor X": that reply
// would vanish into the void. (A proper fix is a `speak` primitive in
// frontend/src/skills/primitives.ts, which is frontend work.)
const CORRECTIVE = {
  false_success: (detail) =>
    `[SISTEMA — no es el señor] Tu última respuesta dio por hecha una acción que en realidad FALLÓ. Error real: ${detail}. Lo que digas ahora NO se dice en voz alta, así que actúa: si puedes reintentar la acción con la herramienta correspondiente, hazlo UNA vez. Si no se puede, llama show_display con kind=markdown y una línea breve en español contando qué no se pudo hacer, sin nombrar herramientas, "renderer", "MCP", rutas ni códigos. Después responde solo "listo".`,
  postcondition_failed: (detail) =>
    `[SISTEMA — no es el señor] Comprobé el estado real del sistema tras tu última respuesta y NO coincide con lo que dijiste: ${detail}. Lo que escribas ahora no se pronuncia, así que actúa: reintenta la acción UNA sola vez con la herramienta correspondiente. Si sigue sin cumplirse, llama show_display con kind=markdown y una línea breve diciendo que no quedó hecho. Después responde solo "listo".`,
  unbacked_claim: () =>
    '[SISTEMA — no es el señor] Tu última respuesta afirmó haber hecho algo, pero no llamaste a ninguna herramienta: no se ejecutó nada. Lo que escribas ahora no se pronuncia. Si la acción es posible, EJECÚTALA ahora con la herramienta correspondiente. Si no es posible, llama show_display con kind=markdown y una línea breve diciendo que no se hizo. Después responde solo "listo".',
  display_missing: () =>
    '[SISTEMA — no es el señor] Tu última respuesta nombró una herramienta, un enlace o una fuente (o dijo que algo estaba en pantalla) SIN llamar a ninguna herramienta: la pantalla está vacía. Llama show_display AHORA MISMO con ese contenido — kind=url para un único enlace o herramienta (incluye su URL oficial), kind=markdown con una línea "Nombre — URL" por cada herramienta o fuente si son varias, kind=formula con LaTeX para fórmulas o resultados. Después de llamarla responde únicamente "listo", sin ninguna otra palabra.',
}

function fireCorrective(kind, detail, { model, systemPromptText }) {
  const build = CORRECTIVE[kind]
  if (!build || !systemPromptText) return
  sessionAsk(build(detail), {
    systemPromptText,
    timeoutMs: 30000,
    model,
    fallbackReply: '',
  }).catch(() => {})
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Verify one finished turn. Never throws; returns the verdict to store.
 *
 * @param {object} turn
 * @param {string} turn.reply
 * @param {string[]} [turn.tools]        namespaced tool names called
 * @param {Array<{name:string,input:any}>} [turn.toolCalls]
 * @param {string[]} [turn.toolErrors]
 * @param {string} [turn.model]
 * @param {number} turn.sinceTs          when the model turn started
 * @param {string} turn.systemPromptText prompt for the corrective turn
 * @returns {Promise<string>} verdict
 */
export async function verifyTurn(turn = {}) {
  if (!VERIFY_ENABLED()) return 'disabled'
  const { reply = '', tools = [], toolCalls = [], toolErrors = [], model = 'haiku',
          sinceTs = 0, systemPromptText = '' } = turn
  const ctx = { model, systemPromptText, sinceTs }

  try {
    // A. A failed tool that the reply papered over is the worst case — check first.
    const honesty = classifyFailureHonesty(reply, toolErrors)
    if (honesty === 'false_success') {
      // ...unless the model RECOVERED. Seen live: `Bash` was refused (it is
      // disabled for this session), the model fell back to run_terminal, got the
      // answer and reported it truthfully — and the first version graded that a
      // lie. Firing a corrective there would tell the señor something failed when
      // it did not, which is worse than the miss it prevents.
      if (recovered(tools, toolErrors)) return 'tool_error_recovered'
      console.warn(`[verify] FALSE SUCCESS — ${toolErrors[0]}`)
      fireCorrective('false_success', toolErrors[0], ctx)
      return 'false_success'
    }
    if (honesty === 'honest') return 'tool_error_reported'

    // B. Tools that "worked": confirm the world agrees.
    for (const call of toolCalls) {
      const check = POSTCONDITIONS[bareToolName(call.name)]
      if (!check) continue
      const failure = await check(call.input, ctx)
      if (failure) {
        console.warn(`[verify] POSTCONDITION FAILED — ${failure}`)
        fireCorrective('postcondition_failed', failure, ctx)
        return `postcondition_failed:${bareToolName(call.name)}`
      }
    }

    // C. Display rules (moved verbatim from handlers/speech.js).
    //
    // Skipped when the turn LOOKED at something: DISPLAY_CLAIM_RE fires on a bare
    // "pantalla", which used to be a reliable tell that the model claimed to have
    // shown a card. Now that Jarvis can see the screen, "tu pantalla está limpia"
    // is a plain description of a real observation, and the corrective would fire
    // on every single vision answer.
    const looked = tools.some((t) => /look_(screen|camera)$/.test(String(t)))
    if (ENFORCE_DISPLAY() && reply && !looked) {
      const norm = normalizeReply(reply)
      const claim = DISPLAY_CLAIM_RE.test(norm)
      const url = URL_IN_REPLY_RE.test(norm)
      const named = !claim && !url && NAMED_TOOL_RE.test(norm)
      if ((claim || url || named) &&
          getLastUiActionAt() < sinceTs && getLastDisplayShowAt() < sinceTs) {
        const trigger = claim ? 'claim' : url ? 'url' : 'tool'
        console.warn(`[verify] ${trigger} without UI action — firing corrective turn`)
        fireCorrective('display_missing', '', ctx)
        return 'display_missing'
      }
    }

    // D. Claimed an action with nothing behind it. A UI verb that reached the
    // backend by another route (skill bus, direct handler) still counts as real
    // work, so gate on it exactly like the display check does.
    if (isUnbackedClaim(reply, tools) && getLastUiActionAt() < sinceTs) {
      console.warn('[verify] UNBACKED CLAIM — reply asserts an action, no tool ran')
      fireCorrective('unbacked_claim', '', ctx)
      return 'unbacked_claim'
    }

    return tools.length ? 'ok' : 'unverified'
  } catch (e) {
    console.warn('[verify] failed —', e?.message)
    return 'verify_error'
  }
}
