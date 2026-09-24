import { useEffect, useState } from 'react'
import { tauriListen, tauriEmit } from './platform/tauri'
import { useModel3dStore } from './state/model3dStore'
import { useSimStore } from './state/simStore'
import { Model3DViewer, Model3DErrorBoundary } from './components/Model3DViewer'

/** Estado del visor que viaja entre ventanas. */
export interface WallPayload {
  open: boolean
  objects: unknown[]
  scene: Record<string, unknown>
}

export const WALL_EVENT = 'jarvis:wall3d'
/**
 * Transporte de la simulación (play/pausa/velocidad/reinicio).
 *
 * Va en su PROPIO evento y no dentro de `WallPayload` a propósito: el payload
 * del visor reemplaza `objects`, y aplicar eso para pausar reconstruiría la
 * escena — o sea reiniciaría la física, que es lo contrario de pausar. Aquí solo
 * viajan tres escalares.
 */
export const WALL_SIM_EVENT = 'jarvis:wall3d:sim'

export interface WallSimPayload {
  playing: boolean
  speed: number
  resetToken: number
}
/**
 * Saludo de esta ventana al montarse.
 *
 * La principal emite el estado en el mismo instante en que manda mostrar la
 * ventana, cuando su listener todavia no existe — el primer evento SIEMPRE se
 * perdia y la pared se quedaba en negro sin ningun error. Con el saludo, quien
 * llega tarde pide el estado en vez de esperar al siguiente cambio.
 */
export const WALL_READY_EVENT = 'jarvis:wall3d:ready'

/**
 * La pared: solo el visor 3D, a pantalla completa en el proyector.
 *
 * Vive en su propia `WebviewWindow` (label `wall`) para que Jarvis pueda
 * quedarse en el portátil mientras el gráfico se proyecta — que es justo lo que
 * convierte la pared en una segunda pantalla y no en un espejo.
 *
 * Cada ventana de Tauri es un contexto JS aparte, así que **los stores de
 * zustand NO se comparten**: la principal emite `jarvis:wall3d` con el estado
 * del `model3dStore` y aquí se aplica tal cual. Es un espejo de solo lectura;
 * nada de esta ventana escribe hacia atrás.
 */
export function WallPage() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    tauriListen<WallPayload>(WALL_EVENT, (e) => {
      const p = e.payload
      if (!p) return
      useModel3dStore.setState({
        open: Boolean(p.open),
        // El payload cruza el puente serializado; los tipos ya los validó quien
        // emite (el store de la ventana principal).
        objects: (p.objects ?? []) as never,
        scene: (p.scene ?? {}) as never,
      })
      setReady(true)
    }).then((fn) => {
      unlisten = fn
      // El listener ya esta puesto: ahora sí se puede pedir el estado.
      tauriEmit(WALL_READY_EVENT)
      console.log('[wall] listo, estado solicitado')
    })
    let unlistenSim: (() => void) | undefined
    tauriListen<WallSimPayload>(WALL_SIM_EVENT, (e) => {
      const p = e.payload
      if (!p) return
      useSimStore.setState({
        playing: Boolean(p.playing),
        speed: Number(p.speed) || 1,
        resetToken: Number(p.resetToken) || 0,
      })
    }).then((fn) => { unlistenSim = fn })

    return () => { unlisten?.(); unlistenSim?.() }
  }, [])

  const open = useModel3dStore((s) => s.open)

  // Fondo opaco siempre: esta ventana se captura y se emite por Sunshine, y un
  // fondo transparente deja ver lo que haya debajo en ese monitor.
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden' }}>
      {/* Red de seguridad de la pared: aquí no hay nadie mirando una consola,
          así que un error que escape del visor tiene que dejar negro (fondo) y
          no blanco (árbol de React caído). */}
      {open && ready ? (
        <Model3DErrorBoundary><Model3DViewer /></Model3DErrorBoundary>
      ) : null}
    </div>
  )
}
