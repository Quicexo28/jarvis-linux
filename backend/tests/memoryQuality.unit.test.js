import { describe, it, expect } from 'vitest'
import { isIdentityConfusion, findNearDuplicate } from '../src/lib/memory.js'

// Real facts from the store (2026-10-26): the extractor kept writing that the
// señor is called Jarvis, and the same fact in three to thirteen variants.
describe('isIdentityConfusion', () => {
  it.each([
    'Se llama Jarvis y trabaja como presentador.',
    'Se llama a sí mismo Jarvis',
    'Lo llaman Jarvis.',
    'Se refiere a sí mismo como Jarvis.',
    "El usuario prefiere ser llamado 'Jarvis'.",
  ])('drops «%s»', (t) => expect(isIdentityConfusion(t)).toBe(true))

  it.each([
    'Su asistente se llama Jarvis.',
    'Trabaja en un proyecto llamado Jarvis.',
    'Tiene un servicio llamado jarvis-auto-linker que está caído.',
    'Su hermana se llama Ana.',
  ])('keeps «%s»', (t) => expect(isIdentityConfusion(t)).toBe(false))
})

describe('findNearDuplicate', () => {
  const store = [
    { id: 3, text: 'Entrena todas las mañanas a las seis.' },
    { id: 73, text: 'Utiliza la técnica pomodoro para organizar su trabajo.' },
    { id: 72, text: 'Le interesan el electromagnetismo, memorias avanzadas como HBM.' },
    { id: 1, text: 'Su hermana se llama Ana.' },
  ]

  it.each([
    ['Entrena a las seis de la mañana.', 3],
    ['Usa la técnica pomodoro para organizar su trabajo.', 73],
    ['Le interesan el electromagnetismo y las memorias avanzadas.', 72],
  ])('«%s» is fact #%i again', (t, id) => expect(findNearDuplicate(t, store)?.id).toBe(id))

  it('a genuinely new fact is not a duplicate', () => {
    expect(findNearDuplicate('Su equipo de fútbol favorito es el Atlético Nacional.', store)).toBeNull()
    expect(findNearDuplicate('Tiene un perro llamado Max.', store)).toBeNull()
  })
})
