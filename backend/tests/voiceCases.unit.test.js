import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Drift guard for the eval fixture. The cases name tools by string; when a tool
// is renamed or consolidated (timer_start → timer.start) a stale case would fail
// at eval time as "didn't call X" — indistinguishable from a real regression,
// and only after spending tokens. Catch it here, for free.

const dir = import.meta.dirname
const cases = JSON.parse(readFileSync(join(dir, 'fixtures', 'voice-cases.json'), 'utf-8'))
const mcp = readFileSync(join(dir, '..', 'mcp-server', 'jarvis-mcp.js'), 'utf-8')
const MCP_TOOLS = new Set([...mcp.matchAll(/^\s{4}name: '([a-z0-9_]+)'/gm)].map((m) => m[1]))
const BUILT_INS = new Set(['WebSearch', 'WebFetch'])
const ACTIONS = {
  timer: ['start', 'add', 'pause', 'resume', 'reset', 'cancel', 'list'],
  chrono: ['start', 'pause', 'resume', 'reset', 'lap', 'cancel', 'list'],
}
const KNOWN_KEYS = new Set([
  'action', 'actionAnyOf', 'intent', 'toolsInclude', 'toolsAnyOf', 'toolsExclude',
  'replyMatches', 'replyNotMatches', 'maxFirstMs', 'verdict', 'verdictAnyOf',
])

function toolExists(name) {
  if (BUILT_INS.has(name)) return true
  const [base, action] = name.split('.')
  if (action) return MCP_TOOLS.has(base) && (ACTIONS[base] ?? []).includes(action)
  // A consolidated tool is never named bare in a case: say which action.
  if (ACTIONS[base]) return false
  return MCP_TOOLS.has(base)
}

describe('voice-cases.json', () => {
  it('parses the MCP tool list (sanity of the regex above)', () => {
    expect(MCP_TOOLS.has('timer')).toBe(true)
    expect(MCP_TOOLS.has('self_diagnose')).toBe(true)
    expect(MCP_TOOLS.has('timer_start')).toBe(false)
  })

  it('has unique names', () => {
    const names = cases.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  for (const c of cases) {
    it(`"${c.name}" only uses known keys and real tools`, () => {
      expect(typeof c.text).toBe('string')
      for (const k of Object.keys(c.expect ?? {})) expect(KNOWN_KEYS.has(k), `clave desconocida ${k}`).toBe(true)
      const e = c.expect ?? {}
      for (const t of [...(e.toolsInclude ?? []), ...(e.toolsAnyOf ?? []), ...(e.toolsExclude ?? [])]) {
        expect(toolExists(t), `${t} no es una tool real`).toBe(true)
      }
      for (const re of [e.replyMatches, e.replyNotMatches].filter(Boolean)) {
        expect(() => new RegExp(re)).not.toThrow()
      }
    })
  }
})
