import type { Vec3, HandFeatures, HandState, GestureResult, ModifierStatus, GestureOutput, ActiveGesture } from './types'
import { extractFeatures } from './features'
import { HandStateTracker } from './state'
import { ModifierLayer } from './modifiers'
import { GestureRecognizer } from './recognizer'
import { MLGestureRecognizer } from './ml/recognizer'
import { OutputProcessor } from './output'

export interface PipelineDebugFrame {
  leftLandmarks: Vec3[] | null
  rightLandmarks: Vec3[] | null
  leftFeatures: HandFeatures | null
  rightFeatures: HandFeatures | null
  leftState: HandState | null
  rightState: HandState | null
  gesture: GestureResult
  modifier: ModifierStatus
  output: GestureOutput
  timestampMs: number
}

export class GesturePipeline {
  private leftTracker = new HandStateTracker()
  private rightTracker = new HandStateTracker()
  private modifierLayer = new ModifierLayer()
  private ruleRecognizer = new GestureRecognizer()
  private mlRecognizer = new MLGestureRecognizer()
  private outputProcessor = new OutputProcessor()
  private lastGesture: GestureResult = { left: 'idle', right: 'idle' }
  private zoomSmoothed = 1.0
  private mlInitialized = false

  async initML(): Promise<boolean> {
    this.mlInitialized = await this.mlRecognizer.init()
    return this.mlInitialized
  }

  isMLActive(): boolean { return this.mlInitialized && this.mlRecognizer.isReady() }

  process(
    leftLandmarks: Vec3[] | null,
    rightLandmarks: Vec3[] | null,
    timestampMs: number,
  ): GestureOutput {
    const leftFeatures: HandFeatures | null = leftLandmarks
      ? extractFeatures(leftLandmarks)
      : null
    const rightFeatures: HandFeatures | null = rightLandmarks
      ? extractFeatures(rightLandmarks)
      : null

    const leftState: HandState | null = leftFeatures
      ? this.leftTracker.update(leftFeatures)
      : null
    const rightState: HandState | null = rightFeatures
      ? this.rightTracker.update(rightFeatures)
      : null

    let gesture: GestureResult
    let discreteEvents: { click: boolean; back: boolean }

    if (this.mlInitialized) {
      gesture = this.mlRecognizer.update(leftFeatures, rightFeatures, timestampMs)
      discreteEvents = this.mlRecognizer.consumeDiscreteEvents()
    } else {
      gesture = this.ruleRecognizer.update(leftState, rightState, leftFeatures, rightFeatures, timestampMs)
      discreteEvents = this.ruleRecognizer.consumeDiscreteEvents()
    }

    this.lastGesture = gesture

    const activeGesture: ActiveGesture | null = this.lastGesture.right === 'pinch'
      ? { id: 'pinch', hand: 'right', continuousValue: this.zoomSmoothed }
      : null
    const currentThumbIndexDist = rightFeatures?.tipDistances.thumbIndex ?? 0
    const modifierStatus: ModifierStatus = rightState
      ? this.modifierLayer.update(rightState, activeGesture, currentThumbIndexDist, timestampMs)
      : { type: 'none' }

    const output = this.outputProcessor.update(
      gesture, leftFeatures, rightFeatures, modifierStatus,
      discreteEvents.click, discreteEvents.back, timestampMs,
    )

    this.zoomSmoothed = output.pinch.zoom

    output.debug = {
      leftDetected: leftLandmarks !== null,
      rightDetected: rightLandmarks !== null,
      leftGesture: gesture.left,
      rightGesture: gesture.right,
    }

    return output
  }

  processDebug(
    leftLandmarks: Vec3[] | null,
    rightLandmarks: Vec3[] | null,
    timestampMs: number,
  ): PipelineDebugFrame {
    const leftFeatures: HandFeatures | null = leftLandmarks ? extractFeatures(leftLandmarks) : null
    const rightFeatures: HandFeatures | null = rightLandmarks ? extractFeatures(rightLandmarks) : null
    const leftState: HandState | null = leftFeatures ? this.leftTracker.update(leftFeatures) : null
    const rightState: HandState | null = rightFeatures ? this.rightTracker.update(rightFeatures) : null

    let gesture: GestureResult
    let discreteEvents: { click: boolean; back: boolean }

    if (this.mlInitialized) {
      gesture = this.mlRecognizer.update(leftFeatures, rightFeatures, timestampMs)
      discreteEvents = this.mlRecognizer.consumeDiscreteEvents()
    } else {
      gesture = this.ruleRecognizer.update(leftState, rightState, leftFeatures, rightFeatures, timestampMs)
      discreteEvents = this.ruleRecognizer.consumeDiscreteEvents()
    }

    this.lastGesture = gesture

    const activeGesture: ActiveGesture | null = this.lastGesture.right === 'pinch'
      ? { id: 'pinch', hand: 'right', continuousValue: this.zoomSmoothed }
      : null
    const currentThumbIndexDist = rightFeatures?.tipDistances.thumbIndex ?? 0
    const modifierStatus: ModifierStatus = rightState
      ? this.modifierLayer.update(rightState, activeGesture, currentThumbIndexDist, timestampMs)
      : { type: 'none' }

    const output = this.outputProcessor.update(gesture, leftFeatures, rightFeatures, modifierStatus, discreteEvents.click, discreteEvents.back, timestampMs)
    this.zoomSmoothed = output.pinch.zoom

    output.debug = {
      leftDetected: leftLandmarks !== null,
      rightDetected: rightLandmarks !== null,
      leftGesture: gesture.left,
      rightGesture: gesture.right,
    }

    return {
      leftLandmarks, rightLandmarks,
      leftFeatures, rightFeatures,
      leftState, rightState,
      gesture, modifier: modifierStatus,
      output, timestampMs,
    }
  }

  reset(): void {
    this.leftTracker = new HandStateTracker()
    this.rightTracker = new HandStateTracker()
    this.modifierLayer.reset()
    this.ruleRecognizer = new GestureRecognizer()
    this.outputProcessor.reset()
    this.lastGesture = { left: 'idle', right: 'idle' }
    this.zoomSmoothed = 1.0
  }
}
