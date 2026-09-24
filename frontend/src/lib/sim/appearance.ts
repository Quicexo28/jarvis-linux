/** Apariencia física de los cuerpos: con qué textura se visten, cuánto está
 *  inclinado su eje, cuánto tardan en dar una vuelta y quién tiene anillos.
 *
 *  Esto NO entra en la integración: un planeta gira igual de rápido lo lleve
 *  puesto o no. Vive aparte de `presets.ts` porque es la MISMA tabla para un
 *  cuerpo venga de un preset o lo escriba el modelo a mano en el spec, y porque
 *  así se puede probar en Node — este módulo es Three-free, igual que el resto
 *  de `lib/sim/` (la conversión a materiales vive en el `.tsx`).
 *
 *  Fuentes de los números: NASA/NSSDC Planetary Fact Sheets
 *  (https://nssdc.gsfc.nasa.gov/planetary/factsheet/) — oblicuidad respecto a la
 *  órbita y periodo de rotación SIDÉREO en días. Los radios de los anillos de
 *  Saturno son los del anillo B/A (1.24 → 2.27 radios ecuatoriales).
 */

import type { SimBody } from './types'

/* ---------------- Texturas ---------------- */

/** Dónde las sirve vite. `public/` NO se vacía en el build, así que los
 *  ficheros llegan tal cual al bundle (ver public/textures/README.txt). */
export const TEXTURE_BASE = '/textures/'

/** Clave lógica → fichero. Las claves son lo que el spec escribe (`texture:
 *  'earth'`), así que renombrar un fichero no obliga a tocar ningún preset. */
export const TEXTURES: Record<string, string> = {
  sun: '2k_sun.jpg',
  mercury: '2k_mercury.jpg',
  // De Venus se ve la ATMÓSFERA, no el suelo: la superficie solo existe en
  // radar. La textura de suelo queda accesible por su propia clave.
  venus: '2k_venus_atmosphere.jpg',
  venus_surface: '2k_venus_surface.jpg',
  earth: '2k_earth_daymap.jpg',
  earth_night: '2k_earth_nightmap.jpg',
  earth_clouds: '2k_earth_clouds.jpg',
  moon: '2k_moon.jpg',
  mars: '2k_mars.jpg',
  jupiter: '2k_jupiter.jpg',
  saturn: '2k_saturn.jpg',
  saturn_ring: '2k_saturn_ring_alpha.png',
  uranus: '2k_uranus.jpg',
  neptune: '2k_neptune.jpg',
}

const IMAGE_RE = /\.(jpe?g|png|webp|avif)$/i

/** Clave de la tabla o ruta explícita → ruta servible. Devuelve `undefined`
 *  para lo desconocido, que es la señal de "cae al color plano": una clave con
 *  errata tiene que degradar, nunca pedir un 404 que el renderer pintaría negro. */
export function texturePath(ref?: string): string | undefined {
  if (!ref) return undefined
  const raw = ref.trim()
  if (!raw) return undefined
  if (raw.startsWith('/') || raw.startsWith('http://') || raw.startsWith('https://')) return raw
  if (IMAGE_RE.test(raw)) return TEXTURE_BASE + raw
  const file = TEXTURES[normalizeName(raw).replace(/[\s-]+/g, '_')]
  return file ? TEXTURE_BASE + file : undefined
}

/* ---------------- Nombres ---------------- */

/** Minúsculas y SIN TILDES. Misma trampa que las wake phrases y el grafo del
 *  vault: un preset dice "Júpiter" y el spec del modelo puede decir "jupiter"
 *  o "Jupiter", y son el mismo planeta. */
export function normalizeName(name?: string): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/* ---------------- Tabla ---------------- */

export interface RingAppearance {
  /** Radio interior en RADIOS DEL CUERPO (no en unidades de escena). */
  inner: number
  outer: number
  /** Clave o ruta de textura; con alfa, para que el hueco de Cassini se vea. */
  texture?: string
  /** Inclinación propia en grados. Por defecto el anillo vive en el ecuador
   *  del planeta, que es donde lo pone la física (aplanamiento + mareas). */
  tilt?: number
}

