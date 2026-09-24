import { getApiBase, getMobileToken } from './client'
import type { GraphData } from '../lib/graph/types'

export interface GraphQuery {
  facts?: boolean
  conversations?: boolean
  tags?: boolean
  maxConversations?: number
}

/**
 * Trae el grafo de conocimiento del backend.
 *
 * El backend ya cachea por `mtime` de la bóveda, así que llamar a esto al abrir
 * la vista es barato; no hace falta cachear otra vez aquí. Lo que sí importa es
 * el timeout: si el vault creciera a miles de notas, una vista colgada sin
 * explicación es peor que un error visible.
 */
export async function fetchGraph(q: GraphQuery = {}): Promise<GraphData> {
  const params = new URLSearchParams()
  if (q.facts === false) params.set('facts', '0')
  if (q.conversations === false) params.set('conversations', '0')
  if (q.tags) params.set('tags', '1')
  if (q.maxConversations != null) params.set('maxConversations', String(q.maxConversations))
  const qs = params.toString()

  const token = getMobileToken()
  const res = await fetch(
    `${getApiBase()}/api/skills/vault/graph${qs ? `?${qs}` : ''}`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  // La convención del backend es `{ ok, result }`; un `ok:false` trae el motivo
  // en `error` y hay que propagarlo tal cual: "vault_not_configured" es
  // accionable, "algo falló" no.
  if (!body?.ok) throw new Error(String(body?.error ?? 'graph_failed'))
  return body.result as GraphData
}
