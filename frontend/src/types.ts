export type Mode = 'home' | 'house' | 'plan2d' | 'plan3d' | 'space' | 'cloud' | 'system' | 'mobile' | 'utils' | 'timer' | 'chrono'
export type HoloMode = Exclude<Mode, 'plan2d' | 'plan3d' | 'space' | 'mobile'>
export type WallType = 'solid' | 'low'
export type Segment = { x1: number; y1: number; x2: number; y2: number; wallType?: WallType }
export type SavedPlan = { room: string; name: string; segments: Segment[]; updatedAt: string }
export type EntityCategory = 'furniture' | 'device'
export type EntityKind = 'sofa' | 'bed' | 'table' | 'tv' | 'lamp' | 'router' | 'camera' | 'switch' | 'sensor'
export type SceneEntity = { id: string; kind: EntityKind; category: EntityCategory; x: number; y: number; z: number; rotY: number; width: number; height: number; depth: number; color: string; label: string; skillName?: string; skillAction?: string; skillActions?: string[] }
export type Viewpoint = { x: number; y: number; z: number; yawDeg: number }
export type SystemTelemetry = {
  host?: { cpu?: { usagePct?: number }, memory?: { usedGB?: number; totalGB?: number; usagePct?: number }, gpu?: { avgUtilizationPct?: number }, network?: { rxMbps?: number, txMbps?: number } }
  openclaw?: { codexTokensUsed?: number | null, codexTokensTotal?: number | null }
}
export type MobileTokenInfo = {
  token: string
  lanUrl: string
  tailscaleUrl: string | null
  qrUrl: string
  expiresAt: number
  activated: boolean
}
export type MobileStatus = {
  connected: boolean
  lastSeen: number | null
  via: 'tailscale' | 'lan' | null
  userAgent: string | null
}
