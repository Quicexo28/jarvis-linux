// One-time registration of the agent capability surface. Idempotent so it is
// safe to call from React effects and from the router/bridge defensively.
import { registerCapabilities, listCapabilities } from './registry'
import { navigationCapabilities } from './capabilities/navigation'
import { timerCapabilities } from './capabilities/timer'

let initialized = false

export function setupAgent(): void {
  if (initialized) return
  registerCapabilities([...navigationCapabilities, ...timerCapabilities])
  initialized = true
}

export function isAgentReady(): boolean {
  return initialized && listCapabilities().length > 0
}

export { routeUtterance } from './router'
export { sendTurnToBrain } from './bridge'
