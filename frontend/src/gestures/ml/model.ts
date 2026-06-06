import * as tf from '@tensorflow/tfjs'
import { GESTURE_CLASSES, NUM_FEATURES, type GestureClass } from './classes'
import type { HandFeatures } from '../types'

const MODEL_STORAGE_KEY = 'indexeddb://jarvis-gesture-model'
const DATASET_STORAGE_KEY = 'jarvis.gesture.dataset.v1'

export interface TrainingSample {
  features: number[]
  label: GestureClass
}

export interface TrainingDataset {
  samples: TrainingSample[]
  version: number
}

export function featuresToVector(f: HandFeatures): number[] {
  return [
    f.curl.thumb,
    f.curl.index,
    f.curl.middle,
    f.curl.ring,
    f.curl.pinky,
    f.tipDistances.thumbIndex,
    f.tipDistances.indexMiddle,
    f.tipDistances.middleRing,
    f.tipDistances.ringPinky,
  ]
}

// Fisher-Yates. Baraja una copia — el dataset llega agrupado por clase (el trainer graba un
// gesto a la vez), y tf.js `validationSplit` corta el ÚLTIMO N% SIN barajar: sin esto, la última
// clase grabada quedaría 100% en validación y nunca entrenaría.
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function createModel(): tf.Sequential {
  const model = tf.sequential()
  model.add(tf.layers.dense({ inputShape: [NUM_FEATURES], units: 32, activation: 'relu' }))
  model.add(tf.layers.dropout({ rate: 0.2 }))
  model.add(tf.layers.dense({ units: 32, activation: 'relu' }))
  model.add(tf.layers.dense({ units: GESTURE_CLASSES.length, activation: 'softmax' }))
  model.compile({ optimizer: tf.train.adam(0.001), loss: 'categoricalCrossentropy', metrics: ['accuracy'] })
  return model
}

export class GestureMLModel {
  private model: tf.Sequential | null = null
  private ready = false

  isReady(): boolean { return this.ready }

  async train(
    dataset: TrainingSample[],
    onProgress?: (epoch: number, loss: number, acc: number) => void,
  ): Promise<{ finalLoss: number; finalAcc: number }> {
    if (dataset.length < 10) throw new Error('Need at least 10 samples')

    // Barajar antes del split (arregla el bug de validationSplit con dataset agrupado por clase).
    const shuffled = shuffle(dataset)
    const xs = tf.tensor2d(shuffled.map(s => s.features))
    const labelIndices = shuffled.map(s => GESTURE_CLASSES.indexOf(s.label))
    const ys = tf.oneHot(tf.tensor1d(labelIndices, 'int32'), GESTURE_CLASSES.length)
    const epochs = 80
    const batchSize = Math.min(32, Math.floor(dataset.length / 2))

    // Best-of-N restarts: la init de pesos es aleatoria y sin semilla, así que cada entrenamiento
    // sale distinto. Entrenamos varias veces y nos quedamos el de mejor val_acc → mata la varianza
    // que hacía que "el mismo dataset funcionara una vez y la siguiente no".
    const RESTARTS = 3
    let best: { model: tf.Sequential; score: number; loss: number; acc: number } | null = null

    for (let r = 0; r < RESTARTS; r++) {
      const model = createModel()
      let finalLoss = 0
      let finalAcc = 0
      let finalValAcc = 0

      await model.fit(xs, ys, {
        epochs,
        batchSize,
        shuffle: true,
        validationSplit: 0.15,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            finalLoss = logs?.loss ?? 0
            finalAcc = logs?.acc ?? 0
            finalValAcc = (logs?.val_acc as number) ?? finalAcc
            onProgress?.(r * epochs + epoch, finalLoss, finalAcc)
          },
        },
      })

      if (!best || finalValAcc > best.score) {
        best?.model.dispose()
        best = { model, score: finalValAcc, loss: finalLoss, acc: finalAcc }
      } else {
        model.dispose()
      }
    }

    xs.dispose()
    ys.dispose()

    this.model = best!.model
    this.ready = true
    return { finalLoss: best!.loss, finalAcc: best!.acc }
  }

  predict(features: HandFeatures): { gesture: GestureClass; confidence: number } {
    if (!this.model || !this.ready) return { gesture: 'idle', confidence: 0 }

    const input = tf.tensor2d([featuresToVector(features)])
    const prediction = this.model.predict(input) as tf.Tensor
    const probs = prediction.dataSync() as Float32Array
    input.dispose()
    prediction.dispose()

    let maxIdx = 0
    let maxProb = 0
    for (let i = 0; i < probs.length; i++) {
      if (probs[i] > maxProb) { maxProb = probs[i]; maxIdx = i }
    }

    return { gesture: GESTURE_CLASSES[maxIdx], confidence: maxProb }
  }

  async save(): Promise<void> {
    if (!this.model) return
    await this.model.save(MODEL_STORAGE_KEY)
  }

  async load(): Promise<boolean> {
    try {
      const loaded = await tf.loadLayersModel(MODEL_STORAGE_KEY)
      this.model = loaded as unknown as tf.Sequential
      this.ready = true
      return true
    } catch {
      return false
    }
  }
}

export function saveDataset(dataset: TrainingDataset): void {
  localStorage.setItem(DATASET_STORAGE_KEY, JSON.stringify(dataset))
}

export function loadDataset(): TrainingDataset {
  const raw = localStorage.getItem(DATASET_STORAGE_KEY)
  if (!raw) return { samples: [], version: 1 }
  return JSON.parse(raw)
}

export function exportDatasetFile(dataset: TrainingDataset): void {
  const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `gesture-dataset-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function importDatasetFile(file: File): Promise<TrainingDataset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        resolve(data)
      } catch (e) {
        reject(e)
      }
    }
    reader.onerror = reject
    reader.readAsText(file)
  })
}
