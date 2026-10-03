/**
 * Puente Jarvis ↔ Agent Hub. Se prueba contra un hub FALSO en un puerto libre:
 * lo que importa es el contrato (headers anti-CSRF, forma de los cuerpos,
 * resolución de proyectos por nombre hablado) y la clasificación de riesgo.
 */
import { test, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectDir, spokenSummary, handleClaudeLaunch, handleClaudeWatch, handleClaudeList } from '../src/handlers/claudeAgents.js'
import { riskOf } from '../src/lib/toolRisk.js'

const calls = []
let hub
const projects = mkdtempSync(join(tmpdir(), 'projects-'))
for (const d of ['app-gym', 'jarvis-linux', 'pixelpoly']) mkdirSync(join(projects, d))

beforeAll(async () => {
  hub = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/options') return res.end(JSON.stringify({ projects: [join(projects, 'jarvis-linux')] }))
      if (req.url === '/api/agents/launch') return res.end(JSON.stringify({ ok: true, id: 'new-id', watched: true }))
      if (req.url === '/api/watch') {
        res.statusCode = 409
        return res.end(JSON.stringify({ ok: false, error: 'ambiguo: 2 agentes coinciden', candidates: [{ id: 'a' }, { id: 'b' }] }))
      }
      if (req.url.startsWith('/api/agents?compact=1')) return res.end(JSON.stringify({ ok: true, agents: [], usage: { ok: true } }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise((r) => hub.listen(0, '127.0.0.1', r))
  process.env.CLAUDE_HUB_URL = `http://127.0.0.1:${hub.address().port}`
  process.env.CLAUDE_HUB_PROJECTS_DIR = projects
})

afterAll(() => {
  hub?.close()
  delete process.env.CLAUDE_HUB_URL
  delete process.env.CLAUDE_HUB_PROJECTS_DIR
})

/** req/res mínimos para llamar a un handler sin servidor. */
function call(handler, { body, url = '/x' } = {}) {
  const req = Object.assign(new http.IncomingMessage(null), { url, method: body ? 'POST' : 'GET' })
  process.nextTick(() => { if (body) req.push(JSON.stringify(body)); req.push(null) })
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      writeHead(code) { this.statusCode = code },
      setHeader() {},
      end(data) { resolve({ status: this.statusCode, body: JSON.parse(data) }) },
    }
    handler(req, res)
  })
}

test('resolveProjectDir entiende nombres hablados', () => {
  expect(resolveProjectDir('app gym', [], projects)).toBe(join(projects, 'app-gym'))
  expect(resolveProjectDir('Jarvis', [], projects)).toBe(join(projects, 'jarvis-linux'))
  expect(resolveProjectDir('píxel poly', [], projects)).toBe(join(projects, 'pixelpoly'))
  expect(resolveProjectDir('inexistente', [], projects)).toBe(null)
  expect(resolveProjectDir(projects, [], projects)).toBe(projects)
})

test('spokenSummary deja una frase limpia para la voz', () => {
  expect(spokenSummary('**Listo.** Arreglé `login.ts` y los tests pasan.')).toBe('Listo.')
  expect(spokenSummary('```js\nx\n```\nHecho sin errores. Más detalle.')).toBe('Hecho sin errores.')
  expect(spokenSummary('a'.repeat(300)).length).toBeLessThanOrEqual(170)
})

test('launch resuelve el proyecto y manda origin=jarvis con header anti-CSRF', async () => {
  calls.length = 0
  const r = await call(handleClaudeLaunch, { body: { task: 'arregla el login', project: 'app gym', notify: true } })
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ ok: true, id: 'new-id', cwd: join(projects, 'app-gym') })
  const launch = calls.find((c) => c.url === '/api/agents/launch')
  expect(launch.headers['x-agent-hub']).toBe('1')
  expect(launch.body).toMatchObject({ prompt: 'arregla el login', origin: 'jarvis', notify: true, permissionMode: 'auto', model: 'sonnet' })
})

test('launch con proyecto desconocido no lanza nada', async () => {
  calls.length = 0
  const r = await call(handleClaudeLaunch, { body: { task: 'x', project: 'nada-que-ver' } })
  expect(r.status).toBe(400)
  expect(r.body.error).toBe('project_not_found')
  expect(calls.some((c) => c.url === '/api/agents/launch')).toBe(false)
})

test('watch ambiguo devuelve los candidatos para preguntar', async () => {
  const r = await call(handleClaudeWatch, { body: { agent: 'jarvis' } })
  expect(r.status).toBe(409)
  expect(r.body.candidates).toHaveLength(2)
})

test('list pide la vista compacta', async () => {
  const r = await call(handleClaudeList, { url: '/api/skills/claude/list' })
  expect(r.body.ok).toBe(true)
  expect(calls.at(-1).url).toBe('/api/agents?compact=1')
})

test('riesgo: listar es lectura, lanzar/ordenar es destructivo', () => {
  expect(riskOf('/api/skills/claude/list')).toBe('read')
  expect(riskOf('/api/skills/claude/launch')).toBe('destructive')
  expect(riskOf('/api/skills/claude/send')).toBe('destructive')
  expect(riskOf('/api/skills/claude/watch')).toBe('write')
})
