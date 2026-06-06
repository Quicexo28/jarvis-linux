// frontend/src/gestures/modifiers.ts
import type { HandState, ActiveGesture, ModifierStatus } from './types'
import { PAUSE_RESUME_TOLERANCE, PAUSE_TIMEOUT_MS } from './config'

type InternalState = 'none' | 'paused' | 'waiting_resume'

export class ModifierLayer {
  private state: InternalState = 'none'
  private frozenValue = 0
  private target = 0
  private waitingStartedAt = 0

  update(
    rightState: HandState,
    activeGesture: ActiveGesture | null,
    currentThumbIndexDist: number,
    timestampMs: number,
  ): ModifierStatus {
    const pinkyExtended = rightState.fingers.pinky === 'extended'
    const isPinchActive = activeGesture?.id === 'pinch'

    switch (this.state) {
      case 'none':
        if (pinkyExtended && isPinchActive) {
          this.state = 'paused'
          this.frozenValue = activeGesture!.continuousValue ?? 0
          this.target = currentThumbIndexDist
        }
        break

      case 'paused':
        if (!pinkyExtended) {
          this.state = 'waiting_resume'
          this.waitingStartedAt = timestampMs
        }
        break

      case 'waiting_resume':
        if (pinkyExtended) {
          this.state = 'paused'
          break
        }
        if (Math.abs(currentThumbIndexDist - this.target) < PAUSE_RESUME_TOLERANCE) {
          this.state = 'none'
          break
        }
        if (timestampMs - this.waitingStartedAt > PAUSE_TIMEOUT_MS) {
          this.state = 'none'
          break
        }
        break
    }

    switch (this.state) {
      case 'none':
        return { type: 'none' }
      case 'paused':
        return { type: 'paused', frozenValue: this.frozenValue }
      case 'waiting_resume':
        return {
          type: 'waiting_resume',
          frozenValue: this.frozenValue,
          target: this.target,
          tolerance: PAUSE_RESUME_TOLERANCE,
        }
    }
  }

  reset(): void {
    this.state = 'none'
    this.frozenValue = 0
    this.target = 0
  }
}