/** Lo que el renderer necesita saber de un cuerpo, ya resuelto. */
export interface BodyAppearance {
  /** Ruta servible de la textura de color, o `undefined` = color plano. */
  texture?: string
  /** Oblicuidad del eje en GRADOS respecto a la normal de la órbita. */
  tilt: number
  /** Periodo de rotación en unidades de tiempo del sistema. 0 = no gira. */
  rotationPeriod: number
  rings?: RingAppearance
  /** Es una estrella: se ilumina sola y alumbra al resto. */
  emissive: boolean
  /** Capa de nubes (ruta), dibujada como una esfera de alfa por encima. */
  clouds?: string
  /** Mapa nocturno (ruta) para el lado en sombra: luces de ciudad. */
  night?: string
}

interface AppearanceRow {
  texture?: string
  tilt?: number
  rotationPeriod?: number
  rings?: RingAppearance
  emissive?: boolean
  clouds?: string
  night?: string
}

/** Un cuerpo del que no se sabe nada: esfera de color plano, quieta. */
export const DEFAULT_APPEARANCE: BodyAppearance = {
  texture: undefined, tilt: 0, rotationPeriod: 0, emissive: false,
}

const ROWS: Record<string, AppearanceRow> = {
  // El Sol gira DIFERENCIALMENTE (25.05 d en el ecuador, 34 d cerca del polo);
  // 25.38 d es el periodo sidéreo de Carrington, el que se usa por convenio.
  sun: { texture: 'sun', tilt: 7.25, rotationPeriod: 25.38, emissive: true },
  mercury: { texture: 'mercury', tilt: 0.034, rotationPeriod: 58.646 },
  venus: { texture: 'venus', tilt: 177.36, rotationPeriod: -243.025 },
  earth: {
    texture: 'earth', tilt: 23.44, rotationPeriod: 0.99727,
    clouds: 'earth_clouds', night: 'earth_night',
  },
  moon: { texture: 'moon', tilt: 6.68, rotationPeriod: 27.3217 },
  mars: { texture: 'mars', tilt: 25.19, rotationPeriod: 1.02596 },
  jupiter: { texture: 'jupiter', tilt: 3.13, rotationPeriod: 0.41354 },
  saturn: {
    texture: 'saturn', tilt: 26.73, rotationPeriod: 0.44401,
    rings: { inner: 1.24, outer: 2.27, texture: 'saturn_ring' },
  },
  uranus: { texture: 'uranus', tilt: 97.77, rotationPeriod: -0.71833 },
  neptune: { texture: 'neptune', tilt: 28.32, rotationPeriod: 0.67125 },
}

/** Nombre hablado/escrito → fila. Incluye el castellano de los presets. */
const ALIASES: Record<string, string> = {
  sol: 'sun', helios: 'sun',
  mercurio: 'mercury',
  tierra: 'earth', terra: 'earth',
  luna: 'moon',
  marte: 'mars',
  jupiter: 'jupiter',
  saturno: 'saturn',
  urano: 'uranus',
  neptuno: 'neptune',
}

/** Fila de la tabla para un nombre, o `undefined` si no se conoce el cuerpo. */
export function lookupAppearance(name?: string): AppearanceRow | undefined {
  const key = normalizeName(name)
  if (!key) return undefined
  return ROWS[ALIASES[key] ?? key]
}

/** Apariencia final de un cuerpo. Prioridad: lo que el spec trae EXPLÍCITO
 *  gana sobre la tabla, y la tabla gana sobre el default. Así el modelo puede
 *  pedir "la Tierra pero sin nubes ni inclinación" sin perder la textura. */
export function resolveAppearance(body?: SimBody, name?: string): BodyAppearance {
  const row = lookupAppearance(name ?? body?.name) ?? {}
  const texture = texturePath(body?.texture ?? row.texture)
  const ringSrc = body?.rings ?? row.rings
  return {
    texture,
    tilt: body?.tilt ?? row.tilt ?? 0,
    rotationPeriod: body?.rotationPeriod ?? row.rotationPeriod ?? 0,
    rings: ringSrc
      ? {
        inner: ringSrc.inner,
        outer: ringSrc.outer,
        texture: texturePath(ringSrc.texture ?? row.rings?.texture),
        tilt: ringSrc.tilt ?? 0,
      }
      : undefined,
    emissive: body?.emissive ?? row.emissive ?? false,
    // Nubes y mapa nocturno son detalle de la tabla, no del contrato del spec:
    // solo la Tierra los tiene hoy y no hay forma de escribirlos a mano.
    clouds: texturePath(row.clouds),
    night: texturePath(row.night),
  }
}

