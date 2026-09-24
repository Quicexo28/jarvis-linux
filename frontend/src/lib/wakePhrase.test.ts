import { describe, it, expect } from 'vitest'
import { hasWakePhrase, stripWakePhrase } from './wakePhrase'

// El gate del renderer corre ANTES del backend en voiceMode 'wake_word'. Todos
// estos casos salieron de journald y morían aquí: primero "Garbis"/"Ya lo veis"
// (regex v1, solo j/y/ll + arvis), luego "Yardis"/"Yardish"/"Yardist"/"Ya lo
// viste"/"Jackie"/"Jared" (regex v2, exigía v/b tras la r y solo ves/veis).
describe('hasWakePhrase — familia fuerte (en cualquier posición)', () => {
  const HEARD = [
    'jarvis', 'garbis', 'garvis', 'jarbis', 'harvis', 'yarvis', 'charvis',
    'llarvis', 'jervis', 'gervis', 'javis', 'arvis', 'despierta',
    'yardis', 'yardish', 'yardist', 'yaris', 'jarve', 'jarvi', 'yerbis',
  ]
  for (const w of HEARD) {
    it(`matches "${w}"`, () => {
      expect(hasWakePhrase(`${w}, está conectado a spotify`)).toBe(true)
    })
  }

  it('matches mid-sentence', () => {
    expect(hasWakePhrase('el alias de Jervis está bien')).toBe(true)
  })
})

describe('hasWakePhrase — palabras reales que NO deben disparar', () => {
  const NOT_HEARD = [
    'yerba', 'garbo', 'jerbo', 'hervir', 'gervasio', 'jarabe', 'hierba',
    'yarda', 'yardas', 'jardín', 'jerez', 'jeringa', 'herida', 'gerente',
    'jarras', 'gerardo', 'charles', 'garaje', 'jerarquía',
  ]
  for (const w of NOT_HEARD) {
    it(`does not match "${w}"`, () => {
      expect(hasWakePhrase(`compré ${w} en la tienda`)).toBe(false)
    })
  }
})

describe('hasWakePhrase — tier ambiguo, solo en cabeza', () => {
  const HEAD = [
    'Ya lo viste, cambia el color del setup a rojo.',
    '¿Ya lo veis? También el teclado, por favor.',
    'Ya ves, pon el setup en cien.',
    'Y ahora veis, estás conectado a Spotify.',
    'Jackie, revisa por favor el output device.',
    'Hola Jared, ¿viste que estás ahí?',
    'Javier, pon la música.',
    'Hola Yardist, lanza YouTube.',
    'No, ya lo veis, apaga la luz.',
  ]
  for (const t of HEAD) {
    it(`matches head: "${t}"`, () => expect(hasWakePhrase(t)).toBe(true))
  }

  // Mismos strings a media frase = habla normal. Aceptarlos ahí es lo que hacía
  // que "…que ya lo oíste" despertara a Jarvis.
  const MID = [
    'Tal vez de su nombre que ya lo oíste.',
    'Le dije a Javier que viniera mañana.',
    'Se lo conté y ya lo viste tú mismo.',
    'Creo que Jackie llega tarde hoy.',
  ]
  for (const t of MID) {
    it(`does not match mid-sentence: "${t}"`, () => expect(hasWakePhrase(t)).toBe(false))
  }
})

describe('stripWakePhrase', () => {
  it('quita el nombre fuerte y conserva el comando', () => {
    expect(stripWakePhrase('Garbis, está conectado a Spotify')).toBe('está conectado a Spotify')
  })

  it('quita el tier ambiguo en cabeza con su muletilla', () => {
    expect(stripWakePhrase('Ya lo viste, cambia el color del setup a rojo.'))
      .toBe('cambia el color del setup a rojo.')
  })

  it('quita signos de apertura', () => {
    expect(stripWakePhrase('¿Ya lo veis? También el teclado, por favor.'))
      .toBe('También el teclado, por favor.')
  })

  it('deja vacío cuando el enunciado es solo el nombre', () => {
    expect(stripWakePhrase('Jarvis')).toBe('')
  })
})
