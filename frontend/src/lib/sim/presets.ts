/** Ready-made systems with real physical data.
 *
 *  Units for every orbital preset: AU, days, solar masses (so G = G_AU). Keeping
 *  ONE unit system across presets is what lets the engine, the HUD and the tests
 *  share formulas instead of each carrying its own conversion.
 */

import { G_AU, PLANETS, planetState, period, type PlanetElementRow } from './kepler'
import { appearanceFor } from './appearance'
import { oblateBodies, collisionRadii } from './planets'
import type { NBodyBuild, RadialMode } from './nbody'
import type { NBodySpec, SimBody, SimCommon, Vec3 } from './types'

/** Earth masses / Jupiter radii etc., in the working units. */
const M_EARTH = 3.0035e-6
const AU_KM = 1.495978707e8

/** Display radius from a real one. Cube-root compression: a linear map would
 *  make every planet an invisible sub-pixel next to the Sun, and a flat radius
 *  would lose the Jupiter-vs-Mercury story entirely. */
export function displayRadius(radiusKm: number, k = 0.1): number {
  return k * Math.cbrt(radiusKm / 6371)
}

const SUN: SimBody = {
  name: 'Sol', mass: 1, position: [0, 0, 0], velocity: [0, 0, 0],
  radius: displayRadius(696340) * 0.55, color: '#ffcf47', fixed: true,
  info: { 'Radio': '696 340 km', 'Masa': '1 M☉' },
  // Textura + `emissive`: el Sol deja de ser una bola amarilla y pasa a ser la
  // FUENTE de luz de la escena (y de las sombras, o sea de los eclipses).
  ...appearanceFor('Sol'),
}

/** Circular orbit state in the xy plane at radius a about a mass at the origin. */
function circular(a: number, GM: number, phase = 0, inclination = 0): { position: Vec3; velocity: Vec3 } {
  const v = Math.sqrt(GM / a)
  const c = Math.cos(phase), s = Math.sin(phase)
  const ci = Math.cos(inclination), si = Math.sin(inclination)
  return {
    position: [a * c, a * s * ci, a * s * si],
    velocity: [-v * s, v * c * ci, v * c * si],
  }
}

function planetBody(row: PlanetElementRow, date: Date): SimBody {
  const st = planetState(row, date)
  return {
    name: row.name,
    mass: row.mass,
    position: st.position,
    velocity: st.velocity,
    radius: displayRadius(row.radiusKm),
    color: row.color,
    // La apariencia se referencia, no se copia: la tabla de `appearance.ts` es
    // la única fuente de texturas, oblicuidades, periodos y anillos.
    ...appearanceFor(row.name),
    info: {
      'Radio': `${row.radiusKm.toLocaleString('es')} km`,
      'Periodo': `${period(row.el[0]).toFixed(1)} d`,
      'a': `${row.el[0].toFixed(3)} AU`,
      'e': row.el[1].toFixed(4),
    },
  }
}

interface PresetResult {
  bodies: SimBody[]
  rows?: (PlanetElementRow | undefined)[]
  G: number
  mode: 'kepler' | 'nbody'
  dt: number
  timeScale: number
  radial: RadialMode
  radialK: number
  softening: number
  trail: number
  showOrbits: boolean
  title: string
}

function solarSubset(names: string[], date: Date, opts: Partial<PresetResult>): PresetResult {
  const rows = PLANETS.filter((p) => names.includes(p.name))
  return {
    bodies: [SUN, ...rows.map((r) => planetBody(r, date))],
    rows: [undefined, ...rows],
    G: G_AU, mode: 'kepler', dt: 0.5, timeScale: 20,
    radial: 'linear', radialK: 1, softening: 0,
    trail: 600, showOrbits: true, title: 'Sistema solar',
    ...opts,
  }
}

