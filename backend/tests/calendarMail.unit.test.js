import { describe, it, expect } from 'vitest'
import { parseIcs, parseIcsDate, occurrences, zonedToUtc, startOfLocalDay } from '../src/lib/calendar.js'
import { searchCriteria, textPart, htmlToText } from '../src/lib/mail.js'

const BOG = 'America/Bogota' // UTC-5, no DST
const iso = (s) => new Date(s).getTime()
const ics = (...events) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']),
  'END:VCALENDAR',
].join('\r\n')
const window = (fromIso, days) => [iso(fromIso), iso(fromIso) + days * 86400e3]
const titlesAt = (doc, fromIso, days) =>
  occurrences(parseIcs(doc), ...window(fromIso, days)).map((e) => `${e.start} ${e.title}`)

describe('dates and zones', () => {
  it('TZID wall time → UTC', () => {
    const d = parseIcsDate('20261005T090000', { TZID: BOG })
    expect(new Date(d.utc).toISOString()).toBe('2026-10-05T14:00:00.000Z')
  })
  it('Z means UTC, regardless of the fallback zone', () => {
    expect(new Date(parseIcsDate('20261005T090000Z').utc).toISOString()).toBe('2026-10-05T09:00:00.000Z')
  })
  it('all-day dates are the owner\'s calendar day, not UTC midnight', () => {
    const d = parseIcsDate('20261005', { VALUE: 'DATE' })
    expect(d.allDay).toBe(true)
    expect(new Date(d.utc).toISOString()).toBe('2026-10-05T05:00:00.000Z')
  })
  it('Windows zone names (Outlook feeds) are mapped', () => {
    const d = parseIcsDate('20261005T090000', { TZID: 'SA Pacific Standard Time' })
    expect(new Date(d.utc).toISOString()).toBe('2026-10-05T14:00:00.000Z')
  })
  it('a DST zone keeps wall time across the change', () => {
    const before = zonedToUtc(2026, 3, 7, 9, 0, 0, 'America/New_York') // EST, UTC-5
    const after = zonedToUtc(2026, 3, 9, 9, 0, 0, 'America/New_York')  // EDT, UTC-4
    expect(new Date(before).toISOString()).toBe('2026-03-07T14:00:00.000Z')
    expect(new Date(after).toISOString()).toBe('2026-03-09T13:00:00.000Z')
  })
  it('start of the local day', () => {
    expect(new Date(startOfLocalDay(iso('2026-10-05T03:00:00Z'))).toISOString()).toBe('2026-10-04T05:00:00.000Z')
  })
})

describe('parsing', () => {
  it('unfolds lines and unescapes text', () => {
    const doc = ics([
      'UID:1', 'DTSTART;TZID=America/Bogota:20261005T090000', 'DTEND;TZID=America/Bogota:20261005T100000',
      'SUMMARY:Reunión de física\\, sala', ' 2', 'LOCATION:Bloque 7',
    ])
    const [e] = parseIcs(doc)
    expect(e.title).toBe('Reunión de física, sala2')
    expect(e.location).toBe('Bloque 7')
  })
  it('quoted params with colons do not break the value split', () => {
    const doc = ics(['UID:1', 'DTSTART;TZID="America/Bogota":20261005T090000', 'SUMMARY:x'])
    expect(new Date(parseIcs(doc)[0].start.utc).toISOString()).toBe('2026-10-05T14:00:00.000Z')
  })
})

