import type { Role } from './theme'

/** Rol de color del estado de los gestos: apagado, error, activo o arrancando. */
export function gestureTone(enabled: boolean, status: string): Role {
  if (!enabled) return 'idle'
  if (status === 'error') return 'fail'
  return status === 'running' ? 'ok' : 'attn'
}
