export const GESTURE_CLASSES = [
  'idle',
  'grab',
  'point',
  'pinch',
  'peace_sep',
  'peace_close',
  'open_palm',
  'pinky_extended',
] as const

export type GestureClass = typeof GESTURE_CLASSES[number]

export const NUM_FEATURES = 9
// Feature vector: [curl.thumb, curl.index, curl.middle, curl.ring, curl.pinky, tipDist.thumbIndex, tipDist.indexMiddle, tipDist.middleRing, tipDist.ringPinky]
