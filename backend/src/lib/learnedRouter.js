/**
 * Learned routing — escalate haiku → sonnet from what the traces say.
 *
 * `modelRouter.js` decides on the TEXT with hand-written regexes, and nothing
 * ever checked whether the model it picked actually did the job. The verifier
 * already stamps every turn with a verdict (`turnStore.verdict`), so the
 * evidence exists: when haiku has repeatedly failed verification on turns that
 * look like this one, send it to sonnet instead.
 *
 * Deliberately narrow:
 *  - ESCALATION ONLY. It never downgrades a turn the regex router sent to
 *    sonnet/opus: there are too few non-haiku traces to learn that direction.
 *  - It learns from sonnet's outcomes too. If similar turns fail just as often
 *    on sonnet, the cause is a tool or the UI, not the model, and paying for
 *    sonnet buys nothing — so it stops escalating.
 *  - Only VERIFIED outcomes count. `unverified` (no tools, nothing to check)
 *    and CLI errors (timeouts, infra) say nothing about model quality.
 *
 * Similarity is token overlap over the recent turns, in memory: a few hundred
 * short strings, no network and no model on the voice path.
 *
 * Kill switch: JARVIS_LEARNED_ROUTING=0.
 */
import { recentTurns } from './turnStore.js'

const BAD_VERDICTS = new Set(['false_success', 'display_missing', 'unbacked_claim'])
// A turn that failed because the WORLD was unavailable (UI asleep, service not
// configured, no network) says nothing about the model: with the UI dormant
// every renderer tool fails and haiku "lost" turns it would have won, which
// escalated similar phrases to sonnet for no reason (seen 2026-10-26). Same
// idea as selfHeal's ENVIRONMENTAL_TOOL_ERROR_RE, kept local so the voice path
// does not import the watchdog's dependency tree.
const ENVIRONMENT_ERROR_RE = /renderer_not_connected|not_configured|machine_offline|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|risk_denied/i
const GOOD_VERDICTS = new Set(['ok', 'tool_error_recovered'])

/** Jaccard overlap for two turns to count as "the same kind of request". */
const SIMILARITY = 0.5
/** Verified haiku failures on similar turns before escalating. */
const MIN_FAILS = 2
/** ...and they must be at least this share of the verified similar turns. */
const MIN_FAIL_RATE = 0.5
/** Verified sonnet turns needed before its record can veto the escalation. */
const MIN_SONNET_JUDGED = 2
const HISTORY_TURNS = 500
const HISTORY_TTL_MS = 60000

// The wake word and function words would make every turn look like every other.
const STOPWORDS = new Set([
  'jarvis', 'oye', 'por', 'favor', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'al', 'a', 'en', 'y', 'o', 'que', 'mi', 'mis', 'tu', 'tus', 'me', 'te', 'se',
  'lo', 'le', 'es', 'con', 'para', 'su', 'sus',
])

let cache = null
let cachedAt = -Infinity

/**
 * Content tokens of an utterance: accent-free, lowercase, no stopwords.
 * @param {string} text
 * @returns {Set<string>}
 */
export function contentTokens(text) {
  const words = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || []
  return new Set(words.filter((w) => !STOPWORDS.has(w)))
}

function jaccard(a, b) {
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * Pure decision: should a turn the base router gave to haiku go to sonnet?
 * @param {string} text
 * @param {Array<{text: string, model: string, verdict: string|null}>} history
 * @returns {{escalate: boolean, reason: string}}
 */
export function decideEscalation(text, history) {
  const tokens = contentTokens(text)
  // One content word ("disminuye", "pausa") matches too much to mean anything.
  if (tokens.size < 2) return { escalate: false, reason: 'too_short' }
  const tally = { haiku: { good: 0, bad: 0 }, sonnet: { good: 0, bad: 0 } }
  for (const turn of history) {
    const side = tally[turn.model]
    if (!side) continue
    // The eval replays the same fixture over and over: real usage only.
    if (turn.source === 'eval' || ENVIRONMENT_ERROR_RE.test(turn.error || '')) continue
    const bad = BAD_VERDICTS.has(turn.verdict)
    if (!bad && !GOOD_VERDICTS.has(turn.verdict)) continue
    if (jaccard(tokens, contentTokens(turn.text)) < SIMILARITY) continue
    if (bad) side.bad++
    else side.good++
  }
  const { haiku, sonnet } = tally
  const haikuRate = haiku.bad / ((haiku.bad + haiku.good) || 1)
  if (haiku.bad < MIN_FAILS || haikuRate < MIN_FAIL_RATE) return { escalate: false, reason: 'haiku_ok' }
  const sonnetJudged = sonnet.bad + sonnet.good
  if (sonnetJudged >= MIN_SONNET_JUDGED && sonnet.bad / sonnetJudged >= haikuRate) {
    return { escalate: false, reason: 'sonnet_no_better' }
  }
  return { escalate: true, reason: `haiku failed ${haiku.bad}/${haiku.bad + haiku.good} similar turns` }
}

/**
 * Apply the learned override on top of the regex router's choice.
 * @param {'haiku'|'sonnet'|'opus'} base  what modelRouter.pickModel returned
 * @param {string} text
 * @param {number} [now]
 * @returns {'haiku'|'sonnet'|'opus'}
 */
export function learnedModel(base, text, now = Date.now()) {
  if (base !== 'haiku' || process.env.JARVIS_LEARNED_ROUTING === '0') return base
  if (!cache || now - cachedAt > HISTORY_TTL_MS) {
    cache = recentTurns(HISTORY_TURNS)
    cachedAt = now
  }
  const { escalate, reason } = decideEscalation(text, cache)
  if (!escalate) return base
  console.log(`[router] learned escalation haiku -> sonnet (${reason})`)
  return 'sonnet'
}

/** Test hook: drop the cached history. */
export function resetLearnedRouter() {
  cache = null
  cachedAt = -Infinity
}