/** ¿Merece este cuerpo su propia malla? Solo los texturizados y las estrellas
 *  salen del InstancedMesh: cada textura es un material distinto, y convertir
 *  1000 partículas en 1000 mallas hunde el frame rate. */
export function needsOwnMesh(look: BodyAppearance): boolean {
  return !!look.texture || look.emissive
}

/** Los campos de apariencia listos para pegar en un `SimBody` de preset.
 *  Mantiene UNA sola fuente de verdad: el preset no copia números, referencia
 *  la tabla. Solo emite lo definido, para no ensuciar el spec con ceros. */
export function appearanceFor(name: string): Partial<SimBody> {
  const row = lookupAppearance(name)
  if (!row) return {}
  const out: Partial<SimBody> = {}
  if (row.texture) out.texture = row.texture
  if (row.tilt !== undefined) out.tilt = row.tilt
  if (row.rotationPeriod !== undefined) out.rotationPeriod = row.rotationPeriod
  if (row.rings) out.rings = { ...row.rings }
  if (row.emissive) out.emissive = true
  return out
}

/* ---------------- Giro ---------------- */

/** ¿La oblicuidad pone el polo norte del cuerpo por debajo del plano? */
export function axisIsFlipped(tiltDeg: number): boolean {
  const t = ((tiltDeg % 360) + 360) % 360
  return t > 90 && t < 270
}

/** Signo del giro ALREDEDOR DEL EJE PROPIO, ya inclinado.
 *
 *  Trampa doble: las tablas de la NASA describen un rotador retrógrado DOS
 *  veces — con el periodo en negativo Y con la oblicuidad por encima de 90°
 *  (Venus 177.36°, Urano 97.77°). Son la misma información dicha dos veces, así
 *  que aplicarlas las dos se cancela y Venus acabaría girando al derecho. Aquí
 *  el eje se inclina con la oblicuidad REAL y el signo se descuenta contra ella,
 *  de modo que el sentido APARENTE visto desde el norte de la órbita siempre
 *  coincide con el signo del periodo — que es lo que dice el contrato del spec. */
export function spinSign(period: number, tiltDeg = 0): number {
  if (!period || !Number.isFinite(period)) return 0
  const s = period < 0 ? -1 : 1
  return axisIsFlipped(tiltDeg) ? -s : s
}

/** Sentido visto desde el polo norte de la órbita: +1 directo, −1 retrógrado. */
export function apparentSpinSign(period: number, tiltDeg = 0): number {
  return spinSign(period, tiltDeg) * (axisIsFlipped(tiltDeg) ? -1 : 1)
}

/** Ángulo de giro propio en radianes: 2π·t/P, con el sentido de `spinSign`. */
export function spinAngle(t: number, period: number, tiltDeg = 0): number {
  const sign = spinSign(period, tiltDeg)
  if (!sign || !Number.isFinite(t)) return 0
  return (sign * 2 * Math.PI * t) / Math.abs(period)
}

/** Cuánto hay que ALARGAR todos los periodos para que el giro se pueda ver.
 *
 *  A la escala temporal de los presets orbitales (20 días por segundo en
 *  `solar`) la Tierra daría 20 vueltas por segundo: no es rotación, es un
 *  estroboscopio — y encima con aliasing, porque el ojo y el frame rate no
 *  llegan. El factor es ÚNICO para todo el sistema (no uno por cuerpo), así que
 *  las razones entre periodos se conservan exactas: Venus sigue tardando 243
 *  veces lo que la Tierra. Es la misma concesión declarada que los radios
 *  exagerados de los cuerpos o la compresión logarítmica de las distancias.
 *
 *  @param periods periodos en unidades de simulación (el signo da igual)
 *  @param timeScale unidades de simulación por segundo real
 *  @param maxRevPerSecond vueltas por segundo del cuerpo MÁS rápido
 *  @returns factor ≥ 1 por el que multiplicar cada periodo */
export function spinSlowdown(periods: number[], timeScale: number, maxRevPerSecond = 0.25): number {
  if (!Number.isFinite(timeScale) || timeScale <= 0 || maxRevPerSecond <= 0) return 1
  let fastest = 0
  for (const p of periods) {
    if (!p || !Number.isFinite(p)) continue
    const rev = Math.abs(timeScale / p)
    if (rev > fastest) fastest = rev
  }
  if (fastest <= maxRevPerSecond) return 1
  return fastest / maxRevPerSecond
}
