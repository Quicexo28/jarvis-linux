/**
 * Knowledge graph builder — fusiona las TRES memorias de Jarvis en un solo
 * `{nodes, edges}` para el visor 3D del modo `vault`.
 *
 * Las tres viven separadas y cada una sabe solo de sí misma:
 *  1. La bóveda Obsidian (`lib/obsidian.js`) — notas y wikilinks en disco.
 *  2. La memoria a largo plazo (`facts` de `lib/turnStore.js`, SQLite+FTS5).
 *  3. Las conversaciones (`06-Conversaciones/YYYY-MM-DD.md`, que hoy se
 *     escriben y nadie lee de vuelta).
 * Nadie cruzaba las tres, así que "qué sabe Jarvis sobre X" solo se podía
 * responder buscando texto. Aquí se cruzan por NOMBRE de nota: un hecho o una
 * conversación que menciona el título (o un alias) de una nota queda enganchado
 * a ella, y el grafo resultante es navegable.
 *
 * Decisiones que NO son obvias:
 *
 * - **El parser de frontmatter es propio, sin dependencias.** El repo no añade
 *   deps por esto (ni js-yaml ni gray-matter) y el frontmatter real del vault
 *   es siempre la forma simple `key: value` + listas en línea `[a, b, c]`. Un
 *   parser YAML completo sería 200 KB de node_modules para leer cuatro claves.
 *   Es TOLERANTE a propósito: frontmatter ausente o malformado no lanza, porque
 *   el grafo lo pide la voz y una nota rota no puede tumbar la respuesta.
 *
 * - **Los placeholders de plantilla NO crean nodos fantasma.** `Wiki/CLAUDE.md`
 *   y `00-System/PROMPT-jarvis-boveda.md` son instrucciones que enseñan a
 *   escribir wikilinks, así que contienen `[[Page Name]]`, `[[NombreHub]]`,
 *   `[[topic-1]]`… Tratarlos como enlaces reales llena el grafo de basura con
 *   aspecto de conocimiento. Ojo al orden: primero se RESUELVE contra las notas
 *   reales y solo se descarta si quedó sin resolver — `[[index]]` y
 *   `[[overview]]` son placeholders en la lista pero existen de verdad como
 *   `Wiki/index.md` / `Wiki/overview.md`, y esos sí son enlaces.
 *
 * - **Una nota diaria de `06-Conversaciones` NO se emite además como nota.**
 *   Sería el mismo fichero dos veces (un nodo `note` y un nodo `conversation`)
 *   y el visor mostraría dos bolas para una conversación. La hub
 *   `06-Conversaciones/Conversaciones.md` sí sigue siendo nota: no es un día,
 *   es el índice al que apuntan 18 enlaces.
 *
 * - **Todo el matching va sin tildes y en minúsculas** (`normalizeName`, misma
 *   disciplina que `normalizeForWake` en `intentClassifier.js`): en el vault
 *   conviven `[[Fisica]]`, `[[Fisica|física]]` y el alias `física`, y sin
 *   normalizar son tres destinos distintos para una sola nota.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getVaultPath } from './obsidian.js'
import { allFacts } from './turnStore.js'

/**
 * Carpetas que no son conocimiento: plantillas (enlaces de ejemplo), metadatos
 * de Obsidian/git y los espejos de nube que el usuario tiene colgados del vault
 * (`AppData`, `OneDrive`) y que pueden contener miles de ficheros ajenos.
 * Configurable por `opts.skipDirs`.
 */
export const SKIP_DIRS = ['_Templates', '.obsidian', '.git', 'AppData', 'OneDrive']

/**
 * Nombres de enlace que son EJEMPLOS de plantilla, no destinos. Si no resuelven
 * contra una nota real, se descartan sin crear fantasma.
 */
export const TEMPLATE_PLACEHOLDERS = [
  'page name', 'topic name', 'nombrehub', 'topic-1', 'topic-2',
  'page-name', 'index', 'links', 'overview', 'synthesis-page',
]

/** Carpeta cuyas notas diarias se colapsan en nodos `conversation`. */
export const CONV_FOLDER = '06-Conversaciones'

/** `folder` de las notas que viven en la raíz del vault (no hay nivel 1). */
const ROOT_FOLDER = 'raiz'

/** `folder` sintético de la memoria SQLite y de los tags promovidos. */
const FACT_FOLDER = 'memoria'
const TAG_FOLDER = 'tags'

