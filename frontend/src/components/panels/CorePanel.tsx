import type { CSSProperties } from 'react'
import { HudPanel } from '../HudPanel'
import { HudBtn } from '../HudBtn'
import { CoreTerminal } from '../CoreTerminal'
import { useJarvisStore } from '../../state/jarvisStore'
import { useBootStore } from '../../state/bootStore'
import { useUiStore } from '../../state/uiStore'
import { nextVoiceMode } from '../../lib/voiceMode'

interface Props {
  exiting: boolean
  style: CSSProperties
  /** Hay voz captando ahora mismo (wake abierta o PTT sostenido). */
  voiceHeard: boolean
}

export function CorePanel({ exiting, style, voiceHeard }: Props) {
  const voiceMode = useJarvisStore(s => s.voiceMode)
  const setVoiceMode = useJarvisStore(s => s.setVoiceMode)
  const clapWakeEnabled = useJarvisStore(s => s.clapWakeEnabled)
  const setClapWakeEnabled = useJarvisStore(s => s.setClapWakeEnabled)
  const setBootState = useBootStore(s => s.setBootState)
  const terminalOpen = useUiStore(s => s.terminalOpen)
  const setTerminalOpen = useUiStore(s => s.setTerminalOpen)

  return (
    <HudPanel mode="Core" exiting={exiting} className={`core-panel${terminalOpen ? ' core-panel--expanded' : ''}`} style={style}>
      {terminalOpen ? (
        <div className="core-terminal-wrapper core-terminal-enter">
          <CoreTerminal onClose={() => setTerminalOpen(false)} />
        </div>
      ) : (
        <div className="core-menu core-menu-enter">
          <HudBtn onClick={() => setTerminalOpen(true)}>Terminal</HudBtn>
          <HudBtn active={voiceMode !== 'off'} onClick={() => setVoiceMode(nextVoiceMode(voiceMode))}>
            {voiceMode === 'off'         ? 'Voz apagada'
             : voiceHeard                ? 'Escuchando…'
             : voiceMode === 'continuous' ? 'Siempre activa'
             : voiceMode === 'wake_word'  ? 'Wake word'
             : 'Modo PTT'}
          </HudBtn>
          <HudBtn active={clapWakeEnabled} onClick={() => setClapWakeEnabled(!clapWakeEnabled)}>
            {clapWakeEnabled ? 'Aplauso activo' : 'Activar aplauso'}
          </HudBtn>
          {/* El clic por permanencia del cursor de mano no puede dormir el
              sistema sin querer: aquí solo vale un tap deliberado. */}
          <span data-gesture-nodwell style={{ display: 'contents' }}>
            <HudBtn onClick={() => setBootState('DORMANT')}>Dormir sistema</HudBtn>
          </span>
        </div>
      )}
    </HudPanel>
  )
}
