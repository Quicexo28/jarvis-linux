import { describe, it, expect } from 'vitest'
import { resolveNodeRef } from './vaultGraphStore'
import type { GraphNode } from '../lib/graph/types'

const node = (id: string, label: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, label, type: 'note', folder: '03-Conocimiento', tags: [], degree: 0, ...extra,
})

// Casos tomados del vault real: los nombres que el señor pronunciaría.
const NODES: GraphNode[] = [
  node('03-Conocimiento/Fisica/Fisica', 'Fisica'),
  node('02-Proyectos/App-Entrenamiento', 'App-Entrenamiento'),
  node('02-Proyectos/Jarvis', 'Jarvis'),
  node('01-Perfil/Santiago', 'Santiago', { folder: '01-Perfil' }),
  node('conv:2026-06-19', '2026-06-19', { type: 'conversation', folder: '06-Conversaciones' }),
]

describe('resolveNodeRef', () => {
  it('resuelve por id exacto', () => {
    expect(resolveNodeRef(NODES, '02-Proyectos/Jarvis')?.id).toBe('02-Proyectos/Jarvis')
  })

  it('resuelve por etiqueta exacta', () => {
    expect(resolveNodeRef(NODES, 'Santiago')?.id).toBe('01-Perfil/Santiago')
  })

  it('ignora tildes y mayúsculas — el señor dice "física", el fichero es "Fisica"', () => {
    expect(resolveNodeRef(NODES, 'física')?.id).toBe('03-Conocimiento/Fisica/Fisica')
    expect(resolveNodeRef(NODES, 'FÍSICA')?.id).toBe('03-Conocimiento/Fisica/Fisica')
  })

  it('resuelve por subcadena de la etiqueta', () => {
    expect(resolveNodeRef(NODES, 'entrenamiento')?.id).toBe('02-Proyectos/App-Entrenamiento')
  })

  it('resuelve por subcadena del id cuando la etiqueta no dice nada', () => {
    // "perfil" solo aparece en la ruta, no en la etiqueta "Santiago".
    expect(resolveNodeRef(NODES, 'perfil')?.id).toBe('01-Perfil/Santiago')
  })

  it('prefiere la coincidencia EXACTA sobre la parcial', () => {
    const nodes = [node('a/Jarvis-Log', 'Jarvis-Log'), node('b/Jarvis', 'Jarvis')]
    // "Jarvis" es subcadena de "Jarvis-Log", que va primero en la lista: sin la
    // preferencia por exacta, pedir "Jarvis" devolvería el log.
    expect(resolveNodeRef(nodes, 'Jarvis')?.id).toBe('b/Jarvis')
  })

  it('devuelve null ante una referencia vacía o desconocida', () => {
    expect(resolveNodeRef(NODES, '')).toBeNull()
    expect(resolveNodeRef(NODES, '   ')).toBeNull()
    expect(resolveNodeRef(NODES, 'termodinámica cuántica')).toBeNull()
  })

  it('encuentra una conversación por su fecha', () => {
    expect(resolveNodeRef(NODES, '2026-06-19')?.type).toBe('conversation')
  })
})
