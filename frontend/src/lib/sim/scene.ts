/**
 * scene.ts — qué ILUMINACIÓN y qué FONDO pide la escena 3D.
 *
 * El visor tiene dos estéticas incompatibles y hay que elegir una por escena:
 *
 *  - **Holográfica** (la de siempre): ambiente cyan + dos pointLights
 *    decorativas. Es la correcta para las figuras abstractas —parametric,
 *    polytope, curve, vectors...—, que son diagramas, no objetos.
 *  - **Física**: la luz la pone la ESTRELLA desde dentro de la simulación y el
 *    fondo es el cielo real. El ambiente cyan tiñe de azul todo lo que toca
 *    (un Marte rojo sale malva, la Luna gris sale celeste), así que un sistema
 *    solar realista no puede convivir con él.
 *
 * Esto es la decisión, y nada más: lógica pura, Three-free y testeable en Node,
 * misma disciplina que el resto de `lib/sim/`. Quien monta luces y fondo es
 * `Model3DViewer`.
 */

/** Lo MÍNIMO que hace falta saber de un objeto de la escena para decidir el
 *  look. Deliberadamente estructural (y no `Model3DSpec`) para que este módulo
 *  no dependa del store del frontend y siga siendo testeable a pelo. */
export interface SceneLookSpec {
  kind: string
  /** Solo en `kind: 'simulation'`. */
  system?: string
  /** `SimCommon.realistic` — default true. */
  realistic?: boolean
  /** `SimCommon.starfield` — default: lo que valga `realistic`. */
  starfield?: boolean
}

/** Sistemas que TRAEN SU PROPIA LUZ y por tanto no necesitan relleno:
 *  - `nbody` monta una pointLight en la primaria (la estrella).
 *  - `blackhole` se dibuja entero con materiales `basic`, que ignoran las luces.
 *  Los demás (`dynamics`, `field`, `ode`) pintan sus cuerpos con
 *  `meshStandardMaterial` y NADIE les pone una luz: si les quitamos el ambiente
 *  cyan sin devolverles nada, sus partículas quedan negras. */
export const SELF_LIT_SYSTEMS: ReadonlySet<string> = new Set(['nbody', 'blackhole'])

export interface SceneLook {
  /** Fuera el ambiente cyan y las pointLights decorativas; tone mapping ACES. */
  realistic: boolean
  /** Fondo equirectangular de la Vía Láctea en lugar del color plano. */
  starfield: boolean
  /** Hace falta una luz neutra de relleno porque ninguna simulación realista
   *  de la escena aporta la suya. Siempre `false` fuera del modo realista: en
   *  holográfico ya están las luces de siempre. */
  keyLight: boolean
}

const HOLOGRAPHIC: SceneLook = { realistic: false, starfield: false, keyLight: false }

/** ¿Es una simulación que pide look realista? `realistic` default TRUE: un
 *  sistema solar de esferas planas bajo luz cyan no se parece a nada. */
function isRealisticSim(o: SceneLookSpec): boolean {
  return o.kind === 'simulation' && o.realistic !== false
}

/**
 * Decide el look de la escena a partir de sus objetos.
 *
 * La condición es ESTRICTA: basta —y hace falta— una simulación con look
 * realista. Si la escena MEZCLA una simulación realista con figuras abstractas
 * gana el realista: una figura holográfica bajo luz física sigue leyéndose
 * (pierde el tinte cyan), mientras que un planeta bajo ambiente cyan no vuelve
 * a ser un planeta. Es la mezcla la que es rara, no la regla.
 */
export function resolveSceneLook(objects: readonly SceneLookSpec[] | null | undefined): SceneLook {
  if (!objects || objects.length === 0) return HOLOGRAPHIC

  let realistic = false
  let starfield = false
  let selfLit = false

  for (const o of objects) {
    if (!isRealisticSim(o)) continue
    realistic = true
    // `starfield` default = `realistic`, o sea true aquí. Con varias sims basta
    // que UNA quiera estrellas: el fondo es uno solo y quitarlo por la más
    // austera dejaría a la otra flotando en negro plano.
    if (o.starfield !== false) starfield = true
    if (o.system !== undefined && SELF_LIT_SYSTEMS.has(o.system)) selfLit = true
  }

  if (!realistic) return HOLOGRAPHIC
  return { realistic: true, starfield, keyLight: !selfLit }
}
