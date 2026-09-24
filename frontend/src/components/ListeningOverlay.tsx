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
      {/* reactive sigue a `listening`: la onda sólo se ve cuando se escucha, y
          así el micro compartido puede cerrarse de verdad con la voz apagada
          (este overlay está montado siempre). */}
      <WaveEqualizer
        label={ptt ? 'PTT' : 'Escuchando'}
        active={listening}
        reactive={listening}
        style={{ position: 'absolute', inset: 0 }}
      />
    </div>
  )
}