/**
 * Longitud mínima de un título/alias para buscarlo dentro de un hecho o de una
 * conversación. Por debajo de esto ("log", "IA") el nombre aparece por
 * casualidad en cualquier texto y el grafo se vuelve una malla sin información.
 */
const MIN_TERM_LEN = 4

/** Caracteres que cuentan como "parte de palabra" al buscar un término. */
const WORDISH = /[a-z0-9]/

const TTL_MS = 30_000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** NFD + strip de diacríticos + minúsculas. Igual que `normalizeForWake`. */
export function normalizeName(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

const PLACEHOLDER_SET = new Set(TEMPLATE_PLACEHOLDERS.map(normalizeName))

function stripQuotes(value) {
  const v = String(value ?? '').trim()
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1).trim()
  }
  return v
}

/**
 * Frontmatter mínimo: bloque `---` inicial, pares `key: value`, listas en línea
 * `[a, b, c]` y (tolerancia extra, gratis) listas en bloque con `- item`.
 * Nunca lanza: sin frontmatter devuelve `{ data: {}, body: raw }`.
 *
 * @param {string} raw contenido completo del fichero
 * @returns {{ data: Record<string, string|string[]>, body: string }}
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '')
  const empty = { data: {}, body: text }
  if (!text.startsWith('---')) return empty
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return empty // fence abierta y nunca cerrada: se trata como cuerpo
  const data = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = normalizeName(line.slice(0, idx))
    if (!key) continue
    const value = line.slice(idx + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map((s) => stripQuotes(s)).filter(Boolean)
    } else if (!value) {
      // Lista en bloque: `tags:` seguido de líneas `  - algo`.
      const items = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(stripQuotes(lines[++i].replace(/^\s*-\s+/, '')))
      }
      data[key] = items.length ? items.filter(Boolean) : ''
    } else {
      data[key] = stripQuotes(value)
    }
  }
  return { data, body: text.slice(match[0].length) }
}

/** Frontmatter → array de strings, acepte el valor la forma que acepte. */
function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  const v = String(value ?? '').trim()
  if (!v) return []
  return v.split(',').map((s) => stripQuotes(s)).filter(Boolean)
}

/**
 * Wikilinks de un texto: `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`,
 * `[[Target#heading|alias]]` y embeds `![[Target]]`. `[[#heading]]` (enlace a
 * una sección del propio fichero) no es una arista y se descarta.
 *
 * @returns {{ target: string, alias: string|null }[]}
 */
export function extractWikilinks(text) {
  const out = []
  const re = /!?\[\[([^\]\n]+)\]\]/g
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const inner = m[1]
    const pipe = inner.indexOf('|')
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : null
    let target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
    const hash = target.indexOf('#')
    if (hash >= 0) target = target.slice(0, hash).trim() // #heading y ^bloque
    if (!target) continue
    out.push({ target, alias: alias || null })
  }
  return out
}

/**
 * Quita el código antes de buscar enlaces. No es cosmética: los ficheros de
 * instrucciones del vault (`CLAUDE.md`, `Wiki/CLAUDE.md`,
 * `00-System/PROMPT-jarvis-boveda.md`) ENSEÑAN la sintaxis de wikilinks, así
 * que contienen `` `[[...]]` ``, `` `[[así]]` ``, `` `![[assets/filename.png]]` ``
 * y `` `[[citations]]` ` ` — cuatro fantasmas medidos en el vault real que no
 * son conocimiento, son documentación. Obsidian tampoco los renderiza como
 * enlaces. El span en línea se acota a UNA línea (`[^`\n]*`) para que un
 * backtick suelto no se coma media nota.
 */
function stripCode(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

/**
 * ¿Aparece `term` como palabra completa dentro de `hay`? Ambos ya normalizados.
 * Se hace con `indexOf` + comprobación de fronteras en vez de una RegExp porque
 * los títulos traen puntos, guiones y paréntesis (`Tiempo-de-Vuelo`) que habría
 * que escapar, y porque `\b` de JS solo entiende ASCII.
 */
export function containsTerm(hay, term) {
  if (!hay || !term || term.length < MIN_TERM_LEN) return false
  let from = 0
  for (;;) {
    const at = hay.indexOf(term, from)
    if (at < 0) return false
    const before = at > 0 ? hay[at - 1] : ' '
    const after = at + term.length < hay.length ? hay[at + term.length] : ' '
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true
    from = at + 1
  }
}

/** Recorrido recursivo del vault. Devuelve rutas relativas con `/`. */
function walkMarkdown(root, skipDirs, acc = [], rel = '') {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return acc
  }
  // Orden alfabético estable: el determinismo del grafo (y de los desempates
  // del índice de nombres) depende de recorrer siempre igual.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    // Nada oculto es conocimiento: `.obsidian`, `.git`, `.trash`, `.stfolder`…
    if (entry.name.startsWith('.')) continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue
      walkMarkdown(root, skipDirs, acc, childRel)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(childRel)
    }
  }
  return acc
}

