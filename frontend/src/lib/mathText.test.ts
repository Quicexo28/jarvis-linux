import { describe, it, expect } from 'vitest'
import { splitMath, joinMathBlocks } from './mathText'

describe('splitMath', () => {
  it('leaves plain text alone', () => {
    expect(splitMath('sin fórmulas')).toEqual([{ kind: 'text', value: 'sin fórmulas' }])
  })

  it('splits inline and display math', () => {
    expect(splitMath('La energía $E=mc^2$ y $$F=ma$$ fin')).toEqual([
      { kind: 'text', value: 'La energía ' },
      { kind: 'inline', value: 'E=mc^2' },
      { kind: 'text', value: ' y ' },
      { kind: 'display', value: 'F=ma' },
      { kind: 'text', value: ' fin' },
    ])
  })

  it('treats an unclosed dollar as text', () => {
    expect(splitMath('cuesta $5 el litro')).toEqual([{ kind: 'text', value: 'cuesta $5 el litro' }])
  })

  it('honours escaped dollars', () => {
    expect(splitMath('precio \\$3 y $x$')).toEqual([
      { kind: 'text', value: 'precio $3 y ' },
      { kind: 'inline', value: 'x' },
    ])
  })

  it('keeps escaped dollars inside math', () => {
    expect(splitMath('$a\\$b$')).toEqual([{ kind: 'inline', value: 'a\\$b' }])
  })
})

describe('joinMathBlocks', () => {
  it('joins a multi-line $$ block', () => {
    expect(joinMathBlocks(['antes', '$$', '\\int_0^1 x\\,dx', '= \\tfrac12', '$$', 'después'])).toEqual([
      'antes', '$$\\int_0^1 x\\,dx = \\tfrac12$$', 'después',
    ])
  })

  it('leaves single-line blocks and unclosed blocks untouched', () => {
    expect(joinMathBlocks(['$$a=b$$', '$$ sin cerrar'])).toEqual(['$$a=b$$', '$$ sin cerrar'])
  })
})
