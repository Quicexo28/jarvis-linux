import { test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from '../src/handlers/static.js'

let distDir

function makeRes() {
  const headers = {}
  let body = null
  return {
    headers,
    setHeader(k, v) { headers[k] = v },
    end(data) { body = data ?? null },
    body: () => body,
  }
}

function makeReq(method, url) {
  return { method, url, headers: { host: 'localhost' } }
}

beforeAll(async () => {
  distDir = await mkdtemp(join(tmpdir(), 'jarvis-static-'))
  await writeFile(join(distDir, 'index.html'), '<html>Jarvis</html>')
  await mkdir(join(distDir, 'assets'))
  await writeFile(join(distDir, 'assets', 'main.js'), 'console.log("hi")')
  await writeFile(join(distDir, 'assets', 'style.css'), 'body{}')
})

afterAll(async () => {
  await rm(distDir, { recursive: true, force: true })
})

test('serves index.html for root path', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/'), res, distDir)
  expect(handled).toBe(true)
  expect(res.headers['Content-Type']).toContain('text/html')
  expect(res.body().toString()).toBe('<html>Jarvis</html>')
})

test('serves JS asset with correct content-type', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/assets/main.js'), res, distDir)
  expect(handled).toBe(true)
  expect(res.headers['Content-Type']).toContain('javascript')
})

test('serves CSS asset with correct content-type', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/assets/style.css'), res, distDir)
  expect(handled).toBe(true)
  expect(res.headers['Content-Type']).toContain('text/css')
})

test('returns false for any /api/* path — never served as static', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/api/health'), res, distDir)
  expect(handled).toBe(false)
})

test('SPA fallback: unknown path without extension serves index.html', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/some/deep/route'), res, distDir)
  expect(handled).toBe(true)
  expect(res.body().toString()).toBe('<html>Jarvis</html>')
})

test('returns false for non-GET/HEAD methods', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('POST', '/'), res, distDir)
  expect(handled).toBe(false)
})

test('HEAD request returns headers without body', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('HEAD', '/index.html'), res, distDir)
  expect(handled).toBe(true)
  expect(res.body()).toBeNull()
  expect(res.headers['Content-Type']).toContain('text/html')
})

test('rejects path traversal attempts', async () => {
  const res = makeRes()
  const handled = await serveStatic(makeReq('GET', '/../../../etc/passwd'), res, distDir)
  expect(handled).toBe(false)
})