describe('occurrences', () => {
  it('single event in and out of the window, cancelled ones dropped', () => {
    const doc = ics(
      ['UID:a', 'DTSTART:20261005T140000Z', 'DTEND:20261005T150000Z', 'SUMMARY:Dentro'],
      ['UID:b', 'DTSTART:20261007T140000Z', 'SUMMARY:Fuera'],
      ['UID:c', 'DTSTART:20261005T160000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelado'],
    )
    expect(titlesAt(doc, '2026-10-05T05:00:00Z', 1)).toEqual(['2026-10-05T14:00:00.000Z Dentro'])
  })

  it('an event already in progress at the window start counts', () => {
    const doc = ics(['UID:a', 'DTSTART:20261005T040000Z', 'DTEND:20261005T070000Z', 'SUMMARY:Noche'])
    expect(titlesAt(doc, '2026-10-05T05:00:00Z', 1)).toHaveLength(1)
  })

  it('weekly BYDAY with EXDATE', () => {
    const doc = ics([
      'UID:w', 'DTSTART;TZID=America/Bogota:20261005T070000', 'DTEND;TZID=America/Bogota:20261005T080000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=America/Bogota:20261007T070000', 'SUMMARY:Gym',
    ])
    expect(titlesAt(doc, '2026-10-05T05:00:00Z', 10)).toEqual([
      '2026-10-05T12:00:00.000Z Gym', // lun 5
      // mié 7 excluido
      '2026-10-12T12:00:00.000Z Gym', // lun 12
      '2026-10-14T12:00:00.000Z Gym', // mié 14
    ])
  })

  it('monthly nth weekday and COUNT', () => {
    const doc = ics([
      'UID:m', 'DTSTART;TZID=America/Bogota:20261006T180000', 'RRULE:FREQ=MONTHLY;BYDAY=1TU;COUNT=2', 'SUMMARY:Club',
    ])
    expect(titlesAt(doc, '2026-10-01T05:00:00Z', 120)).toEqual([
      '2026-10-06T23:00:00.000Z Club',
      '2026-11-03T23:00:00.000Z Club',
    ])
  })

  it('last weekday of the month (-1FR)', () => {
    const doc = ics(['UID:l', 'DTSTART:20261030T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:Cierre'])
    expect(titlesAt(doc, '2026-11-01T05:00:00Z', 30)).toEqual(['2026-11-27T15:00:00.000Z Cierre'])
  })

  it('UNTIL stops the series', () => {
    const doc = ics(['UID:u', 'DTSTART:20261005T140000Z', 'RRULE:FREQ=DAILY;UNTIL=20261007T140000Z', 'SUMMARY:D'])
    expect(titlesAt(doc, '2026-10-05T00:00:00Z', 10)).toHaveLength(3)
  })

  it('a daily series started years ago still reaches today (fast-forward)', () => {
    const doc = ics(['UID:old', 'DTSTART;TZID=America/Bogota:20150101T060000', 'RRULE:FREQ=DAILY', 'SUMMARY:Medicina'])
    expect(titlesAt(doc, '2026-10-05T05:00:00Z', 1)).toEqual(['2026-10-05T11:00:00.000Z Medicina'])
  })

  it('a RECURRENCE-ID override replaces its instance', () => {
    const doc = ics(
      ['UID:r', 'DTSTART:20261005T140000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Clase'],
      ['UID:r', 'RECURRENCE-ID:20261006T140000Z', 'DTSTART:20261006T190000Z', 'SUMMARY:Clase (movida)'],
    )
    expect(titlesAt(doc, '2026-10-05T00:00:00Z', 5)).toEqual([
      '2026-10-05T14:00:00.000Z Clase',
      '2026-10-06T19:00:00.000Z Clase (movida)',
      '2026-10-07T14:00:00.000Z Clase',
    ])
  })

  it('all-day events cover the owner\'s whole day', () => {
    const doc = ics(['UID:ad', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'SUMMARY:Festivo'])
    const [e] = occurrences(parseIcs(doc), ...window('2026-10-05T05:00:00Z', 1))
    expect(e.allDay).toBe(true)
    expect(e.title).toBe('Festivo')
  })
})

describe('mail helpers', () => {
  it('unread default criteria and free-text search', () => {
    expect(searchCriteria({ unread: true })).toEqual({ seen: false })
    expect(searchCriteria({})).toEqual({ all: true })
    const c = searchCriteria({ query: 'factura', sinceDays: 2 }, iso('2026-10-05T00:00:00Z'))
    expect(c.or).toHaveLength(3)
    expect(c.since.toISOString()).toBe('2026-10-03T00:00:00.000Z')
  })

  it('prefers text/plain, falls back to html, skips attachments', () => {
    const tree = {
      type: 'multipart/mixed', childNodes: [
        { type: 'multipart/alternative', childNodes: [
          { type: 'text/plain', part: '1.1' },
          { type: 'text/html', part: '1.2' },
        ] },
        { type: 'text/plain', part: '2', disposition: 'attachment' },
      ],
    }
    expect(textPart(tree)).toEqual({ part: '1.1', html: false })
    expect(textPart({ type: 'multipart/alternative', childNodes: [{ type: 'text/html', part: '1' }] }))
      .toEqual({ part: '1', html: true })
    expect(textPart({ type: 'image/png', part: '1' })).toBeNull()
  })

  it('html to text drops tags, scripts and entities', () => {
    expect(htmlToText('<style>p{}</style><p>Hola&nbsp;<b>señor</b></p><p>Factura &amp; recibo</p>'))
      .toBe('Hola señor\nFactura & recibo')
  })
})
