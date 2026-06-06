import type { Vec3, HandFeatures } from './types'

function dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function dist2D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function curlRatio(mcp: Vec3, pip: Vec3, dip: Vec3, tip: Vec3): number {
  const chainLength = dist(mcp, pip) + dist(pip, dip) + dist(dip, tip)
  if (chainLength < 1e-6) return 0
  return dist(mcp, tip) / chainLength
}

function thumbCurlRatio(cmc: Vec3, mcp: Vec3, ip: Vec3, tip: Vec3): number {
  const chainLength = dist(cmc, mcp) + dist(mcp, ip) + dist(ip, tip)
  if (chainLength < 1e-6) return 0
  return dist(cmc, tip) / chainLength
}

export function extractFeatures(landmarks: Vec3[]): HandFeatures {
  const wrist = landmarks[0]
  const middleMcp = landmarks[9]
  const palmSize = dist(wrist, middleMcp)
  const normFactor = palmSize > 1e-6 ? palmSize : 1

  const curl = {
    thumb: thumbCurlRatio(landmarks[1], landmarks[2], landmarks[3], landmarks[4]),
    index: curlRatio(landmarks[5], landmarks[6], landmarks[7], landmarks[8]),
    middle: curlRatio(landmarks[9], landmarks[10], landmarks[11], landmarks[12]),
    ring: curlRatio(landmarks[13], landmarks[14], landmarks[15], landmarks[16]),
    pinky: curlRatio(landmarks[17], landmarks[18], landmarks[19], landmarks[20]),
  }

  const tipDistances = {
    thumbIndex: dist(landmarks[4], landmarks[8]) / normFactor,
    thumbIndex2D: dist2D(landmarks[4], landmarks[8]),
    indexMiddle: dist(landmarks[8], landmarks[12]) / normFactor,
    middleRing: dist(landmarks[12], landmarks[16]) / normFactor,
    ringPinky: dist(landmarks[16], landmarks[20]) / normFactor,
  }

  // Palm roll angle in the image plane: direction of the wrist→middle-MCP vector.
  // Rotating the wrist (like a steering wheel) changes this; used for 1:1 angular
  // rotation of 3D figures (hand rotates 20° → figure rotates 20°).
  const palmAngle = Math.atan2(middleMcp.y - wrist.y, middleMcp.x - wrist.x)

  return {
    palmSize,
    curl,
    tipDistances,
    wristPosition: { x: wrist.x, y: wrist.y, z: wrist.z },
    indexTipPosition: { x: landmarks[8].x, y: landmarks[8].y, z: landmarks[8].z },
    palmAngle,
  }
}
