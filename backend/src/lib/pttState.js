/**
 * Push-to-talk state. Set by POST /api/jarvis/ptt/start|stop (e.g. global
 * Hyprland binds) so turns arriving while the key is held bypass the
 * attention/speaker gates — a physical key press on the host is explicit
 * owner intent. Auto-expires in case a release event is lost.
 */

const PTT_MAX_HOLD_MS = 30000

let active = false
let changedAt = 0

export function setPttActive(v) {
  active = Boolean(v)
  changedAt = Date.now()
}

export function isPttActive() {
  if (active && Date.now() - changedAt > PTT_MAX_HOLD_MS) active = false
  return active
}
