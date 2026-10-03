import { describe, it, expect, beforeAll } from 'vitest'

process.env.JARVIS_DB_PATH = ':memory:'

let m
let bus
let cli
beforeAll(async () => {
  m = await import('../src/lib/selfHeal.js')
  bus = await import('../src/lib/incidentBus.js')
  cli = await import('../src/lib/claudeCli.js')
})

const OUR_STACK = `Error: boom
    at handleThing (/home/santiago2/jarvis-linux/backend/src/handlers/thing.js:12:7)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)`
const DEP_STACK = `Error: socket hang up
    at TLSSocket.onClose (/home/santiago2/jarvis-linux/backend/node_modules/ws/lib/x.js:1:1)
    at node:internal/streams/destroy:1:1`

const base = {
  id: 1, code: 'JRV-ROUTE-001', status: 'open', count: 3, detail: OUR_STACK,
  message: 'POST /api/x lanzó: boom', lastFixTs: null,
}
const state = { mode: 'auto', now: 10_000_000, fixesToday: 0, maxPerDay: 2, jobActive: false, hasCodeDir: true }

describe('normalizeErrorKey', () => {
  it('collapses the parts that change between occurrences', () => {
    const a = m.normalizeErrorKey('timeout after 45000ms in /tmp/jarvis-x/abc session 3f2a9b7c1d')
    const b = m.normalizeErrorKey('Timeout after 30000ms in /tmp/other session 99aa88bb77')
    expect(a).toBe(b)
  })
})

describe('stackInRepo', () => {
  it('sees frames in our source', () => expect(m.stackInRepo(OUR_STACK)).toBe(true))
  it('ignores dependencies and node internals', () => expect(m.stackInRepo(DEP_STACK)).toBe(false))
  it('a bare message is not a stack', () => expect(m.stackInRepo('backend/src/x.js broke')).toBe(false))
})

describe('isEnvironmentalToolError', () => {
  it.each([
    'renderer_not_connected',
    'risk_denied',
    'Error ejecutando mail_inbox: mail_not_configured',
    '<tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session',
    'fetch failed: ECONNREFUSED 127.0.0.1:8790',
  ])('%s is the world, not a bug', (e) => expect(m.isEnvironmentalToolError(e)).toBe(true))

  it('a TypeError is a bug', () => {
    expect(m.isEnvironmentalToolError("TypeError: Cannot read properties of undefined (reading 'map')")).toBe(false)
  })
})

describe('parseUnits', () => {
  it('reads systemctl --plain rows, including the failed marker', () => {
    const out = [
      'jarvis-stt.service          loaded active running Jarvis STT',
      '● jarvis-auto-linker.service loaded failed failed  Auto-linker',
      'jarvis-auto-linker.timer    loaded active waiting Ejecuta',
    ].join('\n')
    const units = m.parseUnits(out)
    expect(units).toHaveLength(2) // timers are not services
    expect(units[1]).toMatchObject({ unit: 'jarvis-auto-linker.service', name: 'jarvis-auto-linker', active: 'failed' })
  })
})

