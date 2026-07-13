import { WaveEqualizer } from './WaveEqualizer'

interface ListeningOverlayProps {
  listening: boolean
  ptt?: boolean
}

export function ListeningOverlay({ listening, ptt = false }: ListeningOverlayProps) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 40,
        left: '50%',
        transform: `translateX(-50%) scale(${listening ? 1 : 0.85})`,
        width: 200,
        height: 90,
        opacity: listening ? 1 : 0,
        transition: 'opacity 0.35s ease, transform 0.35s ease',
        pointerEvents: 'none',
        zIndex: 400,
      }}
    >
      <WaveEqualizer
        label={ptt ? 'PTT' : 'Escuchando'}
        active={listening}
        style={{ position: 'absolute', inset: 0 }}
      />
    </div>
  )
}