export function buildPreset(name: string, date: Date): PresetResult {
  switch (name) {
    case 'solar':
      // Log radial compression: 0.39 → 30 AU on one screen is otherwise four
      // pixels of inner system. HUD flags that distances are compressed.
      return solarSubset(PLANETS.map((p) => p.name), date, {
        radial: 'log', radialK: 0.6, timeScale: 20, title: 'Sistema solar',
      })

    case 'inner':
      return solarSubset(['Mercurio', 'Venus', 'Tierra', 'Marte'], date, {
        timeScale: 8, title: 'Sistema solar interior',
      })

    case 'outer':
      return solarSubset(['Júpiter', 'Saturno', 'Urano', 'Neptuno'], date, {
        timeScale: 200, title: 'Planetas exteriores',
      })

    case 'earth-moon': {
      const mEarth = 3.0035e-6, mMoon = 3.6943e-8
      const a = 384400 / AU_KM
      const GM = G_AU * (mEarth + mMoon)
      const moon = circular(a, GM, 0, 5.145 * Math.PI / 180)
      // Barycentric split so the Earth wobbles the way it really does.
      const f = mMoon / (mEarth + mMoon)
      return {
        bodies: [
          {
            name: 'Tierra', mass: mEarth,
            position: moon.position.map((v) => -v * f) as Vec3,
            velocity: moon.velocity.map((v) => -v * f) as Vec3,
            radius: 0.35, color: '#4b93d1', ...appearanceFor('Tierra'),
            info: { 'Radio': '6 371 km' },
          },
          {
            name: 'Luna', mass: mMoon,
            position: moon.position.map((v) => v * (1 - f)) as Vec3,
            velocity: moon.velocity.map((v) => v * (1 - f)) as Vec3,
            radius: 0.1, color: '#cfcfcf', ...appearanceFor('Luna'),
            info: { 'Radio': '1 737 km', 'Periodo': '27.32 d', 'Inclinación': '5.145°' },
          },
        ],
        G: G_AU, mode: 'nbody', dt: 0.02, timeScale: 4,
        radial: 'linear', radialK: 1, softening: 0,
        trail: 500, showOrbits: false, title: 'Tierra–Luna',
      }
    }

    case 'jupiter-moons': {
      // Laplace resonance 1:2:4 (Io:Europa:Ganímedes) — visible within a minute.
      const mJ = 9.5479e-4
      const GM = G_AU * mJ
      const moons: Array<[string, number, number, string]> = [
        ['Ío', 421700, 4.490e-8, '#e8d84b'],
        ['Europa', 671100, 2.413e-8, '#d8d0c0'],
        ['Ganímedes', 1070400, 7.451e-8, '#9a8b78'],
        ['Calisto', 1882700, 5.409e-8, '#6b6259'],
      ]
      return {
        bodies: [
          {
            name: 'Júpiter', mass: mJ, position: [0, 0, 0], velocity: [0, 0, 0],
            radius: 0.5, color: '#d8a46b', fixed: true, ...appearanceFor('Júpiter'),
          },
          ...moons.map(([n, km, m, color], i) => {
            const a = km / AU_KM
            const st = circular(a, GM, (i * Math.PI) / 2)
            return {
              name: n, mass: m, position: st.position, velocity: st.velocity,
              radius: 0.09, color,
              info: { 'a': `${km.toLocaleString('es')} km`, 'Periodo': `${period(a, GM).toFixed(3)} d` },
            } as SimBody
          }),
        ],
        G: G_AU, mode: 'nbody', dt: 0.005, timeScale: 1.2,
        radial: 'linear', radialK: 1, softening: 0,
        trail: 400, showOrbits: false, title: 'Lunas galileanas (resonancia 1:2:4)',
      }
    }

    case 'binary': {
      const d = 1, GM = G_AU * 2
      const vRel = Math.sqrt(GM / d)
      return {
        bodies: [
          // Dos SOLES: cada uno se ilumina solo y alumbra al otro, así que el
          // par se ve como lo que es y no como dos canicas de colores.
          { name: 'A', mass: 1, position: [d / 2, 0, 0], velocity: [0, vRel / 2, 0], radius: 0.3, color: '#ffd08a', emissive: true },
          { name: 'B', mass: 1, position: [-d / 2, 0, 0], velocity: [0, -vRel / 2, 0], radius: 0.3, color: '#8ac6ff', emissive: true },
        ],
        G: G_AU, mode: 'nbody', dt: 0.25, timeScale: 40,
        radial: 'linear', radialK: 1, softening: 1e-4,
        trail: 400, showOrbits: false, title: 'Binaria de masas iguales',
      }
    }

    case 'figure8': {
      // Chenciner–Montgomery choreography: three equal masses chasing each other
      // along one figure-eight curve. G = m = 1, period ≈ 6.3259.
      const v: Vec3 = [0.93240737, 0.86473146, 0]
      return {
        bodies: [
          { name: '1', mass: 1, position: [0.97000436, -0.24308753, 0], velocity: [v[0] / 2, v[1] / 2, 0], radius: 0.12, color: '#00f0ff' },
          { name: '2', mass: 1, position: [-0.97000436, 0.24308753, 0], velocity: [v[0] / 2, v[1] / 2, 0], radius: 0.12, color: '#ff5f8f' },
          { name: '3', mass: 1, position: [0, 0, 0], velocity: [-v[0], -v[1], 0], radius: 0.12, color: '#7cff6b' },
        ],
        G: 1, mode: 'nbody', dt: 0.0015, timeScale: 1.4,
        radial: 'linear', radialK: 1, softening: 0,
        trail: 1400, showOrbits: false, title: 'Órbita en ocho (3 cuerpos)',
      }
    }

    case 'lagrange': {
      // Sun + Jupiter + massless trojans 60° ahead (L4) and behind (L5).
      const mJ = 9.5479e-4, aJ = 5.2028870
      const GM = G_AU * (1 + mJ)
      const jup = circular(aJ, GM, 0)
      const l4 = circular(aJ, GM, Math.PI / 3)
      const l5 = circular(aJ, GM, -Math.PI / 3)
      return {
        bodies: [
          { ...SUN, fixed: false },
          { name: 'Júpiter', mass: mJ, position: jup.position, velocity: jup.velocity, radius: 0.3, color: '#d8a46b' },
          { name: 'Troyanos L4', mass: 1e-14, position: l4.position, velocity: l4.velocity, radius: 0.09, color: '#7cff6b' },
          { name: 'Griegos L5', mass: 1e-14, position: l5.position, velocity: l5.velocity, radius: 0.09, color: '#ff5f8f' },
        ],
        G: G_AU, mode: 'nbody', dt: 1, timeScale: 900,
        radial: 'linear', radialK: 1, softening: 1e-4,
        trail: 900, showOrbits: false, title: 'Puntos de Lagrange L4 / L5',
      }
    }

    case 'trappist': {
      const mStar = 0.0898
      const GM = G_AU * mStar
      const planets: Array<[string, number, number, string]> = [
        ['b', 0.01154, 1.374, '#ff8a80'],
        ['c', 0.01580, 1.308, '#ffb26b'],
        ['d', 0.02227, 0.388, '#ffe08a'],
        ['e', 0.02925, 0.692, '#7cff6b'],
        ['f', 0.03849, 1.039, '#64ffda'],
        ['g', 0.04683, 1.321, '#38d5ff'],
        ['h', 0.06189, 0.326, '#8ab4ff'],
      ]
      return {
        bodies: [
          // Enana roja: sin textura propia (no hay ninguna de una M8V), pero
          // `emissive` la convierte en la luz del sistema.
          { name: 'TRAPPIST-1', mass: mStar, position: [0, 0, 0], velocity: [0, 0, 0], radius: 0.35, color: '#ff6b3d', fixed: true, emissive: true },
          ...planets.map(([n, a, mEarths, color], i) => {
            const st = circular(a, GM, (i * 2 * Math.PI) / 7)
            return {
              name: `TRAPPIST-1${n}`, mass: mEarths * M_EARTH,
              position: st.position, velocity: st.velocity,
              radius: 0.07, color,
              info: { 'a': `${a} AU`, 'Periodo': `${period(a, GM).toFixed(2)} d`, 'Masa': `${mEarths} M⊕` },
            } as SimBody
          }),
        ],
        G: G_AU, mode: 'nbody', dt: 0.004, timeScale: 1.5,
        radial: 'linear', radialK: 1, softening: 1e-6,
        trail: 500, showOrbits: false, title: 'TRAPPIST-1 (cadena resonante)',
      }
    }

    default:
      return buildPreset('solar', date)
  }
}

