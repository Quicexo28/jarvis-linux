import { json } from '../lib/http.js'
import { weather } from '../lib/weather.js'

/**
 * GET /api/skills/weather?place=&days= — current weather + forecast (Open-Meteo).
 * Read-only: classified READ in toolRisk.
 */
export async function handleWeather(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams
  try {
    const r = await weather({ place: q.get('place') || '', days: Number(q.get('days') || 1) })
    const status = r.ok ? 200 : r.error === 'place_not_found' ? 404 : 400
    return json(res, status, r)
  } catch (e) {
    return json(res, 502, { ok: false, error: 'weather_unavailable', detail: String(e?.message || e) })
  }
}
