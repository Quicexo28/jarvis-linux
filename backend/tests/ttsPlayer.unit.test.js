import { describe, it, expect } from 'vitest'
import { spawn, execFileSync } from 'child_process'
import { killProcessGroup } from '../src/lib/ttsPlayer.js'

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('killProcessGroup', () => {
  it('mata sh y todos sus hijos en menos de 500 ms', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 | sleep 30'], { stdio: 'ignore', detached: true })
    await new Promise(r => setTimeout(r, 200))
    let kids = []
    try { kids = execFileSync('pgrep', ['-P', String(child.pid)]).toString().trim().split('\n').map(Number) } catch {}
    expect(kids.length).toBeGreaterThan(0)
    const pids = [child.pid, ...kids]
    const t0 = Date.now()
    killProcessGroup(child)
    while (pids.some(alive) && Date.now() - t0 < 500) await new Promise(r => setTimeout(r, 10))
    expect(pids.filter(alive)).toEqual([])
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('no lanza si el grupo ya no existe', () => {
    expect(() => killProcessGroup({ pid: 2 ** 22 + 12345 })).not.toThrow()
  })
})
