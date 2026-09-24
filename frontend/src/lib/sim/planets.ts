/** Constantes físicas reales de los cuerpos del sistema solar.
 *
 *  Separado de `presets.ts` a propósito: aquello son condiciones INICIALES
 *  (dónde está cada cuerpo y a qué velocidad), y esto son propiedades del
 *  cuerpo en sí, que no dependen de la fecha ni del preset. La tabla alimenta
 *  dos cosas que no se pueden inventar:
 *
 *    · **J2** — el achatamiento. Sin él las lunas de Júpiter trazan elipses
 *      congeladas; con él sus planos rotan como rotan de verdad.
 *    · **radio físico** — el umbral de colisión. Los cuerpos se DIBUJAN
 *      exagerados a propósito (si no, un planeta es medio píxel), así que usar
 *      el radio de dibujo haría que la Tierra chocase con Marte.
 *
 *  Three-free y Node-testable, como todo `lib/sim/`.
 *
 *  Fuentes: NASA/JPL Planetary Fact Sheets y IAU 2015 (radios ecuatoriales,
 *  km); J2 de los modelos gravitatorios estándar (EGM para la Tierra, JUP310
 *  para Júpiter, GMM para Marte).
 */

import type { SimBody } from './types'
import type { OblateBody } from './nbody'

/** Unidad astronómica en km (IAU 2012, exacta por definición). */
export const AU_KM = 149597870.7

export interface PlanetPhysical {
  /** Radio ecuatorial en km. */
  radiusKm: number
  /** Armónico zonal J2, adimensional. 0 = esfera perfecta a este orden. */
  j2: number
}

/** Claves normalizadas (sin tildes, minúsculas). Se aceptan los nombres en
 *  español y en inglés porque los presets y la voz mezclan ambos. */
export const PLANET_PHYSICAL: Record<string, PlanetPhysical> = {
  sol: { radiusKm: 696000, j2: 2.2e-7 },
  mercurio: { radiusKm: 2439.7, j2: 5.03e-5 },
  venus: { radiusKm: 6051.8, j2: 4.458e-6 },
  tierra: { radiusKm: 6378.137, j2: 1.08263e-3 },
  luna: { radiusKm: 1737.4, j2: 2.033e-4 },
  marte: { radiusKm: 3396.2, j2: 1.96045e-3 },
  jupiter: { radiusKm: 71492, j2: 1.4736e-2 },
  saturno: { radiusKm: 60268, j2: 1.6298e-2 },
  urano: { radiusKm: 25559, j2: 3.343e-3 },
  neptuno: { radiusKm: 24764, j2: 3.411e-3 },
  io: { radiusKm: 1821.6, j2: 1.846e-3 },
  europa: { radiusKm: 1560.8, j2: 4.355e-4 },
  ganimedes: { radiusKm: 2634.1, j2: 1.276e-4 },
  calisto: { radiusKm: 2410.3, j2: 3.27e-5 },
}

/** Alias inglés → clave. La voz y el modelo escriben en los dos idiomas. */
const ALIAS: Record<string, string> = {
  sun: 'sol', mercury: 'mercurio', earth: 'tierra', moon: 'luna',
  mars: 'marte', jupiter: 'jupiter', saturn: 'saturno', uranus: 'urano',
  neptune: 'neptuno', ganymede: 'ganimedes', callisto: 'calisto',
}

/** Sin tildes y en minúsculas. Misma trampa que las wake phrases: comparar
 *  "Júpiter" con "jupiter" falla en silencio y la tabla parece incompleta. */
export function normalizeBodyName(name: string | undefined): string {
  if (!name) return ''
  const flat = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  return ALIAS[flat] ?? flat
}

export function physicalOf(name: string | undefined): PlanetPhysical | undefined {
  return PLANET_PHYSICAL[normalizeBodyName(name)]
}

/** Eje de giro unitario a partir de la oblicuidad, en grados.
 *
 *  Se inclina alrededor del eje x. La AZIMUT real del polo (su ascensión
 *  recta) NO se modela: haría falta el par RA/Dec del polo de cada cuerpo, y
 *  para el efecto que nos ocupa lo que manda es la MAGNITUD de la inclinación
 *  — el J2 es un armónico zonal, simétrico alrededor del eje. Queda escrito
 *  aquí para que nadie lo tome por un olvido. */
export function spinAxis(tiltDeg = 0): [number, number, number] {
  const e = (tiltDeg * Math.PI) / 180
  return [0, -Math.sin(e), Math.cos(e)]
}

/** Los cuerpos achatados de una lista, listos para `oblatenessAccel`.
 *
 *  `minJ2` descarta lo irrelevante: el J2 del Sol es 2.2e-7, cinco órdenes por
 *  debajo del de Júpiter, así que incluirlo es gastar un bucle O(n) por paso
 *  para mover los planetas menos de lo que mueve el redondeo. */
export function oblateBodies(
  bodies: SimBody[], minJ2 = 1e-4, lengthPerKm = 1 / AU_KM,
): OblateBody[] {
  const out: OblateBody[] = []
  bodies.forEach((b, index) => {
    const phys = physicalOf(b.name)
    if (!phys || phys.j2 < minJ2) return
    out.push({
      index,
      j2: phys.j2,
      radius: phys.radiusKm * lengthPerKm,
      axis: spinAxis(b.tilt),
    })
  })
  return out
}

/** Radios de COLISIÓN (físicos, no de dibujo) en unidades de simulación.
 *  Devuelve `undefined` si ningún cuerpo de la lista está tabulado: sin datos
 *  reales es mejor no colisionar que colisionar con un umbral inventado. */
export function collisionRadii(
  bodies: SimBody[], lengthPerKm = 1 / AU_KM,
): Float64Array | undefined {
  const out = new Float64Array(bodies.length)
  let any = false
  bodies.forEach((b, i) => {
    const phys = physicalOf(b.name)
    if (!phys) return
    out[i] = phys.radiusKm * lengthPerKm
    any = true
  })
  return any ? out : undefined
}
