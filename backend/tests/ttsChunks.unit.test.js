import { describe, it, expect } from 'vitest'
import { splitForTts } from '../src/lib/ttsChunks.js'

// Real replies from the 2026-09-24 turns whose long sentences stalled edge-tts.
const SAMSUNG = 'Samsung presentó en FMS dos mil veintiséis una arquitectura revolucionaria: zHBM, que apila verticalmente la memoria HBM directamente sobre los aceleradores de inteligencia artificial.'
const DDR6 = 'Puedo profundizar en DDR6 — velocidades, arquitectura, impacto en inteligencia artificial — o buscar si hay otros avances que no haya mencionado.'

describe('splitForTts', () => {
  it('leaves short sentences untouched', () => {
    expect(splitForTts('Eso es, señor.')).toEqual(['Eso es, señor.'])
    expect(splitForTts('')).toEqual([])
  })

  it('splits long sentences into clauses without losing text', () => {
    for (const s of [SAMSUNG, DDR6]) {
      const parts = splitForTts(s)
      expect(parts.length).toBeGreaterThan(1)
      expect(parts.join(' ')).toBe(s)
      for (const p of parts) expect(p.length).toBeGreaterThanOrEqual(30)
    }
  })

  it('keeps decimal commas and times intact', () => {
    const s = 'La memoria subió uno,5 veces y el 1,5 por ciento se vio a las 9:30 de la mañana en el mercado asiático y europeo sin pausa alguna para nadie.'
    expect(splitForTts(s).join(' ')).toBe(s)
    expect(splitForTts(s).some(p => p.includes('1,5'))).toBe(true)
    expect(splitForTts(s).some(p => p.includes('9:30'))).toBe(true)
  })

  it('does not split long text with no clause punctuation', () => {
    const s = 'a'.repeat(50) + ' ' + 'b'.repeat(60)
    expect(splitForTts(s)).toEqual([s])
  })
})