/** Fecha `YYYY-MM-DD` → epoch ms (UTC, mediodía para no cruzar husos). */
function dateToTs(date) {
  const t = Date.parse(`${date}T12:00:00Z`)
  return Number.isFinite(t) ? t : undefined
}

/**
 * Construye el grafo completo.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.vaultPath]   raíz del vault (default: env de Obsidian)
 * @param {boolean} [opts.includeFacts]    incluir la memoria SQLite
 * @param {boolean} [opts.includeConversations] incluir nodos de conversación
 * @param {number}  [opts.maxConversations] cuántas conversaciones (las más recientes)
 * @param {boolean} [opts.includeTags]     promover tags a nodos propios
 * @param {Array|null} [opts.facts]        hechos inyectados (tests); null = leer del store
 * @param {string[]} [opts.skipDirs]
 * @returns {{nodes: object[], edges: object[], stats: Record<string, number>, builtAt: number}}
 */
export function buildGraph(opts = {}) {
  const {
    vaultPath = getVaultPath(),
    includeFacts = true,
    includeConversations = true,
    maxConversations = 20,
    includeTags = false,
    facts = null,
    skipDirs = SKIP_DIRS,
  } = opts || {}

  /** @type {Map<string, object>} */
  const nodes = new Map()
  /** @type {Map<string, object>} */
  const edges = new Map()

  const addNode = (node) => {
    if (!nodes.has(node.id)) nodes.set(node.id, { degree: 0, ...node, tags: node.tags || [] })
    return nodes.get(node.id)
  }
  const addEdge = (source, target, kind, weight = 1) => {
    if (!source || !target || source === target) return
    const key = `${source}\u0000${target}\u0000${kind}`
    const prev = edges.get(key)
    if (prev) prev.weight += weight
    else edges.set(key, { source, target, kind, weight })
  }
  const hasEdge = (source, target, kind) => edges.has(`${source}\u0000${target}\u0000${kind}`)

  // ── 1. Leer y parsear los .md ────────────────────────────────────────────
  const relPaths = vaultPath ? walkMarkdown(vaultPath, skipDirs) : []
  const docs = []
  for (const relPath of relPaths) {
    let raw
    try {
      raw = readFileSync(join(vaultPath, relPath), 'utf-8')
    } catch {
      continue // fichero ilegible (permisos, borrado a mitad del recorrido)
    }
    const { data, body } = parseFrontmatter(raw)
    const parts = relPath.split('/')
    const base = parts[parts.length - 1].replace(/\.md$/i, '')
    const folder = parts.length > 1 ? parts[0] : ROOT_FOLDER
    const text = stripCode(body)
    const fmDate = String(data.date ?? '').trim()
    const dayFromName = DATE_RE.test(base) ? base : null
    const day = DATE_RE.test(fmDate) ? fmDate : dayFromName
    docs.push({
      relPath,
      noteId: relPath.replace(/\.md$/i, ''),
      base,
      folder,
      aliases: asList(data.aliases),
      tags: asList(data.tags),
      type: normalizeName(data.type),
      day,
      text,
      links: extractWikilinks(text),
      // Una nota de `06-Conversaciones` es un DÍA si se llama por fecha o lo
      // declara en el frontmatter. La hub `Conversaciones.md` no cumple ninguna
      // de las dos, así que sigue siendo nota (y conserva sus 18 entrantes).
      isConv: folder === CONV_FOLDER && !!day && (data.type === undefined || normalizeName(data.type) === 'conversacion'),
    })
  }

  // ── 2. Recortar conversaciones y decidir qué fichero es qué nodo ─────────
  const convDocs = docs.filter((d) => d.isConv)
  convDocs.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (a.relPath < b.relPath ? -1 : 1)))
  const keptConv = includeConversations
    ? convDocs.slice(0, Math.max(0, Number(maxConversations) || 0))
    : []
  const keptConvSet = new Set(keptConv.map((d) => d.relPath))

  // Nombres de conversaciones EXCLUIDAS (por el tope o por `includeConversations:
  // false`). Se guardan para poder descartar sus enlaces entrantes sin crear
  // fantasmas: la hub enlaza las 35 notas diarias, y ghostear las 15 que no
  // caben en el tope inventaría 15 nodos que sí existen en disco.
  const suppressed = new Set()

  /** índice de resolución: nombre normalizado → id de nodo */
  const index = new Map()
  const addIndex = (name, id) => {
    const key = normalizeName(name)
    if (!key || index.has(key)) return // primer fichero gana (recorrido ordenado)
    index.set(key, id)
  }

  for (const doc of docs) {
    const keys = [doc.noteId, doc.base, ...doc.aliases]
    if (doc.isConv && !keptConvSet.has(doc.relPath)) {
      for (const k of keys) suppressed.add(normalizeName(k))
      continue
    }
    doc.id = doc.isConv ? `conv:${doc.day}` : doc.noteId
    for (const k of keys) addIndex(k, doc.id)
  }

  const liveDocs = docs.filter((d) => d.id)

  // ── 3. Nodos de nota y de conversación ──────────────────────────────────
  for (const doc of liveDocs) {
    if (doc.isConv) {
      addNode({
        id: doc.id,
        label: doc.day,
        type: 'conversation',
        folder: CONV_FOLDER,
        path: doc.relPath,
        tags: doc.tags,
        ts: dateToTs(doc.day),
      })
    } else {
      addNode({
        id: doc.id,
        label: doc.base,
        type: 'note',
        folder: doc.folder,
        path: doc.relPath,
        tags: doc.tags,
      })
    }
  }

  // ── 4. Aristas de wikilink ──────────────────────────────────────────────
  let ghosts = 0
  for (const doc of liveDocs) {
    for (const { target } of doc.links) {
      const key = normalizeName(target)
      const resolved = index.get(key)
      if (resolved) {
        addEdge(doc.id, resolved, 'link')
        continue
      }
      if (suppressed.has(key)) continue        // existe en disco, fuera del tope
      if (PLACEHOLDER_SET.has(key)) continue   // ejemplo de plantilla, no destino
      const ghostId = `ghost:${key}`
      if (!nodes.has(ghostId)) {
        ghosts++
        addNode({ id: ghostId, label: target, type: 'ghost', folder: 'fantasmas', tags: [] })
      }
      addEdge(doc.id, ghostId, 'link')
    }
  }

  // ── 5. Términos buscables (solo NOTAS: un hecho que dice "2026-07-02" no
  //       está hablando de una conversación, está dando una fecha) ─────────
  const terms = []
  for (const doc of liveDocs) {
    if (doc.isConv) continue
    for (const name of [doc.base, ...doc.aliases]) {
      const term = normalizeName(name)
      if (term.length >= MIN_TERM_LEN) terms.push({ term, id: doc.id })
    }
  }

  // ── 6. Memoria (facts) ──────────────────────────────────────────────────
  let factRows = []
  if (includeFacts) {
    if (Array.isArray(facts)) {
      factRows = facts
    } else {
      // El store puede no existir (primer arranque) o estar bloqueado; y su
      // import abre `data/jarvis.db`. Un grafo sin memoria es útil; una
      // excepción aquí dejaría al visor sin nada que mostrar.
      try { factRows = allFacts(500) } catch { factRows = [] }
    }
  }
  let factCount = 0
  for (const row of factRows) {
    if (!row || row.text == null) continue
    const text = String(row.text)
    const id = `fact:${row.id}`
    if (nodes.has(id)) continue
    factCount++
    addNode({
      id,
      label: text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text,
      type: 'fact',
      folder: FACT_FOLDER,
      tags: row.kind ? [String(row.kind)] : [],
      ts: Number(row.updated_at) || Number(row.ts) || undefined,
    })
    const hay = normalizeName(text)
    for (const { term, id: noteId } of terms) {
      if (containsTerm(hay, term)) addEdge(id, noteId, 'fact')
    }
  }

  // ── 7. Menciones desde las conversaciones ───────────────────────────────
  for (const doc of liveDocs) {
    if (!doc.isConv) continue
    const hay = normalizeName(doc.text)
    for (const { term, id: noteId } of terms) {
      if (!containsTerm(hay, term)) continue
      // Si la conversación ya ENLAZA la nota, el wikilink es la evidencia
      // fuerte; duplicar la arista como mención solo infla el grado.
      if (hasEdge(doc.id, noteId, 'link')) continue
      addEdge(doc.id, noteId, 'mention')
    }
  }

  // ── 8. Tags como nodos (opcional; siempre viajan en node.tags) ──────────
  let tagCount = 0
  if (includeTags) {
    for (const doc of liveDocs) {
      for (const tag of doc.tags) {
        const key = normalizeName(tag)
        if (!key) continue
        const tagId = `tag:${key}`
        if (!nodes.has(tagId)) {
          tagCount++
          addNode({ id: tagId, label: tag, type: 'tag', folder: TAG_FOLDER, tags: [] })
        }
        addEdge(doc.id, tagId, 'tag')
      }
    }
  }

  // ── 9. Grados, orden determinista y estadísticas ─────────────────────────
  const edgeList = [...edges.values()]
  for (const edge of edgeList) {
    const a = nodes.get(edge.source)
    const b = nodes.get(edge.target)
    if (a) a.degree++
    if (b && b !== a) b.degree++
  }

  const nodeList = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  edgeList.sort((a, b) => (
    a.source < b.source ? -1 : a.source > b.source ? 1
      : a.target < b.target ? -1 : a.target > b.target ? 1
        : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
  ))

  const counts = { note: 0, tag: 0, fact: 0, conversation: 0, ghost: 0 }
  let orphans = 0
  let maxDegree = 0
  for (const node of nodeList) {
    counts[node.type] = (counts[node.type] || 0) + 1
    if (node.degree === 0) orphans++
    if (node.degree > maxDegree) maxDegree = node.degree
  }

  return {
    nodes: nodeList,
    edges: edgeList,
    stats: {
      notes: counts.note,
      ghosts: counts.ghost,
      facts: counts.fact,
      conversations: counts.conversation,
      tags: counts.tag,
      edges: edgeList.length,
      orphans,
      maxDegree,
      files: relPaths.length,
    },
    builtAt: Date.now(),
  }
}

