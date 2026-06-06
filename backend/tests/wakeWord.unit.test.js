import { test, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/attentionState.js', () => ({
  markInteraction: vi.fn(),
  getAttentionState: vi.fn(() => 'ENGAGED'),
}))
vi.mock('../src/lib/speakerContext.js', () => ({
  resetSession: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
}))
vi.mock('../src/lib/http.js', () => ({
  json: vi.fn((res, status, data) => {
    res.statusCode = status
    res.end(JSON.stringify(data))
  }),
  readBody: vi.fn(async (req) => req._body),
}))

import { handleWakeDetected, handleWakeCalibrate } from '../src/handlers/wakeWord.js'
import { markInteraction } from '../src/lib/attentionState.js'

function makeReqRes(body = {}) {
  let statusCode = 200
  let responseBody = null
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end(data) { responseBody = data ? JSON.parse(data) : null },
    get body() { return responseBody },
  }
  const req = { method: 'POST', url: '/api/jarvis/wake-detected', headers: {}, _body: body }
  return { req, res }
}

beforeEach(() => { vi.clearAllMocks() })

test('handleWakeDetected calls markInteraction', async () => {
  const { req, res } = makeReqRes({ confidence: 0.85, ts: 1000 })
  await handleWakeDetected(req, res)
  expect(markInteraction).toHaveBeenCalledOnce()
})

test('handleWakeDetected returns ok:true with attention state', async () => {
  const { req, res } = makeReqRes({ confidence: 0.85, ts: 1000 })
  await handleWakeDetected(req, res)
  expect(res.body.ok).toBe(true)
  expect(res.body.state).toBe('ENGAGED')
})

test('handleWakeCalibrate writes profile file', async () => {
  const fsPromises = await import('node:fs/promises')
  const { req, res } = makeReqRes({ samples: ['base64abc', 'base64def'] })
  req.url = '/api/jarvis/wake-calibrate'
  await handleWakeCalibrate(req, res)
  expect(fsPromises.writeFile).toHaveBeenCalledOnce()
  expect(res.body.ok).toBe(true)
})

test('handleWakeCalibrate rejects missing samples', async () => {
  const { req, res } = makeReqRes({ samples: [] })
  await handleWakeCalibrate(req, res)
  expect(res.body.ok).toBe(false)
  expect(res.body.error).toBe('samples_required')
})
