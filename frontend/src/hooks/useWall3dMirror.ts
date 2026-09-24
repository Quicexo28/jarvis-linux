import { useEffect, useState } from 'react'
import { tauriEmit, tauriInvoke, tauriListen } from '../platform/tauri'
import { useModel3dStore } from '../state/model3dStore'
import { useSimStore } from '../state/simStore'
import { WALL_EVENT, WALL_READY_EVENT, WALL_SIM_EVENT } from '../WallPage'
import { getApiBase } from '../api/client'

const WALL_WS = 'name:proj'

/** Cuánto vale una lectura de `powered` antes de volver a preguntar. */
const POWERED_TTL_MS = 15_000
/** Cada cuánto se refresca en segundo plano mientras la app vive. */
const POWERED_POLL_MS = 10_000

/**
 * Estado del proyector CACHEADO — y no es una optimización, es corrección.
 *
 * Decidir con un `await` dejaba a la ventana principal montando su visor durante
 * el viaje de ida y vuelta, así que se creaban DOS contextos WebGL casi a la vez
 * (el del portátil y el de la pared). WebKitGTK sobre esta iGPU mata uno de los
 * dos: en el journal aparece `THREE.WebGLRenderer: Context Lost.` y quien perdía
 * la carrera se quedaba en negro — a veces la pared (gráfico invisible), a veces
 * el portátil. Con el valor ya en mano la decisión es SÍNCRONA y solo se crea un
 * contexto.
 */
let poweredCache = { value: false, at: 0 }
let poweredInflight: Promise<boolean> | null = null

/** ¿Está el proyector encendido? `powered` = contesta en la red. */
function refreshPowered(): Promise<boolean> {
  if (poweredInflight) return poweredInflight
  poweredInflight = (async () => {
    let value = false
    try {
      const res = await fetch(`${getApiBase()}/api/skills/projector/status`, {
        signal: AbortSignal.timeout(4000),
      })
      value = res.ok ? Boolean((await res.json())?.powered) : false
    } catch {
      value = false
    }
    poweredCache = { value, at: Date.now() }
    poweredInflight = null
    return value
  })()
  return poweredInflight
}

/** Valor fresco, o `null` si toca preguntar. */
function poweredCached(): boolean | null {
  return Date.now() - poweredCache.at < POWERED_TTL_MS ? poweredCache.value : null
}

/**
 * Quién dibuja el 3D ahora mismo.
 *
 * `pending` existe porque «todavía no sé» NO es lo mismo que «lo pinta el
 * portátil»: mientras se resuelve, la principal no puede montar su visor o se
 * crean dos contextos WebGL (ver `poweredCache`).
 */
export type Wall3dOwner = 'main' | 'wall' | 'pending'

/**
 * Manda el visor 3D a la pared cuando el proyector está encendido.
 *
 * Devuelve quién es el dueño del gráfico: `wall` mientras se proyecta (la
 * principal NO lo pinta también — la idea es que el portátil quede libre, no que
 * el 3D salga duplicado), `main` con el proyector apagado, y `pending` mientras
 * no se sepa.
 */
export function useWall3dMirror(): Wall3dOwner {
  const [owner, setOwner] = useState<Wall3dOwner>('main')

  useEffect(() => {
    let alive = true

    function apply(powered: boolean, open: boolean, objects: unknown[], scene: unknown) {
      if (!alive) return
      // El contenido se manda SIEMPRE que la pared esté activa; así un `add_3d`
      // sobre un gráfico ya proyectado se refleja sin reabrir la ventana.
      if (powered) tauriEmit(WALL_EVENT, { open, objects, scene })
      // Y si NO está encendido hay que decírselo: la pared conserva su contexto
      // WebGL mientras crea que sigue abierta, así que apagar el proyector sin
      // este aviso dejaba DOS contextos (pared oculta + portátil) y esta iGPU
      // mata uno de los dos (`THREE.WebGLRenderer: Context Lost.`).
      else tauriEmit(WALL_EVENT, { open: false, objects: [], scene: {} })
      tauriInvoke('set_wall', { visible: open && powered, workspace: WALL_WS })
      setOwner(open && powered ? 'wall' : 'main')
    }

    function sync(open: boolean, objects: unknown[], scene: unknown) {
      if (!open) { apply(false, open, objects, scene); return }
      const cached = poweredCached()
      // Camino normal: se decide en el acto, en el mismo commit de React que
      // monta el visor, así que la principal ni llega a crear su contexto WebGL.
      if (cached !== null) { apply(cached, open, objects, scene); return }
      // Sin dato fresco NADIE pinta hasta saberlo. Devolver `main` aquí (lo que
      // hacía la versión anterior) montaba el visor del portátil durante el
      // viaje a la red y lo mataba la carrera de contextos contra la pared.
      setOwner('pending')
      refreshPowered().then((v) => apply(v, open, objects, scene))
    }

    /** El transporte de la simulación viaja aparte del contenido. */
    function pushSim() {
      const sim = useSimStore.getState()
      tauriEmit(WALL_SIM_EVENT, {
        playing: sim.playing, speed: sim.speed, resetToken: sim.resetToken,
      })
    }

    // La ventana de la pared avisa cuando ya escucha; se le manda el estado
    // actual, que es el que se perdio al mostrarla.
    let unlisten: (() => void) | undefined
    tauriListen(WALL_READY_EVENT, () => {
      const st = useModel3dStore.getState()
      // El estado se manda SOLO si el proyector está encendido. La pared crea su
      // contexto WebGL en cuanto recibe contenido, así que contestarle con el
      // proyector apagado le hace montar un visor invisible que le roba el
      // contexto al del portátil.
      const push = (powered: boolean) => {
        if (!alive || !powered) return
        tauriEmit(WALL_EVENT, { open: st.open, objects: st.objects, scene: st.scene })
        pushSim()
      }
      const cached = poweredCached()
      if (cached !== null) push(cached)
      else refreshPowered().then(push)
    }).then((fn) => { unlisten = fn })

    // Sondeo de fondo: mantiene la caché caliente para que la apertura NUNCA
    // tenga que esperar a la red. El proyector se enciende y se apaga por
    // debajo, así que seguir preguntando es lo que evita mandar el gráfico a la
    // pantalla equivocada.
    refreshPowered()
    const poll = setInterval(refreshPowered, POWERED_POLL_MS)

    const s = useModel3dStore.getState()
    sync(s.open, s.objects, s.scene)

    const unsub = useModel3dStore.subscribe((st) => { sync(st.open, st.objects, st.scene) })
    // Con el visor proyectado, la simulación corre en el WebProcess de la pared
    // y su simStore es OTRO. Sin este espejo, `sim_control` (que aterriza en el
    // bus de skills de esta ventana) pausaría un store que nadie está leyendo.
    const unsubSim = useSimStore.subscribe(pushSim)
    return () => { alive = false; clearInterval(poll); unlisten?.(); unsub(); unsubSim() }
  }, [])

  useEffect(() => () => { tauriInvoke('set_wall', { visible: false }) }, [])

  return owner
}
