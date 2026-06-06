/**
 * Attention State Machine for Jarvis.
 *
 * Manages how receptive Jarvis is to speech based on recency of interaction.
 * States: ENGAGED (0-15s) → ATTENTIVE (15-60s) → PASSIVE (>60s)
 */

const ENGAGED_TIMEOUT_MS = 15000
const ATTENTIVE_TIMEOUT_MS = 60000

let lastInteractionAt = 0
let forcedPassive = false

export function getAttentionState() {
  if (forcedPassive) return 'PASSIVE'
  const elapsed = Date.now() - lastInteractionAt
  if (elapsed < ENGAGED_TIMEOUT_MS) return 'ENGAGED'
  if (elapsed < ATTENTIVE_TIMEOUT_MS) return 'ATTENTIVE'
  return 'PASSIVE'
}

export function markInteraction() {
  lastInteractionAt = Date.now()
  forcedPassive = false
}

export function forcePassive() {
  forcedPassive = true
}

export function getLastInteractionAgo() {
  return Date.now() - lastInteractionAt
}
