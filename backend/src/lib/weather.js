/**
 * Weather from Open-Meteo — free, no API key (10k calls/day, CC-BY).
 *
 * Before this the voice brain answered "¿va a llover?" with WebSearch: ~18 s
 * and ~$0.11 a question (measured, see herramientas-de-voz.md), for the single
 * most common thing people ask an assistant. Here it is one HTTP call.
 *
 * Place, in order: what the señor named ("en Medellín"), JARVIS_WEATHER_PLACE,
 * the phone's last known location. None of them → place_not_configured, and
 * the model asks where.
 */
import { getCurrentState } from './mobileContext.js'

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const FORECAST_TTL_MS = 10 * 60e3
const geoCache = new Map()
const forecastCache = new Map()

// WMO weather interpretation codes (Open-Meteo docs), in Spanish.
const WMO = {
  0: 'despejado', 1: 'mayormente despejado', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'niebla', 48: 'niebla con escarcha',
  51: 'llovizna débil', 53: 'llovizna', 55: 'llovizna intensa', 56: 'llovizna helada', 57: 'llovizna helada intensa',
  61: 'lluvia débil', 63: 'lluvia', 65: 'lluvia fuerte', 66: 'lluvia helada', 67: 'lluvia helada fuerte',
  71: 'nevada débil', 73: 'nevada', 75: 'nevada fuerte', 77: 'granizo fino',
  80: 'chubascos débiles', 81: 'chubascos', 82: 'chubascos fuertes',
  85: 'chubascos de nieve', 86: 'chubascos de nieve fuertes',
  95: 'tormenta', 96: 'tormenta con granizo', 99: 'tormenta fuerte con granizo',
}
export const describeCode = (c) => WMO[c] ?? 'condiciones variables'

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`http_${res.status}`)
  return res.json()
}

/** First match, preferring the señor's country (JARVIS_WEATHER_COUNTRY, default CO). */
export async function geocode(place, fetchImpl = fetch) {
  const key = place.trim().toLowerCase()
  if (geoCache.has(key)) return geoCache.get(key)
  const url = `${GEO_URL}?name=${encodeURIComponent(place.trim())}&count=5&language=es&format=json`
  const data = await getJson(url, fetchImpl)
  const results = data?.results || []
  if (!results.length) return null
  const country = (process['env']['JARVIS_WEATHER_COUNTRY'] || 'CO').toUpperCase()
  const r = results.find((x) => x.country_code === country) || results[0]
  const out = {
    name: [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : null, r.country].filter(Boolean).join(', '),
    lat: r.latitude, lon: r.longitude,
  }
  geoCache.set(key, out)
  return out
}

const phoneLocation = () => getCurrentState()?.location

/** Where to look when the señor did not say. */
export async function resolvePlace(place, fetchImpl = fetch, locate = phoneLocation) {
  if (place && place.trim()) {
    const g = await geocode(place, fetchImpl)
    return g ? { ...g, source: 'pedido' } : null
  }
  const configured = process['env']['JARVIS_WEATHER_PLACE']
  if (configured && configured.trim()) {
    const g = await geocode(configured, fetchImpl)
    if (g) return { ...g, source: 'configurado' }
  }
  const loc = locate()
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    return { name: loc.place || 'su última ubicación conocida', lat: loc.lat, lon: loc.lon, source: 'movil', asOf: loc.ts || null }
  }
  return undefined  // nothing configured (null = asked for a place that does not exist)
}

/** Compact, model-friendly summary of an Open-Meteo response. */
export function summarize(place, data, days, now = Date.now()) {
  const c = data.current || {}
  const d = data.daily || {}
  const h = data.hourly || {}
  // Rain over the next 12 hours: when is it likeliest?
  const nextRain = []
  for (let i = 0; i < (h.time || []).length && nextRain.length < 12; i++) {
    if (Date.parse(h.time[i] + 'Z') + (data.utc_offset_seconds || 0) * -1000 < now - 3600e3) continue
    nextRain.push({ hora: h.time[i].slice(11, 16), prob: h.precipitation_probability?.[i] ?? null })
  }
  const peak = nextRain.reduce((a, b) => ((b.prob ?? -1) > (a?.prob ?? -1) ? b : a), null)
  const daily = (d.time || []).slice(0, days).map((date, i) => ({
    fecha: date,
    estado: describeCode(d.weather_code?.[i]),
    max: d.temperature_2m_max?.[i], min: d.temperature_2m_min?.[i],
    lluvia_prob: d.precipitation_probability_max?.[i] ?? null,
  }))
  const ahora = {
    temp: c.temperature_2m, sensacion: c.apparent_temperature, humedad: c.relative_humidity_2m,
    viento_kmh: c.wind_speed_10m, estado: describeCode(c.weather_code), lloviendo: (c.precipitation ?? 0) > 0,
  }
  const hoy = daily[0]
  const rainLine = peak && peak.prob != null
    ? (peak.prob >= 50 ? ` Probable lluvia hacia las ${peak.hora} (${peak.prob}%).` : peak.prob >= 25 ? ` Algo de probabilidad de lluvia (${peak.prob}% hacia las ${peak.hora}).` : ' Sin lluvia a la vista en las próximas horas.')
    : ''
  const spoken = `En ${place.name.split(',')[0]} hay ${Math.round(ahora.temp)} grados, ${ahora.estado}.` +
    (hoy ? ` Hoy entre ${Math.round(hoy.min)} y ${Math.round(hoy.max)}.` : '') + rainLine
  return { lugar: place.name, fuente_lugar: place.source, ahora, proximas_horas_lluvia: nextRain, dias: daily, resumen: spoken }
}

export async function weather({ place = '', days = 1 } = {}, fetchImpl = fetch, locate = phoneLocation) {
  const where = await resolvePlace(place, fetchImpl, locate)
  if (where === undefined) return { ok: false, error: 'place_not_configured', detail: 'No sé dónde está el señor: pregúntele la ciudad (o configure JARVIS_WEATHER_PLACE).' }
  if (where === null) return { ok: false, error: 'place_not_found', detail: `No encontré "${place}".` }
  const n = Math.max(1, Math.min(7, Math.round(Number(days) || 1)))
  const key = `${where.lat.toFixed(2)},${where.lon.toFixed(2)},${n}`
  const hit = forecastCache.get(key)
  let data = hit && Date.now() - hit.at < FORECAST_TTL_MS ? hit.data : null
  if (!data) {
    // ≥2 days so "the next 12 hours" still exist in the afternoon.
    const url = `${FORECAST_URL}?latitude=${where.lat}&longitude=${where.lon}&timezone=auto&forecast_days=${Math.max(n, 2)}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m' +
      '&hourly=precipitation_probability' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    data = await getJson(url, fetchImpl)
    forecastCache.set(key, { at: Date.now(), data })
  }
  return { ok: true, ...summarize(where, data, n) }
}

/** Test hook. */
export function _clearWeatherCache() { geoCache.clear(); forecastCache.clear() }
