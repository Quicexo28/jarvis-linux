import { useEffect } from 'react'
import { useJarvisStore } from '../state/jarvisStore'
import { useGestureStore } from '../state/gestureStore'
import { useModel3dStore } from '../state/model3dStore'
import { RING_DRAG_SENSITIVITY, RING_SLOT_HYSTERESIS } from '../gestures/config'
import { slotWithHysteresis, dragToRingAngle } from '../state/ringSnap'
import { MAIN_RING } from '../constants'

  // Gesture: el puño AGARRA el carrusel y lo gira; al soltar, snap al slot más
  // cercano. Manipulación DIRECTA y absoluta — el ángulo es una función de
  // dónde está la mano ahora mismo, no la integral de sus incrementos.
  //
  // Lo que había antes y por qué se cambió entero:
  //  1. `ringAngle` lo escribía este arrastre y no lo leía NADIE: el carrusel
  //     seguía `activeRingMode`, así que mientras arrastrabas no se movía un
  //     pixel y al soltar saltaba de golpe al slot elegido. Sin feedback no hay
  //     manera de apuntar: arrastrabas a ciegas.
  //  2. Se sumaban "radianes" (deltaYaw · sensibilidad) a un valor medido en
  //     SLOTS — dos unidades distintas en la misma variable.
  //  3. `useGestureRotation` metía EMA + zona muerta + exponente 1.4 sobre el
  //     INCREMENTO POR FRAME, encima del One-Euro que el GrabTracker ya aplica.
  //     Una zona muerta sobre la derivada mata los movimientos lentos enteros
  //     (a 20 Hz un gesto suave da ~0.005/frame, por debajo del umbral 0.015) y
  //     el exponente aplasta lo que queda. De ahí que hubiera que "remar".
  // El visor 3D (overlay z-index 5000) CAPTURA los gestos: mientras esté
  // abierto, el ring de debajo no se mueve.
export function useRingDrag() {
  useEffect(() => {
    let dragging = false
    let baseAngle = 0
    let lastSlot = -1

    const stop = () => {
      if (!dragging) return
      dragging = false
      const jarvis = useJarvisStore.getState()
      // Cae en el slot que estaba RESALTADO (con su histéresis), no en el más
      // cercano: soltar con el ángulo en 1.55 no debe elegir otro que el visto.
      const slot = slotWithHysteresis(jarvis.ringAngle, lastSlot, MAIN_RING.length, RING_SLOT_HYSTERESIS)
      lastSlot = -1
      // El orden importa: soltar la bandera ANTES deja que setActiveRingMode
      // vuelva a mantener el invariante ángulo↔modo (ver jarvisStore).
      jarvis.setRingDragging(false)
      jarvis.setRingAngle(slot)
      jarvis.setActiveRingMode(MAIN_RING[slot])
    }

    return useGestureStore.subscribe((s, prev) => {
      const g = s.output.grab
      const p = prev.output.grab
      if (g.active === p.active && g.deltaX === p.deltaX) return

      const jarvis = useJarvisStore.getState()
      const blocked =
        jarvis.zoomedMode != null ||
        useModel3dStore.getState().open ||
        s.output.pinch.active

      if (!g.active || blocked || jarvis.ringLevel !== 'main') { stop(); return }

      if (!dragging) {
        dragging = true
        baseAngle = jarvis.ringAngle
        jarvis.setRingDragging(true)
      }
      const angle = dragToRingAngle(baseAngle, g.deltaX, RING_DRAG_SENSITIVITY)
      jarvis.setRingAngle(angle)
      // Resalte en vivo del slot que pasa por el frente: sin esto el holograma
      // no se ilumina hasta soltar y el arrastre sigue siendo a ciegas. Con
      // histéresis: en la frontera x.5 el temblor de la mano alternaba dos modos.
      const slot = slotWithHysteresis(angle, lastSlot, MAIN_RING.length, RING_SLOT_HYSTERESIS)
      if (slot !== lastSlot) {
        lastSlot = slot
        jarvis.setActiveRingMode(MAIN_RING[slot])
      }
    })
  }, [])
}
