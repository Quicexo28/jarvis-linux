// Cursor del gesto point (índice izquierdo). Componente aislado a propósito:
// se suscribe solo a point.* y se re-renderiza a la tasa del pipeline (~25/s)
// sin arrastrar al resto de la app AWAKE. La transición CSS interpola entre
// muestras del pipeline — sin ella el cursor "salta" a la tasa de inferencia.
import { useGestureStore } from '../state/gestureStore'

export function GesturePointer() {
  const active = useGestureStore(s => s.output.point.active)
  const screenX = useGestureStore(s => s.output.point.screenX)
  const screenY = useGestureStore(s => s.output.point.screenY)

  if (!active) return null

  return (
    <div style={{
      position: 'fixed',
      left: `${screenX * 100}%`,
      top: `${screenY * 100}%`,
      width: 16, height: 16,
      borderRadius: '50%',
      background: 'radial-gradient(circle, #00f0ff 0%, transparent 70%)',
      boxShadow: '0 0 12px #00f0ff, 0 0 24px #00f0ff44',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
      zIndex: 9000,
      transition: 'left 0.045s linear, top 0.045s linear',
      willChange: 'left, top',
    }} />
  )
}
