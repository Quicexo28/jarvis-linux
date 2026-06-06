import { json } from '../lib/http.js'

export function handleHealth(_req, res) {
  return json(res, 200, { status: 'ok', service: 'jarvis-backend' })
}
