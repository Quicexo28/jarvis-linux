// The Jarvis "brain": turns a natural-language message into a sequence of
// capability (tool) calls executed in the frontend, then a short spoken reply.
//
// All brains share one interface so they are swappable without touching the
// registry, the WebSocket bridge, or the frontend:
//
//   brain.name                                   -> string id
//   brain.runTurn({ sessionId, message, snapshot, tools, callTool })
//        -> Promise<{ ok: boolean, text: string }>
//
//   tools    : capability schemas announced by the frontend (dynamic registry)
//   callTool : async (capId, params) => { ok, result, snapshot }  (RPC to UI)
//
// Providers:
//   - heuristic    : offline, zero-deps rule planner. Default + safety fallback.
//   - agent-sdk    : Claude via @anthropic-ai/claude-agent-sdk, authenticated
//                    with the user's Claude SUBSCRIPTION (no API key). Personal
//                    /local use. Select with JARVIS_BRAIN=agent-sdk.
//   - messages-api : Claude via @anthropic-ai/sdk + ANTHROPIC_API_KEY. Use this
//                    only when distributing Jarvis to other users (policy).

import { env } from 'node:process'

export function createBrain() {
  const kind = env.JARVIS_BRAIN || 'heuristic'
  if (kind === 'agent-sdk') return makeLazyBrain('agent-sdk', loadAgentSdkBrain)
  if (kind === 'messages-api') return makeLazyBrain('messages-api', loadMessagesApiBrain)
  return heuristicBrain()
}

