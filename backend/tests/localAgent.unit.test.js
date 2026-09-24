/**
 * The laptop-as-a-machine shim. Parsing is the part that can silently lie
 * (a wrong column and every process shows the wrong size), so it is pinned here.
 */
import { test, expect } from 'vitest'
import { parsePs, localMachineName, localMachineEntry, localOp, LOCAL_OPS } from '../src/lib/localAgent.js'

test('parsePs reads pid/rss/cpu/comm and sorts by memory', () => {
  const out = [
    '   1234    524288  3.5 firefox',
    '     42      2048  0.0 kworker/0:1',
    '   9999   1048576 12.0 node',
  ].join('\n')
  const procs = parsePs(out)
  expect(procs.map((p) => p.name)).toEqual(['node', 'firefox', 'kworker/0:1'])
  expect(procs[0]).toEqual({ pid: 9999, name: 'node', cpu_percent: 12, mem_mb: 1024 })
  expect(procs[1].mem_mb).toBe(512)
})

test('parsePs ignores headers and blank lines', () => {
  expect(parsePs('  PID   RSS %CPU COMMAND\n\n  7 1024 0.1 init')).toHaveLength(1)
})

test('parsePs keeps command names with spaces', () => {
  expect(parsePs('  7 1024 0.1 Web Content')[0].name).toBe('Web Content')
})

test('the local entry is online and flagged so the UI can label it', () => {
  const entry = localMachineEntry()
  expect(entry.name).toBe(localMachineName())
  expect(entry.online).toBe(true)
  expect(entry.local).toBe(true)
  // The app runs on a tablet: the laptop needs a name, not "this PC".
  expect(entry.label).toBe('Jarvis Main')
})

test('sys_info returns protocol-shaped, in-range values', async () => {
  const r = await localOp({ op: 'sys_info' })
  expect(r.status).toBe('sys_info')
  expect(r.cpu_percent).toBeGreaterThanOrEqual(0)
  expect(r.cpu_percent).toBeLessThanOrEqual(100)
  expect(r.mem_used_mb).toBeLessThanOrEqual(r.mem_total_mb)
  expect(r.uptime_secs).toBeGreaterThan(0)
})

test('unknown ops come back as a denied error, never as execution', async () => {
  expect(LOCAL_OPS.has('exec')).toBe(false)
  const r = await localOp({ op: 'exec', params: { command: 'whoami' } })
  expect(r.status).toBe('error')
  expect(r.denied).toBe(true)
})

test('search is bounded by max_results', async () => {
  const r = await localOp({ op: 'search', params: { query: '', root: process.cwd(), max_results: 3 } })
  expect(r.status).toBe('search')
  expect(r.hits.length).toBeLessThanOrEqual(3)
  for (const h of r.hits) expect(typeof h.path.raw).toBe('string')
})
