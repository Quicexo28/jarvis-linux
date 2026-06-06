type Intent = 'ai_directed' | 'wake_call' | 'ambient'

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

const WAKE_WORDS = ['jarvis', 'oye jarvis', 'hey jarvis', 'ey jarvis', 'oye', 'hey', 'ey']
  .map(normalize)

const ACTION_WORDS = [
  'apaga', 'enciende', 'prende', 'abre', 'cierra', 'sube', 'baja', 'pon', 'quita',
  'activa', 'desactiva', 'muestra', 'dime', 'dimelo', 'que', 'cual', 'cuanto',
  'cuando', 'como', 'por que', 'puedes', 'puede', 'ayuda', 'ayudame',
  'busca', 'encuentra', 'lista', 'explica', 'necesito', 'quiero', 'hazlo',
  'cambia', 'ajusta', 'configura', 'modo',
]

export function classifyIntent(transcript: string): Intent {
  const text = normalize(transcript)
  if (!text) return 'ambient'

  const words = text.split(/\s+/)

  if (words.length <= 3 && WAKE_WORDS.some((w) => text.includes(w))) {
    return 'wake_call'
  }

  if (ACTION_WORDS.some((w) => text.includes(w))) {
    return 'ai_directed'
  }

  if (words.length >= 4) return 'ai_directed'

  return 'ambient'
}
