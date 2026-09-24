// Cursor de mano. Componente aislado a propósito: se suscribe solo a
// `cursorStore` y se re-renderiza a la tasa del pipeline (~20/s) sin arrastrar
// al resto de la app AWAKE. La transición CSS interpola entre muestras — sin
// ella el cursor "salta" a la tasa de inferencia.
//
// Pinta TRES cosas, y las tres son feedback que el cursor v1 (un punto ciego)
// no daba: el halo del objetivo IMANTADO (qué se va a pulsar), el estado del
// botón (apuntando / presionado) y el arco de permanencia (cuánto falta para
// que el dwell dispare). Sin ellas el usuario no sabe si la interfaz lo está
// viendo, que es el grueso de la fricción con un cursor de mano.
import { useCursorStore } from '../state/cursorStore'
import { HUE } from '../lib/theme'

const R = 13
const CIRC = 2 * Math.PI * R

export function GesturePointer() {
  const visible = useCursorStore(s => s.visible)
  const x = useCursorStore(s => s.x)
  const y = useCursorStore(s => s.y)
  const pressed = useCursorStore(s => s.pressed)
  const dwell = useCursorStore(s => s.dwell)
  const target = useCursorStore(s => s.target)
  const clickPulse = useCursorStore(s => s.clickPulse)

  if (!visible) return null

  const hue = pressed ? HUE.attn : target ? HUE.info : HUE.idle
  const scale = pressed ? 0.72 : target ? 1.12 : 1

  return (
    <>
      {target && (
        <div
          style={{
            position: 'fixed',
            left: target.left - 4,
            top: target.top - 4,
            width: target.width + 8,
            height: target.height + 8,
            border: `1.5px solid ${hue}`,
            borderRadius: 8,
            boxShadow: `0 0 14px ${hue}55, inset 0 0 14px ${hue}22`,
            pointerEvents: 'none',
            zIndex: 8990,
            transition: 'left .08s linear, top .08s linear, width .08s linear, height .08s linear, border-color .12s',
          }}
        />
      )}
      <div
        style={{
          position: 'fixed',
          left: x,
          top: y,
          width: 34,
          height: 34,
          transform: `translate(-50%, -50%) scale(${scale})`,
          pointerEvents: 'none',
          zIndex: 9000,
          transition: 'left .045s linear, top .045s linear, transform .09s ease-out',
          willChange: 'left, top, transform',
        }}
      >
        <svg width="34" height="34" viewBox="0 0 34 34" style={{ overflow: 'visible' }}>
          {/* Arco de permanencia: solo aparece cuando el dwell está corriendo. */}
          {dwell > 0 && (
            <circle
              cx="17" cy="17" r={R}
              fill="none" stroke={HUE.attn} strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${CIRC * dwell} ${CIRC}`}
              transform="rotate(-90 17 17)"
              opacity={0.9}
            />
          )}
          <circle
            cx="17" cy="17" r={R}
            fill="none" stroke={hue} strokeWidth="1.2"
            opacity={target ? 0.85 : 0.35}
          />
          <circle cx="17" cy="17" r={pressed ? 5 : 3.2} fill={hue} />
        </svg>
        {/* Destello de clic: el key remonta el nodo, así la animación reinicia. */}
        <span
          key={clickPulse}
          style={{
            position: 'absolute',
            left: 17, top: 17,
            width: 0, height: 0,
            borderRadius: '50%',
            border: `2px solid ${HUE.ok}`,
            transform: 'translate(-50%, -50%)',
            animation: clickPulse > 0 ? 'gesture-click-pulse .38s ease-out forwards' : 'none',
          }}
        />
      </div>
    </>
  )
}
