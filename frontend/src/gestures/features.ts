// frontend/src/gestures/features.ts
import type { Vec3 } from './types'

export interface HandFeatures {
  /** world: dist(muñeca, MCP medio) — métrico, normaliza distancias 3D. */
  palmSize: number
  /** Ratios de rectitud por dedo (1 = recto, ~0.3 = plegado), en world landmarks. */
  curl: {
    thumb: number
    index: number
    middle: number
    ring: number
    pinky: number
  }
  /** dist3D(punta pulgar, punta índice) / palmSize — control del pinch. */
  aperture: number
  /** dist3D(punta índice, punta medio) / palmSize — sep/close del peace. */
  indexMiddleGap: number
  /** Muñeca en image-space (0..1, sin espejar) — deltas del grab. */
  wristImage: { x: number; y: number }
  /** Punta del índice en image-space — puntero. */
  indexTipImage: { x: number; y: number }
  /** image: dist(muñeca, MCP medio) — proxy de distancia a la cámara. */
  palmImageSize: number
  /** Roll de la palma en el plano de imagen: atan2 de muñeca→MCP medio. */
  palmAngle: number
  /** world: eje de la mano (muñeca→MCP medio), normalizado — pitch del puño. */
  palmAxisWorld: Vec3
  /** world: normal de la palma (cross de muñeca→MCP índice × muñeca→MCP meñique),
   * normalizada — yaw del puño. La dirección absoluta depende de la quiralidad;
   * los consumidores usan solo DELTAS relativos al enganche. */
  palmNormalWorld: Vec3
}

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

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function normalize(v: Vec3): Vec3 {
  const n = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
  if (n < 1e-9) return { x: 0, y: 0, z: -1 }
  return { x: v.x / n, y: v.y / n, z: v.z / n }
}

/** dist(mcp, tip) / longitud de la cadena: 1 = dedo recto, baja al plegarse. */
function curlRatio(mcp: Vec3, pip: Vec3, dip: Vec3, tip: Vec3): number {
  const chain = dist(mcp, pip) + dist(pip, dip) + dist(dip, tip)
  if (chain < 1e-6) return 0
  return dist(mcp, tip) / chain
}

export function extractFeatures(world: Vec3[], image: Vec3[]): HandFeatures {
  const wrist = world[0]
  const middleMcp = world[9]
  const palmSize = dist(wrist, middleMcp)
  const norm = palmSize > 1e-6 ? palmSize : 1

  const curl = {
    thumb: curlRatio(world[1], world[2], world[3], world[4]),
    index: curlRatio(world[5], world[6], world[7], world[8]),
    middle: curlRatio(world[9], world[10], world[11], world[12]),
    ring: curlRatio(world[13], world[14], world[15], world[16]),
    pinky: curlRatio(world[17], world[18], world[19], world[20]),
  }

  const iWrist = image[0]
  const iMiddleMcp = image[9]
  const iIndexTip = image[8]

  return {
    palmSize,
    curl,
    aperture: dist(world[4], world[8]) / norm,
    indexMiddleGap: dist(world[8], world[12]) / norm,
    wristImage: { x: iWrist.x, y: iWrist.y },
    indexTipImage: { x: iIndexTip.x, y: iIndexTip.y },
    palmImageSize: dist2D(iWrist, iMiddleMcp),
    palmAngle: Math.atan2(iMiddleMcp.y - iWrist.y, iMiddleMcp.x - iWrist.x),
    palmAxisWorld: normalize(sub(middleMcp, wrist)),
    palmNormalWorld: normalize(cross(sub(world[5], wrist), sub(world[17], wrist))),
  }
}
