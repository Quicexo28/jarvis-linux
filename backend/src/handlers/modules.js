import { json } from '../lib/http.js'

export function handleModules(_req, res) {
  return json(res, 200, { modules: ['tv', 'cloud', 'system', 'jarvis-turn', 'telemetry'] })
}
