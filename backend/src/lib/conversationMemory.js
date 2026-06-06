/**
 * Sliding-window conversation memory for multi-turn context.
 *
 * Stores the last N exchanges (user + Jarvis) in memory.
 * Passed as context to Claude CLI for follow-up understanding.
 */

const MAX_TURNS = 8
const turns = []

export function addUserMessage(text) {
  turns.push({ role: 'user', text, ts: Date.now() })
  if (turns.length > MAX_TURNS * 2) turns.splice(0, 2)
}

export function addAssistantMessage(text) {
  turns.push({ role: 'assistant', text, ts: Date.now() })
  if (turns.length > MAX_TURNS * 2) turns.splice(0, 2)
}

export function getConversationContext() {
  if (!turns.length) return ''
  return turns
    .map(t => `${t.role === 'user' ? 'Usuario' : 'Jarvis'}: ${t.text}`)
    .join('\n')
}

export function clearMemory() {
  turns.length = 0
}