/** Sello del vault: mtime máximo + número de ficheros (para invalidar la caché). */
function vaultStamp(vaultPath, skipDirs) {
  if (!vaultPath) return { max: 0, count: 0 }
  const rels = walkMarkdown(vaultPath, skipDirs)
  let max = 0
  for (const rel of rels) {
    try {
      const m = statSync(join(vaultPath, rel)).mtimeMs
      if (m > max) max = m
    } catch {}
  }
  // `count` además de `max`: borrar una nota no cambia el mtime máximo de las
  // que quedan, así que sin contarlas la caché serviría un grafo con fantasmas.
  return { max, count: rels.length }
}

let cache = null

/**
 * Versión memoizada de `buildGraph`. Invalida si cambió el vault (mtime/número
 * de notas), si cambiaron las opciones, o a los 30 s (la memoria SQLite puede
 * crecer sin que ningún .md se toque, y eso no se puede detectar por mtime).
 */
export function getGraph(opts = {}) {
  const o = opts || {}
  const vaultPath = o.vaultPath ?? getVaultPath()
  const skipDirs = o.skipDirs ?? SKIP_DIRS
  const key = JSON.stringify({
    vaultPath,
    includeFacts: o.includeFacts !== false,
    includeConversations: o.includeConversations !== false,
    maxConversations: o.maxConversations ?? 20,
    includeTags: !!o.includeTags,
    injected: Array.isArray(o.facts),
    skipDirs,
  })
  const stamp = vaultStamp(vaultPath, skipDirs)
  if (
    cache && cache.key === key &&
    cache.stamp.max === stamp.max && cache.stamp.count === stamp.count &&
    Date.now() - cache.graph.builtAt < TTL_MS
  ) {
    return cache.graph
  }
  const graph = buildGraph(o)
  cache = { key, stamp, graph }
  return graph
}

/** Tira la caché (tests, y cualquier cosa que reescriba el vault a mano). */
export function clearGraphCache() {
  cache = null
}

/** Relación exportada para el modo `vault` del frontend y para los tests. */
export const NODE_TYPES = ['note', 'tag', 'fact', 'conversation', 'ghost']
export const EDGE_KINDS = ['link', 'tag', 'mention', 'fact']
