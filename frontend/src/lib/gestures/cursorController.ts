// frontend/src/lib/gestures/cursorController.ts
// Máquina de estados del cursor de mano: muestra de gesto → hover / press /
// click / dwell. Pura (sin DOM, `t` explícito) — testeable en Node; el hook
// solo le enchufa el resolvedor de objetivos y los emisores de eventos.
//
// La semántica es la del RATÓN a propósito (down, up, click sobre el mismo
// objetivo). Todo lo que ya funciona con ratón — botones del HUD, dock, el
// raycast de R3F del anillo — funciona con la mano sin tocar un solo consumidor.
import { CURSOR_DWELL_MS, CURSOR_DWELL_CANCEL_PX } from '../../gestures/config'

export interface CursorSample {
  /** Hay mano apuntando. false = cursor fuera. */
  active: boolean
  /** Posición en píxeles de ventana, YA con el adelanto predictivo aplicado. */
  x: number
  y: number
  pressed: boolean
  down: boolean
  up: boolean
  t: number
}

export interface ResolvedTarget {
  id: string | null
  x: number
  y: number
}

export interface CursorHandlers {
  /** Resuelve el objetivo imantado para un punto. `stickyId` = el ya enganchado. */
  resolve: (x: number, y: number, stickyId: string | null) => ResolvedTarget
  onMove: (x: number, y: number, targetId: string | null) => void
  onEnter: (targetId: string, x: number, y: number) => void
  onLeave: (targetId: string) => void
  onPress: (targetId: string | null, x: number, y: number) => void
  onRelease: (targetId: string | null, x: number, y: number) => void
  /** Clic efectivo: al soltar sobre el mismo objetivo, o por permanencia. */
  onClick: (targetId: string | null, x: number, y: number, via: 'tap' | 'dwell') => void
  /** 0..1 — progreso del clic por permanencia (para pintarlo). 0 = sin dwell. */
  onDwell: (progress: number) => void
  /** El cursor sale de escena (mano perdida). */
  onExit: () => void
}

export class CursorController {
  private hoverId: string | null = null
  private pressId: string | null = null
  private pressed = false
  private visible = false
  private dwellSince = 0
  private dwellAnchor = { x: 0, y: 0 }
  /** Un dwell ya consumido no se repite hasta cambiar de objetivo o moverse. */
  private dwellDone = false
  private lastDwell = 0

  constructor(private h: CursorHandlers) {}

  update(s: CursorSample): void {
    if (!s.active) {
      this.exit()
      return
    }

    const res = this.h.resolve(s.x, s.y, this.hoverId)
    const x = res.x
    const y = res.y
    this.visible = true

    // --- hover ---
    if (res.id !== this.hoverId) {
      if (this.hoverId !== null) this.h.onLeave(this.hoverId)
      this.hoverId = res.id
      if (res.id !== null) this.h.onEnter(res.id, x, y)
      this.resetDwell(x, y, s.t)
    }

    this.h.onMove(x, y, res.id)

    // --- botón ---
    if (s.down && !this.pressed) {
      this.pressed = true
      this.pressId = res.id
      this.h.onPress(res.id, x, y)
      this.resetDwell(x, y, s.t)
      this.emitDwell(0)
    } else if (s.up && this.pressed) {
      this.pressed = false
      this.h.onRelease(res.id, x, y)
      // Clic solo si se suelta sobre el MISMO objetivo donde se pulsó: igual que
      // un ratón, arrastrar fuera y soltar cancela.
      if (res.id !== null && res.id === this.pressId) this.h.onClick(res.id, x, y, 'tap')
      this.pressId = null
      this.resetDwell(x, y, s.t)
    } else if (!s.pressed && this.pressed) {
      // Presión abandonada sin `up` (pose perdida): soltar sin clic.
      this.pressed = false
      this.h.onRelease(res.id, x, y)
      this.pressId = null
      this.resetDwell(x, y, s.t)
    }

    // --- dwell (red de seguridad si el tap no engancha) ---
    if (CURSOR_DWELL_MS <= 0 || this.pressed || this.hoverId === null) {
      this.emitDwell(0)
      return
    }
    const moved = Math.hypot(x - this.dwellAnchor.x, y - this.dwellAnchor.y)
    if (moved > CURSOR_DWELL_CANCEL_PX) {
      this.resetDwell(x, y, s.t)
      this.emitDwell(0)
      return
    }
    if (this.dwellDone) {
      this.emitDwell(0)
      return
    }
    const progress = Math.min(1, (s.t - this.dwellSince) / CURSOR_DWELL_MS)
    this.emitDwell(progress)
    if (progress >= 1) {
      this.dwellDone = true
      this.emitDwell(0)
      this.h.onClick(this.hoverId, x, y, 'dwell')
    }
  }

  /** Estado actual del objetivo bajo el cursor (para depuración/visual). */
  get target(): string | null {
    return this.hoverId
  }

  reset(): void {
    this.exit()
  }

  private exit(): void {
    if (this.pressed) {
      this.pressed = false
      this.pressId = null
    }
    if (this.hoverId !== null) {
      this.h.onLeave(this.hoverId)
      this.hoverId = null
    }
    this.emitDwell(0)
    this.dwellDone = false
    if (this.visible) {
      this.visible = false
      this.h.onExit()
    }
  }

  private resetDwell(x: number, y: number, t: number): void {
    this.dwellSince = t
    this.dwellAnchor = { x, y }
    this.dwellDone = false
  }

  private emitDwell(p: number): void {
    if (p === this.lastDwell) return
    this.lastDwell = p
    this.h.onDwell(p)
  }
}
