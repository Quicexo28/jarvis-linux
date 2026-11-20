import { tauriInvoke } from '../platform/tauri'

/** Workspace del portátil: Jarvis vive aquí siempre (ver `wakeOnBestScreen`). */
const LAPTOP_WS = '1'

/** Manda la ventana de Jarvis al workspace indicado y la muestra. */
function placeWindow(workspace: string) {
  return tauriInvoke('focus_window', { workspace })
}

/**
 * Despierta Jarvis en el portátil. Siempre, y sin tocar el proyector.
 *
 * Antes lo mandaba a la pared (salida headless `projmap`, workspace
 * `name:proj`) si el proyector estaba encendido y, si no, disparaba el
 * encendido para mudar la ventana allí al arrancar. Se quitó: en la pared no se
 * usaba, y `projmap` es ahora la superficie de casting de `wall-server` (la
 * pestaña «Pared» de la app remota manda allí ventanas y escritorio), así que
 * una ventana de Jarvis en ese workspace saldría emitida en lugar de lo que el
 * usuario eligió. Encender el proyector queda para la app y las tools
 * `projector_*`.
 */
export async function wakeOnBestScreen(): Promise<void> {
  await placeWindow(LAPTOP_WS)
}

/** Workspace donde está Jarvis ahora, para que el sleep sepa si esconderla. */
export async function currentWorkspace(): Promise<string> {
  return LAPTOP_WS
}