/** Largest |r| over the bodies — drives the automatic view scale. */
export function spanOf(bodies: SimBody[], radial: RadialMode, k: number): number {
  let max = 0
  for (const b of bodies) {
    const r = Math.hypot(b.position[0], b.position[1], b.position[2])
    const mapped = radial === 'log' ? Math.log1p(r / k) * k : r
    if (mapped > max) max = mapped
  }
  return max || 1
}

/** Spec → everything NBodyEngine needs, filling defaults from the preset. */
export function buildNBody(spec: NBodySpec & SimCommon): NBodyBuild {
  const startDate = spec.startDate ? new Date(spec.startDate) : new Date()
  const date = isNaN(startDate.getTime()) ? new Date() : startDate

  const preset = spec.preset || (spec.bodies?.length ? null : 'solar')
  const base = preset ? buildPreset(preset, date) : null

  const bodies = spec.bodies?.length ? spec.bodies : base!.bodies
  const radial = base?.radial ?? 'linear'
  const radialK = base?.radialK ?? 1
  const span = spanOf(bodies, radial, radialK)

  const mode = spec.mode ?? base?.mode ?? 'nbody'
  // Las correcciones solo tienen sentido integrando: el modo kepler propaga
  // elipses analíticas y no evalúa fuerza ninguna. Pedir `relativistic` ahí no
  // es un error del usuario — es que ese modo responde otra pregunta.
  const integrating = mode === 'nbody'
  const G = spec.G ?? base?.G ?? G_AU

  // **Unidades REALES o nada.** El término 1PN lleva dentro c = 173.1446 AU/día;
  // ese número solo significa algo si las longitudes son AU y los tiempos días,
  // que es justo lo que codifica `G_AU`. Presets como `figure8` o `lagrange`
  // son coreografías matemáticas en unidades arbitrarias (G = 1, masas = 1):
  // aplicarles una corrección relativista no es "más realista", es multiplicar
  // por una constante sin sentido — y de hecho rompía la cerrazón de la órbita
  // en ocho, que es una solución EXACTA de la gravedad newtoniana.
  //
  // Encendidas por defecto donde sí aplican: cuestan un bucle O(n) por paso
  // sobre ≤64 cuerpos y son la diferencia entre la órbita de libro y la que se
  // mide en el cielo. Un `relativistic: true` explícito manda igualmente — si
  // el usuario trabaja en unidades solares con su propia G, es su decisión.
  const solarUnits = Math.abs(G / G_AU - 1) < 1e-9
  const relativistic = integrating && (spec.relativistic ?? solarUnits)

  // El achatamiento se identifica POR NOMBRE contra la tabla física, así que en
  // un preset abstracto no encuentra nada y se apaga solo. La comprobación de
  // unidades va igual, porque sus radios están tabulados en km → AU.
  const oblate = integrating && solarUnits && (spec.oblateness ?? true)
    ? oblateBodies(bodies)
    : undefined

  return {
    bodies,
    relativistic,
    oblate: oblate?.length ? oblate : undefined,
    collisionRadii: integrating && spec.collisions ? collisionRadii(bodies) : undefined,
    rows: spec.bodies?.length ? undefined : base?.rows,
    G,
    mode,
    softening: spec.softening ?? base?.softening ?? 0,
    startDate: date,
    viewScale: spec.viewScale ?? 7 / span,
    radial,
    radialK,
    dt: spec.dt ?? base?.dt ?? 0.01,
    timeScale: spec.timeScale ?? base?.timeScale ?? 1,
    trail: spec.trail === false ? 0 : (spec.trail ?? base?.trail ?? 400),
    showOrbits: spec.showOrbits ?? base?.showOrbits ?? false,
    title: base?.title,
  }
}
