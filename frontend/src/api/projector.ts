import { getApiBase } from './client'
import { tauriInvoke } from '../platform/tauri'

/** Workspace del portátil (comportamiento de siempre) y el de la pared. */
const LAPTOP_WS = '1'
const WALL_WS = 'name:proj'

/** ¿Está el proyector encendido AHORA? `powered` = contesta en la red. */
async function projectorPowered(): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/api/skills/projector/status`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data?.powered)
  } catch {
    return false
  }
}

/** Manda la ventana de Jarvis al workspace indicado y la muestra. */
function placeWindow(workspace: string) {
  return tauriInvoke('focus_window', { workspace })
}

/**
 * Despierta Jarvis en la pantalla donde SE PUEDA VER, y enciende la pared.
 *
 * Jarvis vive en la salida headless `projmap` que Sunshine emite al proyector.
 * Esa salida existe siempre, encendido o no — así que mandar la ventana allí con
 * el proyector apagado la volvía invisible en los DOS sitios (ni pared, ni
 * portátil) y encima mataba el aplauso, porque el detector de `DormantLayer`
 * solo escucha en DORMANT y la UI se quedaba AWAKE en el limbo.
 *
 * Por eso decide en caliente:
 *  - proyector encendido → a la pared, el portátil queda libre
 *  - proyector apagado   → al portátil, como antes, y se dispara el encendido;
 *    cuando la pared está lista (~50 s de arranque en frío) la ventana se muda
 *    sola, sin que el usuario tenga que volver a aplaudir.
 *
 * `on` es idempotente en el backend (sondea la red antes de pulsar), así que
 * repetirlo con el proyector encendido NO manda el pulso IR — que al ser un
 * toggle lo apagaría.
 */
export async function wakeOnBestScreen(): Promise<void> {
  const powered = await projectorPowered()
  await placeWindow(powered ? WALL_WS : LAPTOP_WS)
  if (powered) return

  // Encendido en segundo plano: el aplauso no puede esperar 50 s.
  fetch(`${getApiBase()}/api/skills/projector/on`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(180_000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d?.ok) placeWindow(WALL_WS) })
    .catch(() => { /* sin proyector configurado, Jarvis se queda en el portátil */ })
}

/** Workspace donde está Jarvis ahora, para que el sleep sepa si esconderla. */
export async function currentWorkspace(): Promise<string> {
  return (await projectorPowered()) ? WALL_WS : LAPTOP_WS
}
