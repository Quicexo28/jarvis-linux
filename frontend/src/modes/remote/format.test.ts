import { describe, expect, it } from 'vitest'
import { uptime, mb, pct, ago, baseName, batteryPct, httpsUrl } from './format'

describe('uptime', () => {
  it('shows days and hours past a day', () => {
    expect(uptime(128312)).toBe('1d 11h')
  })
  it('shows hours and minutes under a day', () => {
    expect(uptime(3 * 3600 + 25 * 60)).toBe('3h 25m')
  })
  it('shows minutes under an hour', () => {
    expect(uptime(305)).toBe('5m')
  })
  it('degrades on garbage', () => {
    expect(uptime(NaN)).toBe('—')
    expect(uptime(-1)).toBe('—')
  })
})

describe('mb', () => {
  it('keeps MB below a gigabyte', () => {
    expect(mb(512)).toBe('512 MB')
  })
  it('switches to GB above 1024', () => {
    expect(mb(12_698)).toBe('12.4 GB')
  })
})

describe('pct', () => {
  it('computes a percentage', () => {
    expect(pct(50, 200)).toBe(25)
  })
  it('never divides by zero', () => {
    expect(pct(5, 0)).toBe(0)
  })
  it('clamps out-of-range input', () => {
    expect(pct(300, 100)).toBe(100)
  })
})

describe('batteryPct', () => {
  it('keeps APK values that are already percentages', () => {
    expect(batteryPct(87)).toBe(87)
    expect(batteryPct(100)).toBe(100)
  })
  it('scales the 0-1 fractions Shortcuts and the web API post', () => {
    expect(batteryPct(0.14)).toBe(14)
    expect(batteryPct(1)).toBe(100)
  })
  it('degrades on garbage', () => {
    expect(batteryPct(NaN)).toBe(0)
  })
})

describe('ago', () => {
  const now = Date.parse('2026-08-06T12:00:00Z')
  it('says ahora under a minute', () => {
    expect(ago('2026-08-06T11:59:30Z', now)).toBe('ahora')
  })
  it('counts minutes and hours', () => {
    expect(ago('2026-08-06T11:40:00Z', now)).toBe('hace 20 min')
    expect(ago('2026-08-06T09:00:00Z', now)).toBe('hace 3 h')
  })
  it('falls back on missing timestamps', () => {
    expect(ago(null, now)).toBe('—')
    expect(ago('not-a-date', now)).toBe('—')
  })
})

describe('baseName', () => {
  it('handles Windows paths', () => {
    expect(baseName('C:\\Users\\santi\\informe.pdf')).toBe('informe.pdf')
  })
  it('handles POSIX paths', () => {
    expect(baseName('/home/santi/informe.pdf')).toBe('informe.pdf')
  })
})

describe('httpsUrl', () => {
  it('acepta https y completa el esquema si falta', () => {
    expect(httpsUrl('https://www.netflix.com/browse')).toBe('https://www.netflix.com/browse')
    expect(httpsUrl('  netflix.com ')).toBe('https://netflix.com/')
    expect(httpsUrl('youtube.com/tv')).toBe('https://youtube.com/tv')
    expect(httpsUrl('192.168.1.29:8443/x')).toBe('https://192.168.1.29:8443/x')
  })
  it('rechaza cualquier otro esquema', () => {
    expect(httpsUrl('http://netflix.com')).toBeNull()
    expect(httpsUrl('javascript:alert(1)')).toBeNull()
    expect(httpsUrl('file:///etc/passwd')).toBeNull()
    expect(httpsUrl('data:text/html,hola')).toBeNull()
    expect(httpsUrl('chrome://settings')).toBeNull()
  })
  it('rechaza basura, credenciales y hosts sin punto', () => {
    expect(httpsUrl('')).toBeNull()
    expect(httpsUrl('   ')).toBeNull()
    expect(httpsUrl('https://')).toBeNull()
    expect(httpsUrl('https://user:pw@netflix.com')).toBeNull()
    expect(httpsUrl('netflix')).toBeNull()
    expect(httpsUrl('https://' + 'a'.repeat(2050) + '.com')).toBeNull()
  })
})
