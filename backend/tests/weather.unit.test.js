import { describe, it, expect, beforeEach } from 'vitest'
import { weather, geocode, describeCode, _clearWeatherCache } from '../src/lib/weather.js'

// Open-Meteo answers are canned: the tests check place resolution, the summary
// the model speaks, and the error the model must turn into a question.
const GEO = {
  results: [
    { name: 'Cali', latitude: 39.1, longitude: -84.5, country_code: 'US', country: 'United States', admin1: 'Ohio' },
    { name: 'Cali', latitude: 3.44, longitude: -76.52, country_code: 'CO', country: 'Colombia', admin1: 'Valle del Cauca' },
  ],
}
const NOW = Date.parse('2026-10-26T12:10:00Z')  // 07:10 in Bogotá
const FORECAST = {
  utc_offset_seconds: -18000,
  current: { temperature_2m: 18.4, apparent_temperature: 17.9, relative_humidity_2m: 80, precipitation: 0, weather_code: 3, wind_speed_10m: 9 },
  hourly: {
    time: ['2026-10-26T06:00', '2026-10-26T07:00', '2026-10-26T14:00', '2026-10-26T15:00'],
    precipitation_probability: [90, 10, 70, 40],
  },
  daily: { time: ['2026-10-26', '2026-10-27'], weather_code: [61, 3], temperature_2m_max: [21.2, 22], temperature_2m_min: [9.6, 10], precipitation_probability_max: [70, 20] },
}

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url)
    const body = url.includes('geocoding') ? GEO : FORECAST
    return { ok: true, json: async () => body }
  }
}

beforeEach(() => {
  _clearWeatherCache()
  delete process.env.JARVIS_WEATHER_PLACE
})

describe('weather', () => {
  it('prefers the señor\'s country among same-name places', async () => {
    const g = await geocode('Cali', fakeFetch([]))
    expect(g).toMatchObject({ name: 'Cali, Valle del Cauca, Colombia', lat: 3.44 })
  })

  it('speaks now, today and when rain is likeliest (past hours ignored)', async () => {
    const realNow = Date.now
    Date.now = () => NOW
    try {
      const r = await weather({ place: 'Cali' }, fakeFetch([]))
      expect(r.ok).toBe(true)
      expect(r.resumen).toBe('En Cali hay 18 grados, nublado. Hoy entre 10 y 21. Probable lluvia hacia las 14:00 (70%).')
      expect(r.dias).toHaveLength(1)
      expect(r.ahora).toMatchObject({ estado: 'nublado', lloviendo: false })
    } finally {
      Date.now = realNow
    }
  })

  it('uses the configured place when none is named', async () => {
    process.env.JARVIS_WEATHER_PLACE = 'Cali'
    const calls = []
    const r = await weather({}, fakeFetch(calls))
    expect(r.fuente_lugar).toBe('configurado')
    expect(calls[0]).toContain('name=Cali')
  })

  it('asks for the city instead of guessing', async () => {
    const r = await weather({}, async () => { throw new Error('no network expected') }, () => null)
    expect(r).toMatchObject({ ok: false, error: 'place_not_configured' })
  })

  it('falls back to the phone\'s last location', async () => {
    const r = await weather({}, fakeFetch([]), () => ({ lat: 4.6, lon: -74.08, place: 'Bogotá' }))
    expect(r).toMatchObject({ ok: true, lugar: 'Bogotá', fuente_lugar: 'movil' })
  })

  it('caches a forecast for a few minutes', async () => {
    const calls = []
    await weather({ place: 'Cali' }, fakeFetch(calls))
    await weather({ place: 'Cali' }, fakeFetch(calls))
    expect(calls.filter((u) => u.includes('forecast'))).toHaveLength(1)
  })

  it('describes WMO codes in Spanish', () => {
    expect(describeCode(95)).toBe('tormenta')
    expect(describeCode(12345)).toBe('condiciones variables')
  })
})
