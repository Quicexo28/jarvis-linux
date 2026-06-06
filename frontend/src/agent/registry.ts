// Capability registry: the single source of truth for what the agent can do.
//
// Capabilities are declarative (schema + Spanish description) with an imperative
// `run()` that mutates app state. The registry validates params, gates sensitive
// actions, executes, and returns the resulting CapabilityResult plus a fresh
// snapshot — the structural feedback the brain uses to decide its next step.
import { buildSnapshot } from './snapshot'
import type { Capability, ExecuteOutcome, ParamSchema, ToolSchema } from './types'

const capabilities = new Map<string, Capability>()

export function registerCapability(cap: Capability): void {
  capabilities.set(cap.id, cap)
}

export function registerCapabilities(list: Capability[]): void {
  for (const cap of list) registerCapability(cap)
}

export function listCapabilities(): Capability[] {
  return [...capabilities.values()]
}

export function getCapability(id: string): Capability | undefined {
  return capabilities.get(id)
}

// For tests / hot-reload isolation.
export function resetRegistry(): void {
  capabilities.clear()
}

// What we announce to the brain over the WS handshake.
export function toToolSchemas(): ToolSchema[] {
  return listCapabilities().map((cap) => ({
    name: cap.id,
    description: cap.sensitive ? `${cap.description} (requiere confirmación)` : cap.description,
    input_schema: cap.params,
  }))
}

function validateParams(schema: ParamSchema, params: Record<string, unknown>): { ok: boolean; detail?: string } {
  for (const key of schema.required ?? []) {
    if (params[key] === undefined || params[key] === null) {
      return { ok: false, detail: `Falta el parámetro requerido '${key}'.` }
    }
  }
  for (const [key, value] of Object.entries(params)) {
    const def = schema.properties[key]
    if (!def) continue // ignore unknown extras rather than reject
    if (def.enum && !def.enum.includes(value as string | number)) {
      return { ok: false, detail: `Valor inválido para '${key}': ${String(value)}.` }
    }
    if (def.type === 'number' && typeof value !== 'number') {
      return { ok: false, detail: `'${key}' debe ser numérico.` }
    }
    if (def.type === 'boolean' && typeof value !== 'boolean') {
      return { ok: false, detail: `'${key}' debe ser booleano.` }
    }
  }
  return { ok: true }
}

export type ExecuteOptions = { allowSensitive?: boolean }

export async function executeCapability(
  id: string,
  params: Record<string, unknown> = {},
  options: ExecuteOptions = {},
): Promise<ExecuteOutcome> {
  const cap = capabilities.get(id)
  if (!cap) {
    return { ok: false, result: { ok: false, detail: `Capacidad desconocida: ${id}.` }, snapshot: buildSnapshot() }
  }

  const valid = validateParams(cap.params, params)
  if (!valid.ok) {
    return { ok: false, result: { ok: false, detail: valid.detail }, snapshot: buildSnapshot() }
  }

  // Security gate: sensitive capabilities are refused unless the caller has
  // collected explicit user confirmation. The brain sees this and can ask.
  if (cap.sensitive && !options.allowSensitive) {
    return {
      ok: false,
      result: { ok: false, detail: `'${cap.id}' requiere confirmación del usuario antes de ejecutarse.` },
      snapshot: buildSnapshot(),
    }
  }

  try {
    const result = await cap.run(params)
    return { ok: result.ok !== false, result, snapshot: buildSnapshot() }
  } catch (err) {
    return {
      ok: false,
      result: { ok: false, detail: `Error ejecutando ${cap.id}: ${String((err as Error)?.message ?? err)}` },
      snapshot: buildSnapshot(),
    }
  }
}
