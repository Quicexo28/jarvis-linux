import { describe, it, expect } from 'vitest'
import { planApply, extractSummary } from '../src/lib/devAgent.js'
import { classifyIntent } from '../src/lib/intentClassifier.js'

const ENGAGED_CTX = { state: 'ENGAGED', speakerConfidence: 1.0, alwaysOn: true }

describe('planApply — changed files to apply actions', () => {
  it('backend source needs a backend restart, nothing else', () => {
    const p = planApply(['backend/src/handlers/speech.js'])
    expect(p.restartBackend).toBe(true)
    expect(p.buildFrontend).toBe(false)
    expect(p.services).toEqual([])
  })

  it('frontend source needs a Tauri rebuild, not a backend restart', () => {
    const p = planApply(['frontend/src/App.tsx'])
    expect(p.buildFrontend).toBe(true)
    expect(p.restartBackend).toBe(false)
  })

  it('routes python services by file name', () => {
    expect(planApply(['backend/voice/python/stt_service.py']).services).toEqual(['jarvis-stt'])
    expect(planApply(['backend/voice/python/xtts_service.py']).services).toEqual(['jarvis-tts'])
    expect(planApply(['backend/voice/python/wake_service.py']).services).toEqual(['jarvis-wake'])
  })

  it('shared python modules fall back to the STT service that imports them', () => {
    expect(planApply(['backend/voice/python/speaker_id.py']).services).toEqual(['jarvis-stt'])
  })

  it('package.json changes trigger npm install plus the backend restart', () => {
    const p = planApply(['backend/package.json'])
    expect(p.npmInstall).toBe(true)
    expect(p.restartBackend).toBe(true)
  })

  it('unit files exist for service units: daemon-reload', () => {
    const p = planApply(['scripts/linux/jarvis-backend.service'])
    expect(p.daemonReload).toBe(true)
    expect(p.restartBackend).toBe(false)
  })

  it('runtime data and tests do NOT restart the backend', () => {
    const p = planApply(['backend/data/dev-jobs/x.json', 'backend/tests/sanity.test.js'])
    expect(p.restartBackend).toBe(false)
    expect(p.buildFrontend).toBe(false)
    expect(p.services).toEqual([])
  })

  it('deduplicates services across several files', () => {
    const p = planApply([
      'backend/voice/python/stt_service.py',
      'backend/voice/python/speaker_id.py',
      'backend/src/lib/devAgent.js',
    ])
    expect(p.services).toEqual(['jarvis-stt'])
    expect(p.restartBackend).toBe(true)
  })
})

describe('extractSummary', () => {
  it('picks the RESUMEN line', () => {
    const s = extractSummary('Hice varias cosas.\n\nRESUMEN: Ajusté el umbral del aplauso y pasan los tests.')
    expect(s).toBe('Ajusté el umbral del aplauso y pasan los tests.')
  })

  it('falls back to the last line when the agent skips the marker', () => {
    expect(extractSummary('paso uno\npaso dos\nlisto el cambio')).toBe('listo el cambio')
  })

  it('strips markdown from the fallback line', () => {
    expect(extractSummary('**hecho el cambio**')).toBe('hecho el cambio')
  })

  it('returns empty string for empty output', () => {
    expect(extractSummary('')).toBe('')
    expect(extractSummary(null)).toBe('')
  })
})

describe('self-code routes are registered', () => {
  it('exposes the task endpoints with real handlers', async () => {
    const { routes } = await import('../src/routes.js')
    const paths = [
      '/api/skills/code/task',
      '/api/skills/code/task/status',
      '/api/skills/code/task/cancel',
    ]
    for (const p of paths) {
      const r = routes.find((x) => x.path === p && x.method === 'POST')
      expect(r, `missing route ${p}`).toBeTruthy()
      expect(typeof r.handler).toBe('function')
    }
  })
})

describe('self_code intent', () => {
  const cases = [
    'modifica tu código para que el aplauso sea menos sensible',
    'arregla el código del backend, se cae al reiniciar',
    'añade una función a tu frontend que muestre la batería',
    'cambia en tu código el tiempo de espera del micrófono',
    'reprográmate para hablar más rápido',
  ]
  for (const text of cases) {
    it(`detects "${text}"`, () => {
      expect(classifyIntent(text, ENGAGED_CTX).intentTag).toBe('self_code')
    })
  }

  it('does NOT hijack read-only review requests', () => {
    expect(classifyIntent('revisa tu código y dime qué opinas', ENGAGED_CTX).intentTag).not.toBe('self_code')
  })

  it('does NOT hijack the self_build camera phrases', () => {
    expect(classifyIntent('tómame una foto', ENGAGED_CTX).intentTag).toBe('self_build')
  })

  it('does NOT fire on ordinary file commands', () => {
    expect(classifyIntent('mueve el archivo de descargas a documentos', ENGAGED_CTX).intentTag).not.toBe('self_code')
  })
})
