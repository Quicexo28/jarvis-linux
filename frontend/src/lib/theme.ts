/**
 * Sistema de color semántico — FUENTE ÚNICA de verdad.
 *
 * Antes de este módulo el color vivía en dos sitios que nadie mantenía a la
 * par: `styles/design-system.css` (unas pocas variables) y literalmente 106
 * apariciones sueltas de `#00f0ff` dentro de los `.tsx`, más una nube de
 * acentos improvisados (`#64ffda`, `#ffd700`, `#ff5252`, `#00e5ff`, `#38d5ff`,
 * `#ff5f8f`…). El resultado era monocromo donde hacía falta información y
 * arbitrario donde hacía falta calma.
 *
 * La regla de este sistema: **el hue es significado, nunca decoración.** Un
 * número en ámbar quiere decir "mírame", no "queda bonito en ámbar". De ahí que
 * los helpers (`severityHue`, `nodeHue`) DERIVEN el color del dato en vez de
 * dejar que cada componente lo elija a mano.
 *
 * Por qué TypeScript y no solo CSS: el 3D (react-three-fiber) no lee variables
 * CSS — necesita el hex en JS. Si el CSS fuera la única fuente, el visor y el
 * DOM divergirían en silencio. Así que este módulo es la fuente y el CSS es su
 * espejo, con un test de PARIDAD (`theme.test.ts`) que compara `cssVars()`
 * contra el bloque `:root` del stylesheet — misma disciplina que el test de
 * deriva de `lib/voiceTools.js` en el backend.
 *
 * Three-free a propósito: solo strings y aritmética, así corre en Node bajo
 * vitest sin arrastrar WebGL.
 */

/** Roles semánticos. Añadir uno obliga a añadir su token en el CSS (lo exige el test). */
export type Role = 'info' | 'deep' | 'attn' | 'voice' | 'ok' | 'fail' | 'idle'

/**
 * El ADN cyan se queda como base (`info`): es lo que hace que Jarvis parezca
 * Jarvis. Lo que cambia es que ahora hay CUATRO significados más, cada uno con
 * un hue propio, en vez de teñir todo de cyan y perder la señal.
 */
export const HUE: Record<Role, string> = {
  info:  '#00f0ff', // dato neutro, estructura, lo que simplemente ES
  deep:  '#0059ff', // profundidad: sombras, fondos de gradiente, segundo plano
  attn:  '#ffb01f', // atención: umbral superado, algo que conviene mirar
  voice: '#ff4fd8', // voz activa — Jarvis escucha o habla
  ok:    '#3dffa8', // confirmado, sano, en línea
  fail:  '#ff4d5e', // fallo, caído, rechazado
  idle:  '#5d7f8f', // inactivo, apagado, sin datos
}

/**
 * Jerarquía por LUMINANCIA, no por color. Cuatro niveles y ni uno más: en
 * cuanto hay cinco, nadie distingue el cuarto del quinto y se usan al azar.
 */
export const TEXT = {
  primary:   '#e6faff',                    // el dato que importa
  secondary: 'rgba(200, 244, 255, 0.72)',  // etiquetas, contexto inmediato
  muted:     'rgba(200, 244, 255, 0.45)',  // metadatos, unidades
  faint:     'rgba(200, 244, 255, 0.26)',  // separadores, texto de relleno
} as const

/** Fondo base de la app. Casi negro con una gota de azul — no negro puro. */
export const BG = '#03080d'

/**
 * Un hue por carpeta de la bóveda. Esto es lo que produce los cúmulos de color
 * del grafo 3D: el ojo agrupa por color antes de leer una sola etiqueta, así
 * que la carpeta (que es la taxonomía REAL del vault) es lo que se codifica.
 *
 * Reutiliza los roles semánticos donde el significado coincide — `01-Perfil` es
 * magenta porque es el señor mismo, igual que la voz; `02-Proyectos` es ámbar
 * porque es trabajo vivo que reclama atención.
 */
export const FOLDER_HUE: Record<string, string> = {
  '00-System':        '#7a8cff', // índigo — la maquinaria
  '01-Perfil':        HUE.voice, // el señor
  '02-Proyectos':     HUE.attn,  // trabajo vivo
  '03-Conocimiento':  HUE.info,  // saber estable
  '04-Habitos':       HUE.ok,    // rutina sana
  '05-Daily':         '#5de0ff', // cyan claro — el día a día
  '06-Conversaciones': '#a06bff', // violeta — lo hablado
  'Wiki':             '#00d0a8', // teal
  'Clippings':        '#ff8a5c', // coral — material ajeno traído de fuera
  'memoria':          '#ff4d90', // rosa — lo que Jarvis aprendió por su cuenta
  'tags':             '#8fa0b0', // pizarra — metadato, no contenido
  // Dos "carpetas" que no son carpetas: las emite el builder del backend para
  // las notas de la raíz del vault y para los enlaces a notas que aún no
  // existen. Van explícitas para que la leyenda las nombre en vez de
  // asignarles un color de la rampa de reserva.
  'raiz':             '#8fb4c4', // notas sueltas en la raíz
  'fantasmas':        HUE.idle,  // enlazadas pero sin crear
}

