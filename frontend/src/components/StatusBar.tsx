import { Badge } from './Badge'
import { useJarvisStore } from '../state/jarvisStore'
import { useGestureStore } from '../state/gestureStore'
import { useUiStore } from '../state/uiStore'
import { modeMeta } from '../constants'
import { nextVoiceMode } from '../lib/voiceMode'
import { dialItems, nucleusLevel } from '../lib/nucleus'
import type { Mode } from '../types'
import { gestureTone } from '../lib/gestureTone'

interface Props {
  /** Voz captando (wake abierta o PTT sostenido). */
  voiceActive: boolean
  voiceHeard: boolean
  /** Entrar a un modo desde la tira (mismo camino que el dial). */
  onEnter: (mode: Mode) => void
}

/** Barra superior: marca, tira de modos (fuera del reposo) y los tres controles (voz, texto, gestos). */
export function StatusBar({ voiceActive, voiceHeard, onEnter }: Props) {
  const zoomedMode = useJarvisStore(s => s.zoomedMode)
  const activeRingMode = useJarvisStore(s => s.activeRingMode)
  const menuOpen = useJarvisStore(s => s.menuOpen)
  const ringLevel = useJarvisStore(s => s.ringLevel)
  const voiceMode = useJarvisStore(s => s.voiceMode)
  const setVoiceMode = useJarvisStore(s => s.setVoiceMode)
  const gestureEnabled = useGestureStore(s => s.enabled)
  const gestureStatus = useGestureStore(s => s.status)
  const setGestureEnabled = useGestureStore(s => s.setEnabled)
  const textInputOpen = useUiStore(s => s.textInputOpen)
  const setTextInputOpen = useUiStore(s => s.setTextInputOpen)

  const level = nucleusLevel(zoomedMode, menuOpen, ringLevel)
  const current = zoomedMode ?? activeRingMode
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="status-bar">
      <span className="status-brand">JARVIS</span>
      <span className="status-divider" />
      <span className="status-spacer" />
      {level === 'rest' ? (
        <span className="mode-label">{modeMeta[current].label}</span>
      ) : (
        <nav className="nx-strip" aria-label="Modos">
          {dialItems(ringLevel).map((m, i) => (
            <button key={m} type="button" className={m === current ? 'is-on' : undefined} onClick={() => onEnter(m)}>
              {String(i + 1).padStart(2, '0')} {modeMeta[m].label.toUpperCase()}
            </button>
          ))}
        </nav>
      )}
      <span className="status-spacer" />
      <button
        className="status-badge-btn"
        title={`Modo de voz: ${voiceMode} · clic para cambiar`}
        onClick={() => setVoiceMode(nextVoiceMode(voiceMode))}
      >
        <Badge tone={voiceMode === 'off' ? 'idle' : voiceActive ? 'voice' : 'info'} live={voiceActive}>
          {voiceMode === 'off' ? 'voz off'
           : voiceHeard ? 'escucha'
           : voiceMode === 'wake_word' ? 'wake'
           : voiceMode === 'ptt' ? 'ptt' : 'continuo'}
        </Badge>
      </button>
      <button className="status-badge-btn" title="Escribirle a Jarvis" onClick={() => setTextInputOpen(!textInputOpen)}>
        <Badge tone={textInputOpen ? 'ok' : 'idle'}>texto</Badge>
      </button>
      <button className="status-badge-btn" title="Pipeline de gestos" onClick={() => setGestureEnabled(!gestureEnabled)}>
        <Badge
          tone={gestureTone(gestureEnabled, gestureStatus)}
          live={gestureEnabled && gestureStatus === 'starting'}
        >
          gestos
        </Badge>
      </button>
      <span className="clock">{time}</span>
    </div>
  )
}