// Wraps a provider whose real implementation is dynamically imported on first
// use. If the SDK/auth is unavailable, we degrade to the heuristic brain so the
// app keeps navigating instead of going dark.
function makeLazyBrain(name, loader) {
  let implPromise = null
  const fallback = heuristicBrain()
  return {
    name,
    async runTurn(args) {
      try {
        if (!implPromise) implPromise = loader()
        const impl = await implPromise
        return await impl.runTurn(args)
      } catch (err) {
        implPromise = null
        console.warn(`[jarvis] brain '${name}' unavailable, using heuristic fallback:`, err?.message ?? err)
        return fallback.runTurn(args)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function normalize(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Spanish vocabulary → Mode id. Ordered: more specific keys first so "3d" wins
// over the bare "plano" entry.
const MODE_KEYWORDS = [
  ['plan3d', ['editor 3d', 'espacio 3d', 'plano 3d', '3d', 'construccion']],
  ['space', ['inmersivo', 'inmersion', 'recorrido', 'primera persona', 'holografico']],
  ['plan2d', ['plano 2d', '2d', 'plano', 'dibujo']],
  ['system', ['sistema', 'system', 'estadistica', 'telemetria', 'panel de estado']],
  ['cloud', ['nube', 'cloud', 'archivos']],
  ['house', ['casa', 'hogar', 'torre']],
  ['home', ['core', 'inicio', 'principal', 'centro de mando']],
]

function detectMode(text) {
  for (const [mode, kws] of MODE_KEYWORDS) {
    if (kws.some((k) => text.includes(k))) return mode
  }
  return null
}

const TIMER_WORDS = /(temporizador|cuenta atras|cuenta regresiva|alarma|timer|recuerdame en|avisame en)/

function parseDurationSeconds(text) {
  const m = text.match(/(\d+)\s*(h|hora|horas|m|min|minuto|minutos|s|seg|segundo|segundos)?/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n)) return null
  const unit = m[2] ?? 's'
  if (/^h/.test(unit)) return n * 3600
  if (/^m/.test(unit)) return n * 60
  return n
}

export function buildSystemPrompt(snapshot) {
  return [
    'Eres Jarvis, el agente operativo de una app de hogar inteligente.',
    'No eres un chatbot: controlas la interfaz llamando a las herramientas disponibles.',
    'Responde SIEMPRE en español, en una o dos frases cortas, confirmando lo que hiciste.',
    'Usa varias herramientas en orden cuando el usuario pida acciones encadenadas.',
    'Si no hay una herramienta adecuada, dilo brevemente en vez de inventar.',
    '',
    'Estado actual de la app (snapshot):',
    JSON.stringify(snapshot ?? {}, null, 0),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Heuristic brain (default, offline)
// ---------------------------------------------------------------------------

export function heuristicBrain() {
  return { name: 'heuristic', runTurn: runHeuristicTurn }
}

function planTurn(message, tools) {
  const text = normalize(message)
  const has = new Set((tools ?? []).map((t) => t.name))
  const plan = []

  if (/\b(atras|volver|cierra|cerrar|salir|regresa)\b/.test(text) && has.has('nav.back')) {
    plan.push({ capId: 'nav.back', params: {} })
  }
  if (/\b(siguiente|derecha)\b/.test(text) && has.has('nav.ring.rotate')) {
    plan.push({ capId: 'nav.ring.rotate', params: { dir: 1 } })
  }
  if (/\b(anterior|izquierda)\b/.test(text) && has.has('nav.ring.rotate')) {
    plan.push({ capId: 'nav.ring.rotate', params: { dir: -1 } })
  }

  if (TIMER_WORDS.test(text) && has.has('timer.start')) {
    const seconds = parseDurationSeconds(text)
    if (seconds && seconds > 0) plan.push({ capId: 'timer.start', params: { seconds } })
  }

  const mode = detectMode(text)
  if (mode && has.has('nav.goto')) plan.push({ capId: 'nav.goto', params: { mode } })

  if (/(ultim|reciente)/.test(text) && /(carga|cargar|abre|abrir|proyecto|plano)/.test(text) && has.has('plan.loadLast')) {
    plan.push({ capId: 'plan.loadLast', params: {} })
  }

  if (/(duerme|duermete|apaga el sistema|reposo|a dormir)/.test(text) && has.has('system.sleep')) {
    plan.push({ capId: 'system.sleep', params: {} })
  }

  if (plan.length === 0 && /(que tengo|donde estoy|que hay|estado actual|en que modo|que ves)/.test(text) && has.has('query.state')) {
    plan.push({ capId: 'query.state', params: {} })
  }

  return plan
}

async function runHeuristicTurn({ message, tools, callTool }) {
  const plan = planTurn(message, tools)
  if (!plan.length) {
    return {
      ok: false,
      text: 'No entendí esa orden todavía. Puedo navegar entre vistas, abrir el editor 3D o cargar el último proyecto.',
    }
  }
  const details = []
  for (const step of plan) {
    let res
    try {
      res = await callTool(step.capId, step.params)
    } catch (err) {
      details.push(`No pude ejecutar ${step.capId} (${String(err?.message ?? err)})`)
      continue
    }
    const detail = res?.result?.detail
    if (res?.ok && detail) details.push(detail)
    else details.push(detail || `No pude completar ${step.capId}`)
  }
  return { ok: true, text: details.join('. ') + '.' }
}

// ---------------------------------------------------------------------------
// Claude Agent SDK brain (subscription auth) — opt-in, lazily imported
// ---------------------------------------------------------------------------

async function loadAgentSdkBrain() {
  // Requires: npm i @anthropic-ai/claude-agent-sdk zod   (in backend/)
  // Auth: uses the logged-in Claude SUBSCRIPTION automatically (`claude` login)
  // or a CLAUDE_CODE_OAUTH_TOKEN. We deliberately do NOT set ANTHROPIC_API_KEY
  // here so the subscription is used. API version/shape may evolve — verify
  // against the installed SDK version.
  const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  function zodShapeFor(schema) {
    const shape = {}
    const props = schema?.properties ?? {}
    const required = new Set(schema?.required ?? [])
    for (const [key, def] of Object.entries(props)) {
      let z1
      if (def.enum) z1 = z.enum(def.enum)
      else if (def.type === 'number') z1 = z.number()
      else if (def.type === 'boolean') z1 = z.boolean()
      else z1 = z.string()
      shape[key] = required.has(key) ? z1 : z1.optional()
    }
    return shape
  }

  return {
    name: 'agent-sdk',
    async runTurn({ message, snapshot, tools, callTool }) {
      const sdkTools = (tools ?? []).map((t) =>
        tool(t.name, t.description, zodShapeFor(t.input_schema), async (params) => {
          const res = await callTool(t.name, params)
          return { content: [{ type: 'text', text: JSON.stringify(res?.result ?? res ?? {}) }] }
        }),
      )
      const server = createSdkMcpServer({ name: 'jarvis-ui', version: '1.0.0', tools: sdkTools })

      let text = ''
      for await (const evt of query({
        prompt: message,
        options: {
          systemPrompt: buildSystemPrompt(snapshot),
          mcpServers: { 'jarvis-ui': server },
          permissionMode: 'bypassPermissions', // tools are our own gated registry
          model: env.JARVIS_MODEL || undefined,
        },
      })) {
        if (evt?.type === 'assistant') {
          for (const block of evt.message?.content ?? []) {
            if (block.type === 'text') text += block.text
          }
        } else if (evt?.type === 'result' && typeof evt.result === 'string') {
          if (!text) text = evt.result
        }
      }
      return { ok: true, text: text.trim() || 'Listo.' }
    },
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API brain (API key) — for distribution, lazily imported
// ---------------------------------------------------------------------------

async function loadMessagesApiBrain() {
  // Requires: npm i @anthropic-ai/sdk   (in backend/)  + ANTHROPIC_API_KEY env.
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const model = env.JARVIS_MODEL || 'claude-sonnet-4-6'
  const MAX_STEPS = Number(env.JARVIS_MAX_STEPS ?? 8)

  return {
    name: 'messages-api',
    async runTurn({ message, snapshot, tools, callTool }) {
      const apiTools = (tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }))
      const messages = [{ role: 'user', content: message }]
      let text = ''

      for (let step = 0; step < MAX_STEPS; step++) {
        const resp = await client.messages.create({
          model,
          max_tokens: 1024,
          system: buildSystemPrompt(snapshot),
          tools: apiTools,
          messages,
        })
        messages.push({ role: 'assistant', content: resp.content })
        for (const block of resp.content) {
          if (block.type === 'text') text += block.text
        }
        if (resp.stop_reason !== 'tool_use') break

        const toolResults = []
        for (const block of resp.content) {
          if (block.type !== 'tool_use') continue
          const res = await callTool(block.name, block.input)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(res?.result ?? res ?? {}),
          })
        }
        messages.push({ role: 'user', content: toolResults })
      }

      return { ok: true, text: text.trim() || 'Listo.' }
    },
  }
}
