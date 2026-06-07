import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/skillBus.js', () => ({
  requestClient: vi.fn().mockResolvedValue({ ok: true }),
  hasClient: vi.fn(() => true),
}))

const mockRes = () => {
  const r = { statusCode: 200, headers: {}, body: '' }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.end = (b) => { r.body = b }
  return r
}

function makeReq(bodyObj) {
  const body = JSON.stringify(bodyObj)
  const req = {
    method: 'POST',
    headers: { 'content-length': String(body.length), 'content-type': 'application/json' },
  }
  req.on = (e, cb) => {
    if (e === 'data') cb(Buffer.from(body))
    if (e === 'end') cb()
    return req
  }
  return req
}

describe('handleUiState', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pip state pushes boot_pip primitive', async () => {
    const { requestClient } = await import('../src/lib/skillBus.js')
    const { handleUiState } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleUiState(makeReq({ state: 'pip' }), res)
    expect(requestClient).toHaveBeenCalledWith('boot_pip', {})
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('awake state pushes boot_awake primitive', async () => {
    const { requestClient } = await import('../src/lib/skillBus.js')
    const { handleUiState } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleUiState(makeReq({ state: 'awake' }), res)
    expect(requestClient).toHaveBeenCalledWith('boot_awake', {})
  })

  it('invalid state returns 400', async () => {
    const { handleUiState } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleUiState(makeReq({ state: 'invalid' }), res)
    expect(JSON.parse(res.body).ok).toBe(false)
    expect(res.statusCode).toBe(400)
  })
})

describe('handleGestureToggle', () => {
  it('pushes gesture_set with enabled flag', async () => {
    const { requestClient } = await import('../src/lib/skillBus.js')
    const { handleGestureToggle } = await import('../src/handlers/uiState.js')
    const res = mockRes()
    await handleGestureToggle(makeReq({ enabled: true }), res)
    expect(requestClient).toHaveBeenCalledWith('gesture_set', { enabled: true })
  })
})
