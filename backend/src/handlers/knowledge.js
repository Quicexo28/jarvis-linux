/**
 * Grafo de conocimiento — lado HTTP.
 *
 * Sirve `lib/knowledgeGraph.js` al modo `vault` del frontend (visor 3D) y a la
 * tool MCP `vault_graph`. Solo lee: la bóveda, la memoria y las conversaciones
 * se tocan en otro sitio.
 */

import { json } from '../lib/http.js'
import { isConfigured } from '../lib/obsidian.js'
import { getGraph } from '../lib/knowledgeGraph.js'

/**
 * Query param booleano. El servidor MCP serializa los args de un GET con
 * `String(v)` (ver `callBackend` en jarvis-mcp.js), así que un `false` del
 * modelo llega como la cadena "false" — aceptar solo `0|1` haría que apagar
 * los hechos por voz encendiera los hechos.
 */
function boolParam(params, name, fallback) {
  const raw = params.get(name)
  if (raw === null) return fallback
  const v = String(raw).trim().toLowerCase()
  if (['0', 'false', 'no', 'off', ''].includes(v)) return false
  return true
}

export async function handleVaultGraph(req, res) {
  if (!isConfigured()) {
    return json(res, 503, { ok: false, error: 'vault_not_configured' })
  }
  let params
  try {
    params = new URL(req.url, 'http://localhost').searchParams
  } catch {
    params = new URLSearchParams()
  }
  const maxRaw = Number(params.get('maxConversations'))
  try {
    const result = getGraph({
      includeFacts: boolParam(params, 'facts', true),
      includeConversations: boolParam(params, 'conversations', true),
      includeTags: boolParam(params, 'tags', false),
      // Tope acotado: el grafo va entero por el stdio del MCP, y pedir "todas"
      // las conversaciones de un vault de años es un muro de nodos sin leer.
      maxConversations: Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 500) : 20,
    })
    return json(res, 200, { ok: true, result })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'graph_failed', detail: String(e?.message || e) })
  }
}
