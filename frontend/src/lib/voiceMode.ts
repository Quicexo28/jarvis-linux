import type { VoiceMode } from '../state/jarvisStore'

const NEXT: Record<VoiceMode, VoiceMode> = {
  off: 'continuous',
  continuous: 'wake_word',
  wake_word: 'ptt',
  ptt: 'off',
}

/** Siguiente modo de voz en el ciclo: off → continuo → wake → ptt → off. */
export const nextVoiceMode = (m: VoiceMode): VoiceMode => NEXT[m]
