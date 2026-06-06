// Semantic action router (Tier-0 fast-path).
//
// High-frequency, unambiguous, single-action commands are matched and executed
// locally with ZERO model calls and ~0 latency. Everything else is forwarded to
// the brain. This replaces the brittle keyword-only classifyIntent for the
// "execute now" path while keeping graceful degradation when the brain is down.
import { executeCapability } from './registry'
import { setupAgent } from './index'
import type { Mode } from '../types'

export type RouteResult =
  | { kind: 'handled'; detail: string } // Tier-0 ran a capability locally
  | { kind: 'forward' }                 // hand off to the brain (Tier-1)
  | { kind: 'ignored' }                 // ambient / empty

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

// Ordered so specific keys (3d) win over generic ones (plano/2d).
const MODE_KEYWORDS: [Mode, string[]][] = [
  ['plan3d', ['editor 3d', 'espacio 3d', 'plano 3d', '3d']],
  ['space', ['inmersivo', 'inmersion', 'primera persona', 'holografico']],
  ['plan2d', ['plano 2d', 'plano', 'dibujo', '2d']],
  ['system', ['sistema', 'system', 'estadistica', 'telemetria']],
  ['cloud', ['nube', 'cloud']],
  ['house', ['casa', 'hogar', 'torre']],
  ['home', ['core', 'inicio', 'principal']],
]

function detectMode(text: string): Mode | null {
  for (const [mode, kws] of MODE_KEYWORDS) {
    if (kws.some((k) => text.includes(k))) return mode
  }
  return null
}

const GOTO_VERBS = /(modo|ve a|vamos a|ir a|llevame|abre|abrir|muestra|cambia a)/
const TIMER_WORDS = /(temporizador|cuenta atras|cuenta regresiva|alarma|timer|recuerdame en|avisame en)/

// Parses a duration from text, e.g. "30 segundos", "2 min", "1 hora" -> seconds.
export function parseDurationSeconds(text: string): number | null {
  const m = text.match(/(\d+)\s*(h|hora|horas|m|min|minuto|minutos|s|seg|segundo|segundos)?/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n)) return null
  const unit = m[2] ?? 's'
  if (/^h/.test(unit)) return n * 3600
  if (/^m/.test(unit)) return n * 60
  return n
}

export async function routeUtterance(text: string): Promise<RouteResult> {
  setupAgent()
  const raw = (text ?? '').trim()
  if (!raw) return { kind: 'ignored' }

  const norm = normalize(raw)
  const words = norm.split(/\s+/)

  // Timer first: deterministic and frequently phrased with >5 words, so handle
  // it before the multi-action/length gate below.
  if (TIMER_WORDS.test(norm)) {
    const seconds = parseDurationSeconds(norm)
    if (seconds && seconds > 0) {
      const out = await executeCapability('timer.start', { seconds })
      return { kind: 'handled', detail: out.result.detail ?? 'Listo.' }
    }
  }

  // Multi-action ("...y...") or long utterances go to the brain.
  const isMultiAction = / y | luego | despues /.test(` ${norm} `) || words.length > 5
  if (isMultiAction) return { kind: 'forward' }

  // Back / close
  if (/\b(atras|volver|cierra|cerrar|salir|regresa)\b/.test(norm)) {
    const out = await executeCapability('nav.back', {})
    return { kind: 'handled', detail: out.result.detail ?? 'Listo.' }
  }
  // Carousel rotation
  if (/\b(siguiente|derecha)\b/.test(norm)) {
    const out = await executeCapability('nav.ring.rotate', { dir: 1 })
    return { kind: 'handled', detail: out.result.detail ?? 'Listo.' }
  }
  if (/\b(anterior|izquierda)\b/.test(norm)) {
    const out = await executeCapability('nav.ring.rotate', { dir: -1 })
    return { kind: 'handled', detail: out.result.detail ?? 'Listo.' }
  }
  // Direct navigation to a known mode
  const mode = detectMode(norm)
  if (mode && (GOTO_VERBS.test(norm) || words.length <= 3)) {
    const out = await executeCapability('nav.goto', { mode })
    return { kind: 'handled', detail: out.result.detail ?? 'Listo.' }
  }

  return { kind: 'forward' }
}
