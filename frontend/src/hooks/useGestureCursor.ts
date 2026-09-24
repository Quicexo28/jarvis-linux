// frontend/src/hooks/useGestureCursor.ts
// Puente entre el puntero de gestos y la INTERFAZ REAL: convierte cada muestra
// del pipeline en eventos de puntero del DOM.
//
// La decisión de fondo: en vez de cablear cada menú a `gestureStore`, el cursor
// de mano emite `pointermove`/`pointerdown`/`click` de verdad sobre el elemento
// que hay debajo. Consecuencia — todo lo que ya funcionaba con ratón funciona
// con la mano sin tocarlo: los botones del HUD, los overlays, y el ANILLO 3D
// (el raycast de @react-three/fiber escucha los mismos eventos sobre el canvas).
// La alternativa, un registro propio de objetivos, habría duplicado el hit-test
// del navegador y el de three, y habría dejado fuera todo lo que no se registre.
//
// Los eventos que sintetiza llevan la marca `__gesture` para que un consumidor
// pueda distinguirlos (el anillo la usa para girar al slot que se señala, cosa
// que con ratón sería molesta).
import { useEffect } from 'react'
import { useGestureStore } from '../state/gestureStore'
import { useCursorStore } from '../state/cursorStore'
import { CursorController } from '../lib/gestures/cursorController'
import { magnetize, type TargetRect } from '../lib/gestures/hitTest'
import { POINTER_LEAD_MS, POINTER_LEAD_MAX } from '../gestures/config'

/** Qué se considera "objetivo imantable". `data-gesture-target` fuerza la
 *  inclusión de algo que no es un control nativo; `data-gesture-ignore` excluye. */
const TARGET_SELECTOR = [
  '[data-gesture-target]',
  'button:not([disabled])',
  '[role="button"]',
  'a[href]',
  'select',
  'input[type="checkbox"]',
  'input[type="radio"]',
].join(',')

/** Los rects se releen como mucho a este ritmo: getBoundingClientRect de ~40
 *  elementos en CADA muestra (20 Hz) es layout thrash gratis. */
const RECT_TTL_MS = 180
/** Objetivos más grandes que esto no imantan: un panel a pantalla completa se
 *  tragaría el cursor entero y ganaría a los botones de dentro por cercanía. */
const MAX_TARGET_AREA_FRACTION = 0.25

interface Candidate {
  id: string
  el: Element
  rect: TargetRect
}

function markGesture(ev: Event): Event {
  Object.defineProperty(ev, '__gesture', { value: true, enumerable: false })
  return ev
}

/**
 * Evento de puntero sintético. `offsetX/offsetY` se fijan a mano contra el rect
 * del destino: es lo que lee el `compute` por defecto de react-three-fiber para
 * construir el rayo, y en un evento construido a mano no viene relleno.
 */
/** Entornos sin `PointerEvent` (jsdom, WebViews viejos): la pareja `mouse*` que
 *  se emite al lado ya cubre a los consumidores; construir el evento no debe
 *  reventar el cursor entero. */
const PointerEventCtor = (typeof PointerEvent === 'function' ? PointerEvent : MouseEvent) as {
  new (type: string, init: PointerEventInit): MouseEvent
}

function pointerEvent(
  type: string, x: number, y: number, target: Element, buttons: number, bubbles = true,
): MouseEvent {
  const ev = new PointerEventCtor(type, {
    bubbles,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
    pointerId: 8801,
    pointerType: 'mouse',
    isPrimary: true,
  })
  const r = target.getBoundingClientRect()
  Object.defineProperty(ev, 'offsetX', { value: x - r.left })
  Object.defineProperty(ev, 'offsetY', { value: y - r.top })
  return markGesture(ev) as MouseEvent
}

function mouseEvent(
  type: string, x: number, y: number, target: Element, buttons: number, bubbles = true,
): MouseEvent {
  const ev = new MouseEvent(type, {
    bubbles,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
  })
  const r = target.getBoundingClientRect()
  Object.defineProperty(ev, 'offsetX', { value: x - r.left })
  Object.defineProperty(ev, 'offsetY', { value: y - r.top })
  return markGesture(ev) as MouseEvent
}

/**
 * Cursor de mano sobre la interfaz. Se monta UNA vez (AwakeApp).
 * No re-renderiza a su host: toda la suscripción es imperativa, como el resto
 * de consumidores de gestos.
 */
