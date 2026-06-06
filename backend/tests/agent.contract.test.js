// backend/tests/agent.contract.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { dispatch } from '../src/routes.js'

let server
let base

beforeAll(async () => {
  process.env.JARVIS_FAKE_CLAUDE = '1'
  server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    await dispatch(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((r) => server.close(r)))

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

async function get(path) {
  const r = await fetch(`${base}${path}`)
  return { status: r.status, body: await r.json() }
}

describe('Obsidian skill endpoints', () => {
  it('POST /api/skills/obsidian/task — 400 on missing text', async () => {
    const { status, body } = await post('/api/skills/obsidian/task', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_text')
  })

  it('POST /api/skills/obsidian/task — responds (ok or error, not 404)', async () => {
    const { status } = await post('/api/skills/obsidian/task', { text: 'Test task' })
    expect(status).not.toBe(404)
  })

  it('POST /api/skills/obsidian/note — 400 on missing body', async () => {
    const { status, body } = await post('/api/skills/obsidian/note', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_body')
  })

  it('POST /api/skills/obsidian/note — responds (ok or error, not 404)', async () => {
    const { status } = await post('/api/skills/obsidian/note', { body: 'Test note' })
    expect(status).not.toBe(404)
  })

  it('GET /api/skills/obsidian/tasks — responds with tasks array or error', async () => {
    const { status, body } = await get('/api/skills/obsidian/tasks')
    expect(status).not.toBe(404)
    if (status === 200) expect(Array.isArray(body.result?.tasks)).toBe(true)
  })

  it('POST /api/skills/obsidian/search — 400 on missing query', async () => {
    const { status, body } = await post('/api/skills/obsidian/search', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_query')
  })

  it('POST /api/skills/obsidian/personalize — 400 on missing fact', async () => {
    const { status, body } = await post('/api/skills/obsidian/personalize', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_fact')
  })
})

describe('Cloud skill endpoints', () => {
  it('POST /api/skills/cloud/save — 400 on missing content', async () => {
    const { status, body } = await post('/api/skills/cloud/save', {})
    expect(status).toBe(400)
    expect(body.error).toBe('missing_content')
  })

  it('POST /api/skills/cloud/save — responds with saved file info (when cloud dir available)', async () => {
    const { status, body } = await post('/api/skills/cloud/save', { content: 'hello test' })
    expect(status).not.toBe(404)
    if (status === 200) {
      expect(body.ok).toBe(true)
      expect(typeof body.result.filename).toBe('string')
    }
  })

  it('GET /api/skills/cloud/list — 200 with files array', async () => {
    const { status, body } = await get('/api/skills/cloud/list')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.result.files)).toBe(true)
  })
})
