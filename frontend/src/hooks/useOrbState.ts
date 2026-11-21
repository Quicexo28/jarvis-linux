import { useEffect, useRef, useState } from 'react'
import { getTtsLevel, isTtsSpeaking, isTtsThinking } from '../audio/ttsLevelBus'
import { orbStateOf, type OrbState } from '../lib/nucleus'

const POLL_MS = 100

/**
 * Estado del orbe a partir de las señales REALES: pensar y hablar viven en
 * `ttsLevelBus` (fuera de React, no emite eventos), así que se sondea y solo se
 * toca el estado de React cuando CAMBIA. `listening` viene de `useVoiceTurn`.
 */
export function useOrbState(listening: boolean): OrbState {
  const [state, setState] = useState<OrbState>('idle')
  const listeningRef = useRef(listening)
  listeningRef.current = listening

  useEffect(() => {
    const id = setInterval(() => {
      setState(orbStateOf(listeningRef.current, isTtsThinking(), isTtsSpeaking()))
    }, POLL_MS)
    return () => clearInterval(id)
  }, [])

  return state
}

/** Nivel de la voz de Jarvis (0..1) escrito en `--lv` del elemento, mientras habla. Sin estado de React. */
export function useVoiceLevel(el: React.RefObject<HTMLElement | null>, speaking: boolean): void {
  useEffect(() => {
    const node = el.current
    if (!node) return
    if (!speaking) { node.style.setProperty('--lv', '0'); return }
    const id = setInterval(() => node.style.setProperty('--lv', getTtsLevel().toFixed(2)), 50)
    return () => clearInterval(id)
  }, [el, speaking])
}
