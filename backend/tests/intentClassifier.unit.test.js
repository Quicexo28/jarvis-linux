import { describe, it, expect } from 'vitest'
import { classifyIntent } from '../src/lib/intentClassifier.js'

const ENGAGED_CTX = { state: 'ENGAGED', speakerConfidence: 1.0, alwaysOn: true }

describe('toggle_gestures intent', () => {
  it('detects "activa gestos"', () => {
    const r = classifyIntent('activa gestos', ENGAGED_CTX)
    expect(r.intentTag).toBe('toggle_gestures')
  })

  it('detects "desactiva los gestos"', () => {
    const r = classifyIntent('desactiva los gestos', ENGAGED_CTX)
    expect(r.intentTag).toBe('toggle_gestures')
  })
})

describe('voice_muted intent', () => {
  it('detects "jarvis no escuches"', () => {
    const r = classifyIntent('jarvis no escuches', ENGAGED_CTX)
    expect(r.intentTag).toBe('voice_muted')
  })

  it('detects "ignórame"', () => {
    const r = classifyIntent('ignórame', ENGAGED_CTX)
    expect(r.intentTag).toBe('voice_muted')
  })
})

// Whisper deforma "Jarvis". Observado en journald: "Garbis, está conectado a
// Spotify", "Ya lo veis", "Yardis, sí, mejora…", "Yardish, pon…", "Hola
// Yardist, lanza…", "Ya lo viste, cambia el color…", "Jackie, revisa…" — todos
// morían en el gate de wake. La familia se genera por FORMA (tier fuerte, en
// cualquier posición) y las palabras españolas reales que Whisper usa como
// homófono solo cuentan en CABEZA (tier ambiguo).
describe('wake word homophones', () => {
  const PASSIVE_CTX = { state: 'PASSIVE', speakerConfidence: 1.0, alwaysOn: false }

  const HEARD = [
    'jarvis', 'garbis', 'garvis', 'jarbis', 'harvis', 'yarvis', 'charvis',
    'llarvis', 'jervis', 'gervis', 'javis', 'javier', 'arvis',
    'yardis', 'yardish', 'yardist', 'yaris', 'jared', 'jackie',
    'ya ves', 'ya lo ves', 'ya lo veis', 'ya lo viste', 'y ahora veis',
  ]
  for (const w of HEARD) {
    it(`wakes on "${w}" from PASSIVE`, () => {
      const r = classifyIntent(`${w} está conectado a spotify`, PASSIVE_CTX)
      expect(r.reason).toBe('wake')
      expect(r.shouldRespond).toBe(true)
    })
  }

  const NOT_HEARD = [
    'yerba', 'garbo', 'jerbo', 'hervir', 'gervasio', 'jarabe', 'hierba',
    'yarda', 'jardin', 'jerez', 'jeringa', 'herida', 'gerente', 'gerardo',
  ]
  for (const w of NOT_HEARD) {
    it(`does NOT wake on "${w}"`, () => {
      const r = classifyIntent(`compre ${w} en la tienda ayer por la tarde`, PASSIVE_CTX)
      expect(r.reason).not.toBe('wake')
    })
  }

  // El tier ambiguo a media frase es habla normal, no una llamada: aceptarlo en
  // cualquier posición despertaba a Jarvis con "…que ya lo oíste".
  const MID = [
    'tal vez de su nombre que ya lo oiste',
    'le dije a javier que viniera manana por la tarde',
    'se lo conte y ya lo viste tu mismo en la pantalla',
  ]
  for (const t of MID) {
    it(`does NOT wake mid-sentence: "${t}"`, () => {
      expect(classifyIntent(t, PASSIVE_CTX).reason).not.toBe('wake')
    })
  }

  it('acepta tildes: "¿Ya lo veis? También el teclado"', () => {
    const r = classifyIntent('¿Ya lo veis? También el teclado, por favor', PASSIVE_CTX)
    expect(r.reason).toBe('wake')
  })
})
