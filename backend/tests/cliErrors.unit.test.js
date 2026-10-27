import { describe, it, expect } from 'vitest'
import { usageLimitNotice } from '../src/lib/claudeCli.js'

// The CLI's own failures arrive as normal-looking answers. Seen live on
// 2026-10-26: a watcher notified "You've hit your session limit…".
describe('usageLimitNotice', () => {
  it.each([
    ["You've hit your session limit · resets 10:30am (America/Bogota)", 'Llegué al límite de uso de mi suscripción, señor. Se restablece a las 10:30 de la mañana.'],
    ["You've hit your weekly limit · resets 3pm", 'Llegué al límite de uso de mi suscripción, señor. Se restablece a las 3 de la tarde.'],
    ['Claude usage limit reached.', 'Llegué al límite de uso de mi suscripción por ahora, señor.'],
  ])('%s', (raw, spoken) => expect(usageLimitNotice(raw)).toBe(spoken))

  it('leaves real answers alone', () => {
    expect(usageLimitNotice('Va a llover hacia las dos, lleve paraguas.')).toBeNull()
    expect(usageLimitNotice('El límite de velocidad en la vía es 80.')).toBeNull()
  })
})