export function useGestureCursor(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    let candidates: Candidate[] = []
    let candidatesAt = -Infinity
    let seq = 0
    const ids = new WeakMap<Element, string>()
    /** Elemento sobre el que se emitieron los últimos enter/over. */
    let overEl: Element | null = null
    let pressEl: Element | null = null
    let pressedNow = false
    /** `buttons` de los eventos sintéticos: 1 mientras el tap está presionado. */
    const controllerButtons = () => (pressedNow ? 1 : 0)

    const refresh = (now: number) => {
      if (now - candidatesAt < RECT_TTL_MS) return
      candidatesAt = now
      const maxArea = window.innerWidth * window.innerHeight * MAX_TARGET_AREA_FRACTION
      const next: Candidate[] = []
      for (const el of document.querySelectorAll(TARGET_SELECTOR)) {
        if (el.hasAttribute('data-gesture-ignore')) continue
        if (el instanceof HTMLButtonElement && el.disabled) continue
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) continue
        if (r.width * r.height > maxArea) continue
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue
        let id = ids.get(el)
        if (id === undefined) { id = `g${++seq}`; ids.set(el, id) }
        next.push({ id, el, rect: { id, left: r.left, top: r.top, width: r.width, height: r.height } })
      }
      candidates = next
    }

    const byId = (id: string | null): Element | null =>
      id === null ? null : candidates.find(c => c.id === id)?.el ?? null

    /** Elemento REAL bajo el punto (puede ser un hijo del objetivo, o el canvas
     *  3D cuando no hay ningún objetivo DOM: ahí es donde entra el anillo). */
    const elementAt = (x: number, y: number): Element | null =>
      document.elementFromPoint(x, y)

    const dispatchPair = (el: Element, pType: string, mType: string, x: number, y: number, buttons: number, bubbles = true) => {
      el.dispatchEvent(pointerEvent(pType, x, y, el, buttons, bubbles))
      el.dispatchEvent(mouseEvent(mType, x, y, el, buttons, bubbles))
    }

    const leaveCurrent = () => {
      if (!overEl) return
      const r = overEl.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      dispatchPair(overEl, 'pointerout', 'mouseout', x, y, 0)
      dispatchPair(overEl, 'pointerleave', 'mouseleave', x, y, 0, false)
      overEl.classList.remove('gesture-hover')
      overEl = null
    }

    const controller = new CursorController({
      resolve: (x, y, stickyId) => {
        refresh(performance.now())
        const m = magnetize(x, y, candidates.map(c => c.rect), stickyId)
        return { id: m.id, x: m.x, y: m.y }
      },
      onMove: (x, y, targetId) => {
        const hit = elementAt(x, y)
        if (hit && hit !== overEl) {
          leaveCurrent()
          overEl = hit
          dispatchPair(hit, 'pointerover', 'mouseover', x, y, controllerButtons())
          dispatchPair(hit, 'pointerenter', 'mouseenter', x, y, controllerButtons(), false)
        }
        if (hit) dispatchPair(hit, 'pointermove', 'mousemove', x, y, controllerButtons())
        const box = candidates.find(c => c.id === targetId)?.rect ?? null
        useCursorStore.getState().set({
          visible: true, x, y,
          target: box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null,
        })
      },
      onEnter: (targetId) => {
        byId(targetId)?.classList.add('gesture-hover')
      },
      onLeave: (targetId) => {
        byId(targetId)?.classList.remove('gesture-hover')
      },
      onPress: (_id, x, y) => {
        pressEl = elementAt(x, y)
        if (pressEl) dispatchPair(pressEl, 'pointerdown', 'mousedown', x, y, 1)
        useCursorStore.getState().set({ pressed: true })
      },
      onRelease: (_id, x, y) => {
        const el = elementAt(x, y) ?? pressEl
        if (el) dispatchPair(el, 'pointerup', 'mouseup', x, y, 0)
        pressEl = null
        useCursorStore.getState().set({ pressed: false })
      },
      onClick: (_id, x, y, via) => {
        const el = elementAt(x, y)
        if (!el) return
        // Por permanencia nadie pulsó nada: hay controles que solo escuchan
        // mousedown/mouseup (el PTT, por ejemplo), así que el dwell tiene que
        // completar la secuencia. Con tap ya salieron en onPress/onRelease.
        if (via === 'dwell') {
          // Opt-out: un control que no admite disparo accidental se marca con
          // `data-gesture-nodwell` y solo se activa con un tap deliberado.
          if (el.closest('[data-gesture-nodwell]')) return
          dispatchPair(el, 'pointerdown', 'mousedown', x, y, 1)
          dispatchPair(el, 'pointerup', 'mouseup', x, y, 0)
        }
        // `click` a secas: es el que escucha React (delegado en la raíz) y el que
        // activa un <button>.
        el.dispatchEvent(mouseEvent('click', x, y, el, 0))
        useCursorStore.getState().pulse()
      },
      onDwell: (progress) => {
        useCursorStore.getState().set({ dwell: progress })
      },
      onExit: () => {
        leaveCurrent()
        pressEl = null
        useCursorStore.getState().set({ visible: false, pressed: false, dwell: 0, target: null })
      },
    })

    const onSample = () => {
      const out = useGestureStore.getState().output
      const p = out.point
      const t = performance.now()

      if (!p.active) {
        controller.update({ active: false, x: 0, y: 0, pressed: false, down: false, up: false, t })
        pressedNow = false
        return
      }

      // Adelanto predictivo: el pipeline publica a ~20 Hz y One-Euro añade su
      // propio retardo, así que sin esto el cursor va visiblemente detrás de la
      // mano. Extrapolación lineal con tope (pasarse produce sobreimpulso al
      // frenar, que se siente peor que el retardo).
      const leadX = Math.max(-POINTER_LEAD_MAX, Math.min(POINTER_LEAD_MAX, p.vx * POINTER_LEAD_MS))
      const leadY = Math.max(-POINTER_LEAD_MAX, Math.min(POINTER_LEAD_MAX, p.vy * POINTER_LEAD_MS))
      const x = Math.max(0, Math.min(1, p.screenX + leadX)) * window.innerWidth
      const y = Math.max(0, Math.min(1, p.screenY + leadY)) * window.innerHeight

      pressedNow = out.tap.pressed
      controller.update({
        active: true, x, y,
        pressed: out.tap.pressed, down: out.tap.down, up: out.tap.up, t,
      })
    }

    const unsub = useGestureStore.subscribe((s, prev) => {
      if (s.output === prev.output) return
      onSample()
    })

    return () => {
      unsub()
      controller.reset()
      leaveCurrent()
      useCursorStore.getState().set({ visible: false, pressed: false, dwell: 0, target: null })
    }
  }, [enabled])
}
