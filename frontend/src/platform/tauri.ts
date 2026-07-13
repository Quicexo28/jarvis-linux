/**
 * Punto único de acceso a las APIs de Tauri. Todo el frontend importa de aquí,
 * nunca de @tauri-apps/api directo.
 *
 * En navegador (modo web remoto vía Tailscale o Chromium app-mode) no hay IPC
 * de Tauri: los 7 comandos existentes son gestión de ventana/Hyprland local
 * (hide/show/focus/overlay/devtools), sin sentido remoto — degradan a no-op
 * resuelto, y los eventos (jarvis:wake/jarvis:sleep, señales de ventana) a un
 * unlisten vacío. Sin throw, sin unhandled rejection.
 */
import { invoke as nativeInvoke, isTauri as nativeIsTauri } from '@tauri-apps/api/core'
import { listen as nativeListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

export function isTauri(): boolean {
  try { return nativeIsTauri() } catch { return false }
}

/** invoke() real en Tauri; en navegador resuelve undefined (comando de ventana local). */
export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!isTauri()) return Promise.resolve(undefined)
  return nativeInvoke<T>(cmd, args)
}

/** listen() real en Tauri; en navegador resuelve un unlisten no-op. */
export function tauriListen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {})
  return nativeListen<T>(event, handler)
}

/** Label de la ventana Tauri actual, o null en navegador. */
export function getWindowLabel(): string | null {
  if (!isTauri()) return null
  try { return getCurrentWindow().label } catch { return null }
}
