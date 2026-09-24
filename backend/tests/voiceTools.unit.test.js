import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DENIED_BUILTINS, DENIED_MCP, voiceDisallowedTools, deniedBareNames } from '../src/lib/voiceTools.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const speechSrc = readFileSync(join(__dir, '..', 'src', 'handlers', 'speech.js'), 'utf-8')
const mcpSrc = readFileSync(join(__dir, '..', 'mcp-server', 'jarvis-mcp.js'), 'utf-8')

/** Just the system-prompt section of speech.js — the text the model actually reads. */
const promptText = speechSrc.slice(0, speechSrc.indexOf('// ── STT correction layer'))

afterEach(() => { delete process.env.JARVIS_VOICE_DISALLOWED_TOOLS })

describe('voiceDisallowedTools', () => {
  it('denies the built-ins that bypass the risk gate', () => {
    const list = voiceDisallowedTools().split(',')
    for (const t of ['Bash', 'Write', 'Edit', 'Task']) expect(list).toContain(t)
  })

  it('namespaces MCP entries so the CLI can match them', () => {
    expect(voiceDisallowedTools()).toContain('mcp__jarvis__remote_exec')
    expect(voiceDisallowedTools()).not.toContain(',remote_exec')
  })

  it('lets the environment override the whole list', () => {
    process.env.JARVIS_VOICE_DISALLOWED_TOOLS = 'Bash'
    expect(voiceDisallowedTools()).toBe('Bash')
    process.env.JARVIS_VOICE_DISALLOWED_TOOLS = ''
    expect(voiceDisallowedTools()).toBe('')
  })

  it('documents a reason for every denied tool', () => {
    for (const [name, reason] of Object.entries({ ...DENIED_BUILTINS, ...DENIED_MCP })) {
      expect(reason.length, name).toBeGreaterThan(20)
    }
  })
})

describe('drift guard', () => {
  it('never denies a tool the system prompt tells the model to call', () => {
    // The prompt and the deny list live in different files; without this check
    // they diverge silently and the model is instructed to use a tool that no
    // longer exists, then improvises.
    const advertised = Object.keys(DENIED_MCP).filter((t) => promptText.includes(t))
    expect(advertised, `el prompt de voz nombra tools denegadas: ${advertised.join(', ')}`).toEqual([])
  })

  it('only denies MCP tools that actually exist in the server', () => {
    // A typo here silently denies nothing at all.
    const known = new Set([...mcpSrc.matchAll(/^\s*name: '([a-z0-9_]+)'/gm)].map((m) => m[1]))
    for (const t of Object.keys(DENIED_MCP)) expect(known.has(t), `${t} no existe en jarvis-mcp.js`).toBe(true)
  })

  it('keeps the deliberately-kept dangerous tools available', () => {
    // These are documented, owner-chosen, and gated as destructive by toolRisk.
    for (const t of ['run_terminal', 'system_power', 'code_task', 'code_run']) {
      expect(deniedBareNames()).not.toContain(t)
    }
  })
})
