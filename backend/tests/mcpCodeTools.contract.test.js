/**
 * The voice brain only reaches a backend capability if the MCP server actually
 * advertises a tool for it. This drives the real stdio JSON-RPC handshake and
 * asserts the self-development tools are listed and point at the code routes —
 * the failure mode this catches is "handler exists, tool forgotten", which is
 * invisible from the backend side.
 */
import { test, expect } from 'vitest'
import { spawn } from 'child_process'
import { execPath } from 'node:process'
import { resolve } from 'node:path'

const SERVER = resolve(import.meta.dirname, '..', 'mcp-server', 'jarvis-mcp.js')

function listTools() {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { p.kill(); reject(new Error('mcp tools/list timeout')) }, 15000)
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += String(d)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
        } else if (msg.id === 2) {
          clearTimeout(timer)
          p.kill()
          resolvePromise(msg.result?.tools || [])
        }
      }
    })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }) + '\n')
  })
}

test('MCP server advertises the self-development tools', async () => {
  const tools = await listTools()
  const names = tools.map((t) => t.name)
  for (const n of ['code_task', 'code_task_status', 'code_run', 'code_checkpoint', 'code_rollback', 'code_restart']) {
    expect(names, `missing MCP tool ${n}`).toContain(n)
  }
}, 20000)

test('code_task requires an instruction and describes itself in Spanish', async () => {
  const tools = await listTools()
  const t = tools.find((x) => x.name === 'code_task')
  expect(t.inputSchema.required).toEqual(['instruction'])
  expect(t.description).toMatch(/CÓDIGO FUENTE/)
  // The brain must know not to wait for it inside the turn.
  expect(t.description).toMatch(/ASÍNCRONA/)
}, 20000)
