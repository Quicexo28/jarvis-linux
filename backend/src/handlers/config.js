import { json } from '../lib/http.js'

export function handleSystemConfig(_req, res) {
  const telemetryEnabled = process['env'].JARVIS_TELEMETRY_ENABLED === 'true'
  return json(res, 200, { ok: true, telemetryEnabled })
}
