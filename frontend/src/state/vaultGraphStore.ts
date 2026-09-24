import { create } from 'zustand'
import { fetchGraph } from '../api/vaultGraph'
import type { GraphData, GraphNode } from '../lib/graph/types'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface VaultGraphState {
  data: GraphData | null
  status: Status
  error: string | null
  /** Nodo seleccionado — lo pinta el panel de detalle y lo ancla el layout. */
  focusedId: string | null
  /** Texto del filtro. Los nodos que no casan se atenúan, NO se ocultan:
   *  esconderlos rompe las aristas y el grafo deja de explicar nada. */
  query: string
  /** Sube cada vez que la voz pide enfocar, para que la cámara reaccione aunque el id no cambie. */
  focusNonce: number

  load: (opts?: { force?: boolean }) => Promise<void>
  setFocused: (id: string | null) => void
  setQuery: (q: string) => void
}

export const useVaultGraphStore = create<VaultGraphState>((set, get) => ({
  data: null,
  status: 'idle',
  error: null,
  focusedId: null,
  query: '',
  focusNonce: 0,

  load: async ({ force } = {}) => {
    const { status, data } = get()
    if (status === 'loading') return
    if (data && !force) return
    set({ status: 'loading', error: null })
    try {
      const graph = await fetchGraph()
      set({ data: graph, status: 'ready', error: null })
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  setFocused: (id) => set((s) => ({ focusedId: id, focusNonce: s.focusNonce + 1 })),
  setQuery: (query) => set({ query }),
}))

/**
 * Resuelve lo que dijo la voz a un id de nodo.
 *
 * El señor no dice ids: dice "la nota de física" o "el proyecto del gym". Por
 * eso se prueba, en orden de precisión decreciente, id exacto → etiqueta exacta
 * → subcadena de la etiqueta, todo sin tildes y en minúsculas (misma disciplina
 * que las wake phrases: `\b` solo entiende ASCII y "física" no casaría nunca
 * contra "fisica").
 */
export function resolveNodeRef(nodes: GraphNode[], ref: string): GraphNode | null {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
  const needle = norm(ref)
  if (!needle) return null
  return (
    nodes.find((n) => norm(n.id) === needle) ??
    nodes.find((n) => norm(n.label) === needle) ??
    nodes.find((n) => norm(n.label).includes(needle)) ??
    nodes.find((n) => norm(n.id).includes(needle)) ??
    null
  )
}
