/**
 * Model routing for Jarvis turns.
 *
 * Picks the Claude model by task type so cheap/fast haiku handles chat and
 * commands, sonnet handles deliberate research/science, and opus handles
 * building new tools (self-build code generation).
 *
 * The model string flows into claudeCli.js (runClaude / sessionAsk), which keys
 * its persistent-session cache by `model::hash(prompt)`, so each model gets its
 * own warm process.
 */

/** @typedef {'haiku'|'sonnet'|'opus'} ClaudeModel */

// Delicate / irreversible work → opus (best judgment, follows safety rules):
// building new capabilities (code gen) and destructive file/code operations.
const OPUS_INTENTS = new Set(['self_build', 'file_delicate'])
// Complex reasoning / multi-step analysis → sonnet.
const SONNET_INTENTS = new Set(['complex_task'])

/**
 * Map an intent tag to the model that should answer it. Everything not listed
 * (chat, commands, navigation, timers, quick queries) → haiku for speed.
 * @param {string} intentTag
 * @returns {ClaudeModel}
 */
export function pickModel(intentTag) {
  if (OPUS_INTENTS.has(intentTag)) return 'opus'
  if (SONNET_INTENTS.has(intentTag)) return 'sonnet'
  return 'haiku'
}
