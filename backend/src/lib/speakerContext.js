/**
 * Speaker context — in-memory singleton tracking the current speaker's
 * identity mode across turns within a session.
 *
 * Modes:
 *   OWNER      – registered owner, full intent access
 *   KNOWN      – registered non-owner, limited intents
 *   UNKNOWN    – unrecognized voice, limited + first-contact flow
 *   LOW_CONF   – embedding confidence too low, gather more audio
 */

const LIMITED_INTENTS = new Set([
  'chat', 'complex_task', 'show_3d', 'render_formula',
  'show_display', 'navigate', 'activate_skill',
])

let _mode = 'UNKNOWN'
let _name = null
const _turnCounts = new Map()

export function getSpeakerMode() { return _mode }
export function getSpeakerName() { return _name }

export function setSpeakerMode(mode, name) {
  _mode = mode
  _name = name ?? null
}

export function resetSession() {
  _mode = 'UNKNOWN'
  _name = null
  _turnCounts.clear()
}

export function filterIntentsByMode(intent, mode) {
  if (mode === 'OWNER') return true
  if (mode === 'LOW_CONF') return false
  return LIMITED_INTENTS.has(intent)
}

export function incrementTurnCount(speakerName) {
  const count = (_turnCounts.get(speakerName) ?? 0) + 1
  _turnCounts.set(speakerName, count)
  return count
}

export function getTurnCount(speakerName) {
  return _turnCounts.get(speakerName) ?? 0
}
