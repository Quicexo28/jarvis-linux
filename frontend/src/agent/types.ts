// Shared types for the in-app agent layer (capability registry + brain bridge).
import type { Mode } from '../types'

export type CapabilityDomain = 'navigation' | 'plan' | 'system' | 'query' | 'timer'

// A minimal JSON-Schema subset — enough to describe & validate tool params and
// to hand the model an `input_schema` it understands.
export type ParamSchema = {
  type: 'object'
  properties: Record<string, { type: 'string' | 'number' | 'boolean'; description?: string; enum?: readonly (string | number)[] }>
  required?: string[]
}

export type CapabilityResult = {
  ok: boolean
  detail?: string // short Spanish sentence describing the outcome (spoken back)
  data?: unknown
}

export type Capability = {
  id: string
  domain: CapabilityDomain
  description: string
  params: ParamSchema
  sensitive?: boolean // requires explicit user confirmation before running
  run: (params: Record<string, unknown>) => CapabilityResult | Promise<CapabilityResult>
}

// Anthropic-style tool schema announced to the brain.
export type ToolSchema = {
  name: string
  description: string
  input_schema: ParamSchema
}

export type AgentSnapshot = {
  mode: Mode
  zoomedMode: Mode | null
  ringLevel: string
  activeRingMode: Mode
  bootState: string
  voiceEnabled: boolean
  focusedEntity: string | null
  activePlanKey: string | null
  plans: { key: string; room: string; name: string; updatedAt: string }[]
  activePlanEntities: { id: string; label: string; kind: string }[]
}

export type ExecuteOutcome = {
  ok: boolean
  result: CapabilityResult
  snapshot: AgentSnapshot
}
