const PHRASES: Record<string, string[]> = {
  manana: [
    'Buenos días, dime.',
    '¿Qué necesitas esta mañana?',
    'Aquí estoy, adelante.',
    'Dime, te escucho.',
  ],
  tarde: [
    'Buenas tardes, dime.',
    'A tus órdenes.',
    'Aquí estoy.',
    '¿En qué te ayudo?',
  ],
  noche: [
    'Buenas noches, dime.',
    '¿En qué puedo ayudarte?',
    'Te escucho.',
    'Aquí estoy, dime.',
  ],
}

function getTimeSlot(): string {
  const h = new Date().getHours()
  if (h >= 6 && h < 12) return 'manana'
  if (h >= 12 && h < 20) return 'tarde'
  return 'noche'
}

export function getWakeConfirmation(focusedLabel?: string): string {
  if (focusedLabel) return `¿Qué hago con ${focusedLabel}?`
  const pool = PHRASES[getTimeSlot()]
  return pool[Math.floor(Math.random() * pool.length)]
}