describe('codeFixBlock', () => {
  it('lets a recurring route error with our stack through in auto mode', () => {
    expect(m.codeFixBlock(base, state)).toBeNull()
  })
  it('asks the owner by default', () => {
    expect(m.codeFixBlock(base, { ...state, mode: 'ask' })).toBe('awaiting_owner')
  })
  it('never touches code for an external fault', () => {
    expect(m.codeFixBlock({ ...base, code: 'JRV-SVC-001' }, state)).toBe('not_code_fixable')
    expect(m.codeFixBlock({ ...base, code: 'JRV-CLI-001' }, state)).toBe('not_code_fixable')
  })
  it('a stack that lives in a dependency is not ours to fix', () => {
    expect(m.codeFixBlock({ ...base, detail: DEP_STACK }, state)).toBe('stack_outside_repo')
  })
  it('waits for a second occurrence, except a crash', () => {
    expect(m.codeFixBlock({ ...base, count: 1 }, state)).toBe('not_recurring_yet')
    expect(m.codeFixBlock({ ...base, code: 'JRV-EXC-001', count: 1 }, state)).toBeNull()
  })
  it('one attempt per incident per day, a daily budget, one job at a time', () => {
    expect(m.codeFixBlock({ ...base, lastFixTs: state.now - 3600e3 }, state)).toBe('already_tried_today')
    expect(m.codeFixBlock(base, { ...state, fixesToday: 2 })).toBe('daily_budget_spent')
    expect(m.codeFixBlock(base, { ...state, jobActive: true })).toBe('dev_job_running')
  })
  it('repeated tool errors need three hits and must not be environmental', () => {
    const tool = { ...base, code: 'JRV-TOOL-001', detail: '', message: "flashcards: TypeError: x is undefined" }
    expect(m.codeFixBlock({ ...tool, count: 2 }, state)).toBe('not_recurring_yet')
    expect(m.codeFixBlock({ ...tool, count: 3 }, state)).toBeNull()
    expect(m.codeFixBlock({ ...tool, count: 9, message: 'open_view: renderer_not_connected' }, state)).toBe('environmental')
  })
  it('off means off', () => {
    expect(m.codeFixBlock(base, { ...state, mode: 'off' })).toBe('disabled')
  })
})

describe('buildFixInstruction', () => {
  it('carries the code, the literal detail and the root-cause contract', () => {
    const txt = m.buildFixInstruction({ ...base, source: 'http', firstTs: 0, lastTs: 0, ctx: { route: 'POST /api/x' } })
    expect(txt).toContain('JRV-ROUTE-001')
    expect(txt).toContain('thing.js:12:7')
    expect(txt).toMatch(/CAUSA RAÍZ/)
    expect(txt).toMatch(/FUERA del código/)
  })
})

describe('noteTurn', () => {
  it('reports a dead brain after three fallbacks in a row, and only then', () => {
    const seen = []
    const off = bus.onIssue((r) => seen.push(r))
    const fb = { reply: 'No tengo respuesta en este momento.', meta: null }
    m.noteTurn(fb)
    m.noteTurn(fb)
    expect(seen.filter((r) => r.code === 'JRV-BRAIN-001')).toHaveLength(0)
    m.noteTurn(fb)
    expect(seen.filter((r) => r.code === 'JRV-BRAIN-001')).toHaveLength(1)
    m.noteTurn({ reply: 'Temporizador de tres minutos corriendo.', meta: { tools: ['x'] } })
    m.noteTurn(fb)
    expect(seen.filter((r) => r.code === 'JRV-BRAIN-001')).toHaveLength(1) // streak reset
    off()
  })

  it('turns non-environmental tool errors into JRV-TOOL-001, skips the rest', () => {
    const seen = []
    const off = bus.onIssue((r) => seen.push(r))
    m.noteTurn({
      reply: 'Falló, señor.',
      meta: { tools: ['a'], toolErrors: [
        'mcp__jarvis__open_view: renderer_not_connected',
        "mcp__jarvis__flashcards: Error ejecutando flashcards: TypeError: x is undefined",
      ] },
    })
    const tool = seen.filter((r) => r.code === 'JRV-TOOL-001')
    expect(tool).toHaveLength(1)
    expect(tool[0].ctx.tool).toBe('flashcards')
    off()
  })
})

describe('qualifiedToolName (consolidated timer/chrono)', () => {
  it('records the action so traces still say which operation ran', () => {
    expect(cli.qualifiedToolName('mcp__jarvis__timer', { action: 'start', seconds: 60 })).toBe('mcp__jarvis__timer.start')
    expect(cli.qualifiedToolName('mcp__jarvis__chrono', { action: 'LAP' })).toBe('mcp__jarvis__chrono.lap')
  })
  it('leaves every other tool alone, even with an action field', () => {
    expect(cli.qualifiedToolName('mcp__jarvis__study_session', { action: 'start' })).toBe('mcp__jarvis__study_session')
    expect(cli.qualifiedToolName('mcp__jarvis__timer', {})).toBe('mcp__jarvis__timer')
  })
})
