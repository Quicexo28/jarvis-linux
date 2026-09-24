import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import os from 'node:os'
import { buildGraph, parseFrontmatter, extractWikilinks, containsTerm } from '../src/lib/knowledgeGraph.js'

/**
 * Vault de mentira con los casos REALES del vault del señor: un hub con muchos
 * entrantes, alias con tilde (`[[Fisica|física]]` + `aliases: [física]`),
 * enlaces con `#heading`, placeholders de plantilla en ficheros de
 * instrucciones, y notas diarias de conversación junto a su nota hub.
 */
let root = ''

const write = (rel, content) => {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf-8')
}

beforeAll(() => {
  root = mkdtempSync(join(os.tmpdir(), 'jarvis-graph-'))

  write('02-Proyectos/Jarvis.md', [
    '---',
    'aliases: [jarvis, el asistente]',
    'tags: [proyecto, hub]',
    '---',
    '',
    '# Proyecto: Jarvis',
    '',
    // (a) por ruta relativa, (b) por alias con tilde, (c) placeholder, (d) roto
    'Ver [[03-Conocimiento/Fisica/Tesseracto]] y [[Física]].',
    'Series: cada nota termina con `[[NombreHub]]`, y de paso [[Page Name]].',
    'Pendiente: [[No-Existe-Todavia]].',
    'Experimento: [[Caida Libre]].',
  ].join('\n'))

  write('03-Conocimiento/Fisica/Fisica.md', [
    '---',
    'aliases: [física, fisica]',
    'tags: [fisica, hub]',
    '---',
    '',
    '# Física',
    '',
    'Hub del tema. Proyecto relacionado: [[el asistente]].',
  ].join('\n'))

  // Sin frontmatter: dos enlaces a la MISMA nota, uno con #heading y otro con alias.
  write('03-Conocimiento/Fisica/Tesseracto.md', [
    '# Tesseracto',
    '',
    'Pertenece a [[Fisica#Temas]] y también a [[Fisica|física]].',
  ].join('\n'))

  write('03-Conocimiento/Fisica/Experimentos/Tiempo-de-Vuelo.md', [
    '---',
    'aliases: [tiempo de vuelo, caída libre]',
    'tags: [fisica]',
    '---',
    '',
    '# Tiempo de Vuelo',
    '',
    'Tema: [[Fisica]].',
  ].join('\n'))

  // Frontmatter roto (fence sin cerrar): no debe lanzar y el enlace sigue valiendo.
  write('00-System/Roto.md', [
    '---',
    'tags: [a, b',
    'esto no cierra nunca',
    '',
    '# Nota rota',
    'Enlaza a [[Jarvis]].',
  ].join('\n'))

  // Plantilla: sus enlaces de ejemplo NO deben entrar al grafo.
  write('_Templates/Plantilla-Tema.md', [
    '---',
    'tags: [plantilla]',
    '---',
    '# {{title}}',
    'Hub: [[NombreHub]] — tema: [[Topic Name]] — nota: [[Jarvis]].',
  ].join('\n'))

  write('06-Conversaciones/Conversaciones.md', [
    '---',
    'aliases: [conversaciones, logs de conversaciones]',
    'tags: [conversaciones]',
    '---',
    '',
    '# Conversaciones',
    '',
    '- [[2026-06-19]]',
    '- [[2026-06-20]]',
  ].join('\n'))

  write('06-Conversaciones/2026-06-19.md', [
    '---',
    'type: conversacion',
    'date: 2026-06-19',
    '---',
    '',
    '# Conversación — 2026-06-19',
    '',
    '## 14:57:48',
    '**Usuario:** ¿Qué sabes del Tesseracto?',
    '**Jarvis:** Es un hipercubo, señor.',
    '',
    'Índice: [[Conversaciones]]',
  ].join('\n'))

  write('06-Conversaciones/2026-06-20.md', [
    '---',
    'type: conversacion',
    'date: 2026-06-20',
    '---',
    '',
    '# Conversación — 2026-06-20',
    '',
    '## 09:10:00',
    '**Usuario:** Apunta el tiempo de vuelo del experimento.',
    '**Jarvis:** Anotado, señor.',
  ].join('\n'))
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const base = () => buildGraph({ vaultPath: root, facts: [] })
const byId = (g, id) => g.nodes.find((n) => n.id === id)
const edge = (g, source, target, kind) =>
  g.edges.find((e) => e.source === source && e.target === target && (!kind || e.kind === kind))

describe('parseFrontmatter', () => {
  it('lee pares y listas en línea, y tolera la ausencia de frontmatter', () => {
    const fm = parseFrontmatter('---\naliases: [a, b]\ntype: conversacion\n---\ncuerpo')
    expect(fm.data.aliases).toEqual(['a', 'b'])
    expect(fm.data.type).toBe('conversacion')
    expect(fm.body.trim()).toBe('cuerpo')
    expect(parseFrontmatter('# solo cuerpo').data).toEqual({})
  })

  it('no lanza con frontmatter malformado y devuelve el texto como cuerpo', () => {
    expect(() => parseFrontmatter('---\ntags: [a, b\nsin cerrar')).not.toThrow()
    expect(parseFrontmatter('---\ntags: [a, b\nsin cerrar').body).toContain('sin cerrar')
  })
})

describe('extractWikilinks', () => {
  it('cubre alias, heading, embeds y descarta el enlace a la propia sección', () => {
    const links = extractWikilinks('a [[X]] b [[Y|zeta]] c [[Z#Sec]] d ![[W]] e [[#solo-seccion]]')
    expect(links.map((l) => l.target)).toEqual(['X', 'Y', 'Z', 'W'])
  })
})

describe('containsTerm', () => {
  it('exige palabra completa', () => {
    expect(containsTerm('trabajo en jarvis hoy', 'jarvis')).toBe(true)
    expect(containsTerm('jarvisito no cuenta', 'jarvis')).toBe(false)
    expect(containsTerm('el tiempo-de-vuelo salio bien', 'tiempo-de-vuelo')).toBe(true)
  })
})

describe('buildGraph — resolución de enlaces', () => {
  it('resuelve por basename y por ruta relativa', () => {
    const g = base()
    // basename: [[Fisica#Temas]] desde Tesseracto
    expect(edge(g, '03-Conocimiento/Fisica/Tesseracto', '03-Conocimiento/Fisica/Fisica', 'link')).toBeTruthy()
    // ruta relativa completa: [[03-Conocimiento/Fisica/Tesseracto]] desde Jarvis
    expect(edge(g, '02-Proyectos/Jarvis', '03-Conocimiento/Fisica/Tesseracto', 'link')).toBeTruthy()
  })

  it('resuelve por alias del frontmatter sin tildes y sin distinguir mayúsculas', () => {
    const g = base()
    // [[Física]] (con tilde) → nota Fisica.md, que declara `aliases: [física]`
    expect(edge(g, '02-Proyectos/Jarvis', '03-Conocimiento/Fisica/Fisica', 'link')).toBeTruthy()
    // [[Caida Libre]] (sin tilde, otra capitalización) → alias `caída libre`
    expect(edge(g, '02-Proyectos/Jarvis', '03-Conocimiento/Fisica/Experimentos/Tiempo-de-Vuelo', 'link')).toBeTruthy()
    // [[el asistente]] → alias de Jarvis
    expect(edge(g, '03-Conocimiento/Fisica/Fisica', '02-Proyectos/Jarvis', 'link')).toBeTruthy()
  })

  it('[[Target|alias]] y [[Target#heading]] apuntan al mismo nodo (una arista, peso 2)', () => {
    const g = base()
    const matches = g.edges.filter(
      (e) => e.source === '03-Conocimiento/Fisica/Tesseracto' && e.target === '03-Conocimiento/Fisica/Fisica',
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].weight).toBe(2)
  })

  it('un destino inexistente crea un fantasma, pero un placeholder de plantilla NO crea nada', () => {
    const g = base()
    const ghost = byId(g, 'ghost:no-existe-todavia')
    expect(ghost).toBeTruthy()
    expect(ghost.type).toBe('ghost')
    expect(ghost.label).toBe('No-Existe-Todavia')

    for (const placeholder of ['page name', 'nombrehub', 'topic name']) {
      expect(byId(g, `ghost:${placeholder}`), placeholder).toBeUndefined()
    }
    // Ni fantasmas ni aristas hacia ellos: el grafo solo tiene el fantasma real.
    expect(g.nodes.filter((n) => n.type === 'ghost').map((n) => n.id)).toEqual(['ghost:no-existe-todavia'])
    expect(g.stats.ghosts).toBe(1)
  })

  it('excluye por completo los ficheros bajo _Templates/', () => {
    const g = base()
    expect(g.nodes.some((n) => (n.path || '').startsWith('_Templates'))).toBe(false)
    expect(g.nodes.some((n) => n.label === 'Plantilla-Tema')).toBe(false)
    // Y su [[Jarvis]] de ejemplo no infla el grado del hub.
    expect(g.edges.some((e) => e.source.includes('Plantilla'))).toBe(false)
  })

  it('cuenta el grado de un hub con todas sus aristas incidentes', () => {
    const g = base()
    const fisica = byId(g, '03-Conocimiento/Fisica/Fisica')
    const incident = g.edges.filter(
      (e) => e.source === fisica.id || e.target === fisica.id,
    ).length
    expect(fisica.degree).toBe(incident)
    // salientes: [[el asistente]]. entrantes: Tesseracto, Tiempo-de-Vuelo, Jarvis([[Física]])
    expect(fisica.degree).toBe(4)
  })
})

describe('buildGraph — memoria', () => {
  const facts = [
    { id: 7, ts: 100, updated_at: 1700000000000, kind: 'fact', text: 'El señor trabaja en Jarvis casi todos los días' },
    { id: 8, ts: 200, updated_at: 1700000001000, kind: 'fact', text: 'Nada de esto casa con ninguna nota del vault' },
  ]

  it('enlaza el hecho con la nota que menciona y deja huérfano el que no casa', () => {
    const g = buildGraph({ vaultPath: root, facts })
    const linked = byId(g, 'fact:7')
    expect(linked.type).toBe('fact')
    expect(linked.folder).toBe('memoria')
    expect(linked.ts).toBe(1700000000000)
    expect(edge(g, 'fact:7', '02-Proyectos/Jarvis', 'fact')).toBeTruthy()

    const orphan = byId(g, 'fact:8')
    expect(orphan).toBeTruthy()
    expect(orphan.degree).toBe(0)
    expect(g.stats.facts).toBe(2)
  })

  it('recorta la etiqueta larga a ~60 caracteres', () => {
    const long = 'x'.repeat(200)
    const g = buildGraph({ vaultPath: root, facts: [{ id: 9, updated_at: 1, text: long }] })
    expect(byId(g, 'fact:9').label.length).toBeLessThanOrEqual(61)
  })

  it('no lanza ni incluye memoria con includeFacts:false', () => {
    const g = buildGraph({ vaultPath: root, includeFacts: false, facts })
    expect(g.stats.facts).toBe(0)
  })
})

describe('buildGraph — conversaciones', () => {
  it('emite un nodo por día con aristas de mención y NO duplica el fichero como nota', () => {
    const g = base()
    const conv = byId(g, 'conv:2026-06-19')
    expect(conv.type).toBe('conversation')
    expect(conv.label).toBe('2026-06-19')
    expect(conv.folder).toBe('06-Conversaciones')
    expect(conv.ts).toBeGreaterThan(0)
    expect(edge(g, 'conv:2026-06-19', '03-Conocimiento/Fisica/Tesseracto', 'mention')).toBeTruthy()

    // el MISMO fichero no puede estar además como nota
    expect(byId(g, '06-Conversaciones/2026-06-19')).toBeUndefined()
    expect(g.nodes.filter((n) => n.path === '06-Conversaciones/2026-06-19.md')).toHaveLength(1)
  })

  it('la nota hub de 06-Conversaciones sigue siendo nota y recibe los enlaces', () => {
    const g = base()
    const hub = byId(g, '06-Conversaciones/Conversaciones')
    expect(hub.type).toBe('note')
    // la hub enlaza los días → aristas de enlace hacia los nodos conversation
    expect(edge(g, hub.id, 'conv:2026-06-19', 'link')).toBeTruthy()
    // y el día enlaza de vuelta a la hub
    expect(edge(g, 'conv:2026-06-19', hub.id, 'link')).toBeTruthy()
  })

  it('el tope deja fuera las conversaciones viejas sin inventarles fantasmas', () => {
    const g = buildGraph({ vaultPath: root, facts: [], maxConversations: 1 })
    expect(g.stats.conversations).toBe(1)
    expect(byId(g, 'conv:2026-06-20')).toBeTruthy() // la más reciente
    expect(byId(g, 'conv:2026-06-19')).toBeUndefined()
    expect(byId(g, 'ghost:2026-06-19')).toBeUndefined()
  })

  it('includeConversations:false las quita del todo', () => {
    const g = buildGraph({ vaultPath: root, facts: [], includeConversations: false })
    expect(g.stats.conversations).toBe(0)
    expect(g.nodes.some((n) => n.id.startsWith('conv:'))).toBe(false)
    expect(g.nodes.some((n) => n.id.startsWith('ghost:2026'))).toBe(false)
  })
})

describe('buildGraph — tags y forma general', () => {
  it('los tags viajan en el nodo y solo se promueven con includeTags', () => {
    const plain = base()
    expect(byId(plain, '02-Proyectos/Jarvis').tags).toEqual(['proyecto', 'hub'])
    expect(plain.stats.tags).toBe(0)

    const tagged = buildGraph({ vaultPath: root, facts: [], includeTags: true })
    expect(byId(tagged, 'tag:proyecto').type).toBe('tag')
    expect(byId(tagged, 'tag:proyecto').folder).toBe('tags')
    expect(edge(tagged, '02-Proyectos/Jarvis', 'tag:proyecto', 'tag')).toBeTruthy()
    expect(tagged.stats.tags).toBeGreaterThan(0)
  })

  it('devuelve las estadísticas del contrato', () => {
    const g = base()
    for (const k of ['notes', 'ghosts', 'facts', 'conversations', 'tags', 'edges', 'orphans', 'maxDegree']) {
      expect(typeof g.stats[k], k).toBe('number')
    }
    expect(g.stats.notes).toBeGreaterThanOrEqual(5)
    expect(g.stats.edges).toBe(g.edges.length)
  })

  it('no lanza (y devuelve vacío) sin vault', () => {
    const g = buildGraph({ vaultPath: null, facts: [] })
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
  })

  it('es determinista: dos llamadas dan el mismo JSON salvo builtAt', () => {
    const a = buildGraph({ vaultPath: root, facts: [] })
    const b = buildGraph({ vaultPath: root, facts: [] })
    expect(JSON.stringify({ nodes: a.nodes, edges: a.edges, stats: a.stats }))
      .toBe(JSON.stringify({ nodes: b.nodes, edges: b.edges, stats: b.stats }))
    // y el orden es por id / source,target
    const ids = a.nodes.map((n) => n.id)
    expect(ids).toEqual([...ids].sort())
  })
})
