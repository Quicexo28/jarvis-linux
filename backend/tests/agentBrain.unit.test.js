import { test, expect } from 'vitest'
import { heuristicBrain, createBrain } from '../src/agent/brain.js'

const TOOLS = [
  { name: 'nav.goto' },
  { name: 'nav.back' },
  { name: 'nav.ring.rotate' },
  { name: 'plan.loadLast' },
  { name: 'system.sleep' },
  { name: 'query.state' },
  { name: 'timer.start' },
]

function recordingCallTool(calls) {
  return async (capId, params) => {
    calls.push({ capId, params })
    return { ok: true, result: { ok: true, detail: `hecho ${capId}` } }
  }
}

test('createBrain defaults to the heuristic provider', () => {
  expect(createBrain().name).toBe('heuristic')
})

test('chained command plans goto(plan3d) then plan.loadLast in order', async () => {
  const calls = []
  const r = await heuristicBrain().runTurn({
    message: 'abre el editor 3D y carga el último proyecto',
    tools: TOOLS,
    callTool: recordingCallTool(calls),
  })
  expect(calls.map((c) => c.capId)).toEqual(['nav.goto', 'plan.loadLast'])
  expect(calls[0].params).toEqual({ mode: 'plan3d' })
  expect(r.ok).toBe(true)
})

test('"modo casa" maps to nav.goto house', async () => {
  const calls = []
  await heuristicBrain().runTurn({ message: 'llévame a la casa', tools: TOOLS, callTool: recordingCallTool(calls) })
  expect(calls).toEqual([{ capId: 'nav.goto', params: { mode: 'house' } }])
})

test('only announced tools are invoked', async () => {
  const calls = []
  // plan.loadLast is NOT announced here, so it must be skipped.
  await heuristicBrain().runTurn({
    message: 'carga el último proyecto',
    tools: [{ name: 'nav.goto' }],
    callTool: recordingCallTool(calls),
  })
  expect(calls).toEqual([])
})

test('"pon un temporizador de 45 segundos" maps to timer.start', async () => {
  const calls = []
  await heuristicBrain().runTurn({
    message: 'pon un temporizador de 45 segundos',
    tools: TOOLS,
    callTool: recordingCallTool(calls),
  })
  expect(calls).toEqual([{ capId: 'timer.start', params: { seconds: 45 } }])
})

test('an unrecognized command makes no tool calls and reports back', async () => {
  const calls = []
  const r = await heuristicBrain().runTurn({
    message: 'cuéntame un chiste',
    tools: TOOLS,
    callTool: recordingCallTool(calls),
  })
  expect(calls).toEqual([])
  expect(r.ok).toBe(false)
  expect(r.text).toMatch(/no entend/i)
})