/**
 * Rampa para carpetas que aún no existen. El hash las fija: una carpeta nueva
 * recibe SIEMPRE el mismo color entre sesiones, que es lo que permite
 * reconocerla de un vistazo sin tener que registrarla aquí.
 */
export const FALLBACK_RAMP: readonly string[] = [
  '#00f0ff', '#ffb01f', '#3dffa8', '#a06bff',
  '#ff8a5c', '#00d0a8', '#7a8cff', '#ff4d90',
]

/** FNV-1a de 32 bits. Determinista y estable entre ejecuciones (a diferencia de un índice de inserción). */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Hue de una carpeta del vault: mapa curado y, si no está, rampa determinista. */
export function folderHue(folder: string): string {
  const known = FOLDER_HUE[folder]
  if (known) return known
  if (!folder) return HUE.idle
  return FALLBACK_RAMP[hashString(folder) % FALLBACK_RAMP.length]
}

/**
 * Color de un nodo del grafo. El TIPO manda solo cuando dice algo que la
 * carpeta no dice: un fantasma (enlace a una nota que no existe) va apagado
 * porque no es contenido todavía, y un tag va en pizarra porque es metadato.
 * Todo lo demás lo decide la carpeta.
 */
export function nodeHue(node: { folder?: string; type?: string }): string {
  if (node.type === 'ghost') return HUE.idle
  if (node.type === 'tag') return FOLDER_HUE.tags
  return folderHue(node.folder ?? '')
}

/**
 * Hue derivado de un valor contra sus umbrales. Esta función es la que hace
 * cumplir "hue = significado": un medidor no elige su color, lo recibe del dato.
 *
 * @param value  valor medido
 * @param warn   umbral de atención (ámbar a partir de aquí)
 * @param crit   umbral crítico (rojo a partir de aquí)
 * @param invert true cuando lo BAJO es lo malo (batería, espacio libre)
 */
export function severityHue(
  value: number,
  { warn, crit, invert = false }: { warn: number; crit: number; invert?: boolean },
): string {
  if (!Number.isFinite(value)) return HUE.idle
  const past = (threshold: number) => (invert ? value <= threshold : value >= threshold)
  if (past(crit)) return HUE.fail
  if (past(warn)) return HUE.attn
  return HUE.info
}

/** `#rrggbb` → `[r, g, b]` en 0..255. Lanza ante un hex inválido: un color mal escrito debe doler pronto. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`hex inválido: ${hex}`)
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `#rrggbb` + alpha → string `rgba()`, para bordes y rellenos de vidrio. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Mezcla lineal en sRGB. Basta para gradientes de UI; no pretende ser perceptual. */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const k = Math.max(0, Math.min(1, t))
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0')
  return `#${ch(r1, r2)}${ch(g1, g2)}${ch(b1, b2)}`
}

/** Luminancia relativa WCAG. La usa el test de contraste — un hue ilegible es un bug. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Razón de contraste WCAG entre dos colores opacos. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Los tokens CSS que el stylesheet DEBE declarar en `:root`, derivados de lo de
 * arriba. `theme.test.ts` compara este objeto contra el CSS real; si alguien
 * cambia un hue en un solo lado, el test lo caza en vez de dejar que el DOM y el
 * 3D pinten colores distintos para la misma cosa.
 */
export function cssVars(): Record<string, string> {
  const vars: Record<string, string> = {
    '--bg': BG,
    '--text': TEXT.primary,
    '--text-2': TEXT.secondary,
    '--text-dim': TEXT.muted,
    '--text-faint': TEXT.faint,
  }
  for (const [role, hex] of Object.entries(HUE)) {
    vars[`--hue-${role}`] = hex
    // Variante translúcida de cada rol: evita 40 `rgba(...)` escritos a mano en
    // el CSS, cada uno con un alpha distinto elegido a ojo.
    vars[`--hue-${role}-dim`] = withAlpha(hex, 0.15)
    vars[`--hue-${role}-glow`] = withAlpha(hex, 0.4)
  }
  for (const [folder, hex] of Object.entries(FOLDER_HUE)) {
    vars[`--folder-${folder.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`] = hex
  }
  return vars
}

/** El bloque `:root` completo, indentado, tal como debe aparecer en el CSS. Sirve para regenerarlo sin escribirlo a mano. */
export function cssRootBlock(): string {
  const entries = Object.entries(cssVars())
  const pad = Math.max(...entries.map(([k]) => k.length)) + 2
  return entries.map(([k, v]) => `  ${(k + ':').padEnd(pad)}${v};`).join('\n')
}
