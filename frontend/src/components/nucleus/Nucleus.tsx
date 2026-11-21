import { useMemo } from 'react'
import { useJarvisStore } from '../../state/jarvisStore'
import { useOrbState } from '../../hooks/useOrbState'
import { dialItems, nucleusLevel, parentArcs, subArcs, uniformArcs } from '../../lib/nucleus'
import { modeMeta, MAIN_RING } from '../../constants'
import type { Mode } from '../../types'
import { Orb } from './Orb'
import { Dial } from './Dial'
import './nucleus.css'

interface Props {
  /** Ventana de wake abierta o PTT sostenido. */
  listening: boolean
  /** Clic en el orbe: abre el menú, o sube un nivel. */
  onOrb: () => void
  onEnter: (mode: Mode) => void
  /** Sube un nivel (clic en el dial principal encogido). */
  onBack: () => void
}

const noop = () => {}
const MAIN_ARCS = uniformArcs(MAIN_RING.length)

const IDLE_CAPTION = 'a sus órdenes, señor'

/**
 * Capa del Núcleo. Tres niveles (ver `lib/nucleus.ts`): reposo, menú y modo.
 * El orbe y el dial son una sola pieza que se re-coloca por CSS entre niveles.
 */
export function Nucleus({ listening, onOrb, onEnter, onBack }: Props) {
  const zoomedMode = useJarvisStore(s => s.zoomedMode)
  const menuOpen = useJarvisStore(s => s.menuOpen)
  const ringLevel = useJarvisStore(s => s.ringLevel)
  const active = useJarvisStore(s => s.activeRingMode)
  const setActive = useJarvisStore(s => s.setActiveRingMode)
  const coreReply = useJarvisStore(s => s.coreReply)
  const orb = useOrbState(listening)

  // Sub-dial: el principal amplía la entrada elegida y el sub-dial se abre como un arco sobre ella.
  const subItems = dialItems(ringLevel)
  const parent: Mode = ringLevel === 'house-sub' ? 'house' : 'utils'
  const layout = useMemo(
    () => ringLevel === 'main' ? null : parentArcs(MAIN_RING.length, MAIN_RING.indexOf(parent), subItems.length),
    [ringLevel, parent, subItems.length],
  )
  const level = nucleusLevel(zoomedMode, menuOpen, ringLevel)
  const caption =
    orb === 'listen' ? 'escuchando…'
    : orb === 'think' ? 'pensando…'
    : orb === 'speak' ? (coreReply ? `«${coreReply.slice(-140)}»` : '')
    : IDLE_CAPTION

  return (
    <div className={`nx nx--${level}`} data-orb={orb}>
      <div className="nx-stage">
        {!layout ? <Dial items={MAIN_RING} arcs={MAIN_ARCS} active={active} visible={level === 'menu'} onPick={onEnter} onHover={setActive} />
          : <>
              {/* Dial principal encogido: el padre elegido queda resaltado y un clic vuelve a él. */}
              <Dial role="parent" items={MAIN_RING} arcs={layout.arcs} active={parent} visible onPick={onBack} onHover={noop} />
              <Dial key={ringLevel} role="sub" items={subItems} arcs={subArcs(subItems.length, layout.mid)} active={active} visible onPick={onEnter} onHover={setActive} />
            </>}
        <Orb state={orb} onClick={onOrb} />
      </div>
      <p className="nx-status" aria-live="polite">{caption}</p>
      {level === 'mode' && zoomedMode && (
        <div className="nx-title">
          <h1>{modeMeta[zoomedMode].label}</h1>
          <p>{modeMeta[zoomedMode].subtitle}</p>
        </div>
      )}
    </div>
  )
}
