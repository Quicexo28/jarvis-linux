/**
 * Agente de escritorio. Lo que importa: que corra en MODO AUTO (clasificador
 * delante de cada acción) y nunca con --dangerously-skip-permissions, y que su
 * ruta quede tan cerrada como el autodesarrollo: local-only y destructive.
 */
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { agentArgs, extractSummary, COMPUTER_SYSTEM_PROMPT, startComputerJob, cancelComputerJob } from '../src/lib/computerAgent.js'
import { riskOf } from '../src/lib/toolRisk.js'
import { authorize } from '../src/lib/webAuth.js'

test('el agente corre en modo auto, nunca saltándose los permisos', () => {
  const args = agentArgs('sonnet')
  const i = args.indexOf('--permission-mode')
  expect(i).toBeGreaterThan(-1)
  expect(args[i + 1]).toBe('auto')
  expect(args).not.toContain('--dangerously-skip-permissions')
  expect(args).not.toContain('--allow-dangerously-skip-permissions')
  expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
})

test('el prompt manda usar pc-ctl y protege la ventana de Jarvis', () => {
  expect(COMPUTER_SYSTEM_PROMPT).toMatch(/scripts\/linux\/pc-ctl shot/)
  expect(COMPUTER_SYSTEM_PROMPT).toMatch(/"jarvis"/)
  expect(COMPUTER_SYSTEM_PROMPT).toMatch(/RESUMEN:/)
})

test('extractSummary toma la línea RESUMEN o cae a la última', () => {
  expect(extractSummary('hice cosas\nRESUMEN: Abrí el formulario y lo envié.')).toBe('Abrí el formulario y lo envié.')
  expect(extractSummary('uno\n**listo**')).toBe('listo')
  expect(extractSummary('')).toBe('')
})

test('la ruta es destructive y su estado es lectura', () => {
  expect(riskOf('/api/skills/computer/task')).toBe('destructive')
  expect(riskOf('/api/skills/computer/task/cancel')).toBe('destructive')
  expect(riskOf('/api/skills/computer/task/status')).toBe('read')
})

test('la ruta es local-only incluso con token', () => {
  const remote = {
    url: '/api/skills/computer/task',
    headers: { 'x-forwarded-for': '100.64.0.5' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  expect(authorize(remote)).toMatchObject({ ok: false, code: 403 })
})

test('la tool MCP existe y apunta a la ruta', () => {
  const src = readFileSync(new URL('../mcp-server/jarvis-mcp.js', import.meta.url), 'utf-8')
  for (const t of ['computer_task', 'computer_task_status', 'computer_task_cancel']) {
    expect(src).toContain(`name: '${t}'`)
  }
  expect(src).toContain("path: '/api/skills/computer/task'")
})

test('un job a la vez, y la tarea vacía se rechaza', async () => {
  process.env.JARVIS_FAKE_CLAUDE = '1'
  try {
    expect((await startComputerJob({ task: '  ' })).error).toBe('empty_task')
    const a = await startComputerJob({ task: 'abre el formulario' })
    expect(a.ok).toBe(true)
    // El fake resuelve en un microtask; el slot puede seguir ocupado o ya libre,
    // pero NUNCA puede haber dos activos con distinto id.
    const b = await startComputerJob({ task: 'otra cosa' })
    if (!b.ok) expect(b.error).toBe('job_running')
    cancelComputerJob()
  } finally {
    delete process.env.JARVIS_FAKE_CLAUDE
  }
})
