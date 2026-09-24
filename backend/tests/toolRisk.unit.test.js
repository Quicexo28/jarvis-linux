import { describe, it, expect, beforeEach } from 'vitest'
import { riskOf, RISK, checkToolRisk } from '../src/lib/toolRisk.js'
import { setSpeakerMode } from '../src/lib/speakerContext.js'
import { markInteraction } from '../src/lib/attentionState.js'

const modelReq = (url) => ({ url, headers: { 'x-jarvis-origin': 'model', 'x-jarvis-tool': 'test' } })
const uiReq = (url) => ({ url, headers: {} })

describe('riskOf', () => {
  it('classifies self-modification and machine control as destructive', () => {
    for (const p of [
      '/api/skills/code/task', '/api/skills/code/rollback', '/api/skills/system/power',
      '/api/skills/system/terminal', '/api/skills/system/process', '/api/agents/rpc',
      '/api/pc/kill', '/api/pc/type', '/api/security/unlock',
    ]) {
      expect(riskOf(p), p).toBe(RISK.DESTRUCTIVE)
    }
  })

  it('keeps code/task/status a read even though it sits under a destructive prefix', () => {
    expect(riskOf('/api/skills/code/task/status')).toBe(RISK.READ)
  })

  it('classifies listings and status as reads', () => {
    for (const p of ['/api/skills/timer/list', '/api/skills/view/current',
                     '/api/skills/projector/status', '/api/agents/list']) {
      expect(riskOf(p), p).toBe(RISK.READ)
    }
  })

  it('treats the vault graph as a read but focusing a node as a write', () => {
    // Leer el grafo del propio vault no cambia nada; mover la cámara del
    // renderer sí toca la pantalla del señor.
    expect(riskOf('/api/skills/vault/graph')).toBe(RISK.READ)
    expect(riskOf('/api/skills/vault/focus')).toBe(RISK.WRITE)
  })

  it('defaults an unknown route to write, not read', () => {
    expect(riskOf('/api/skills/algo/nuevo')).toBe(RISK.WRITE)
  })

  it('ignores the query string', () => {
    expect(riskOf('/api/skills/timer/list?x=1')).toBe(RISK.READ)
  })
})

describe('checkToolRisk', () => {
  beforeEach(() => {
    setSpeakerMode('OWNER', 'santiago')
    markInteraction()
  })

  it('never gates traffic that is not a model tool call', () => {
    setSpeakerMode('UNKNOWN', null)
    expect(checkToolRisk(uiReq('/api/skills/system/power')).allowed).toBe(true)
  })

  it('lets a fresh owner do anything', () => {
    expect(checkToolRisk(modelReq('/api/skills/code/task')).allowed).toBe(true)
    expect(checkToolRisk(modelReq('/api/skills/timer/start')).allowed).toBe(true)
  })

  it('lets a known speaker write but not destroy', () => {
    setSpeakerMode('KNOWN', 'otro')
    expect(checkToolRisk(modelReq('/api/skills/timer/start')).allowed).toBe(true)
    const denied = checkToolRisk(modelReq('/api/skills/system/power'))
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('KNOWN_cannot_destructive')
    expect(denied.spoken).toBeTruthy()
  })

  it('lets an unrecognised voice look but not touch', () => {
    setSpeakerMode('UNKNOWN', null)
    expect(checkToolRisk(modelReq('/api/skills/timer/list')).allowed).toBe(true)
    expect(checkToolRisk(modelReq('/api/skills/timer/start')).allowed).toBe(false)
  })

  it('refuses a destructive action when the owner match has gone stale', async () => {
    // Shrink the freshness window instead of faking the clock; the value is
    // read per call.
    const prev = process.env.JARVIS_RISK_OWNER_FRESH_MS
    process.env.JARVIS_RISK_OWNER_FRESH_MS = '1'
    await new Promise((r) => setTimeout(r, 5))
    const res = checkToolRisk(modelReq('/api/skills/code/task'))
    process.env.JARVIS_RISK_OWNER_FRESH_MS = prev ?? ''
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('owner_match_stale')
  })

  it('still allows reads for a stale owner', async () => {
    const prev = process.env.JARVIS_RISK_OWNER_FRESH_MS
    process.env.JARVIS_RISK_OWNER_FRESH_MS = '1'
    await new Promise((r) => setTimeout(r, 5))
    const res = checkToolRisk(modelReq('/api/skills/timer/list'))
    process.env.JARVIS_RISK_OWNER_FRESH_MS = prev ?? ''
    expect(res.allowed).toBe(true)
  })

  it('honours the kill switch', () => {
    setSpeakerMode('UNKNOWN', null)
    process.env.JARVIS_RISK_GATE = '0'
    const res = checkToolRisk(modelReq('/api/skills/system/power'))
    delete process.env.JARVIS_RISK_GATE
    expect(res.allowed).toBe(true)
  })
})
