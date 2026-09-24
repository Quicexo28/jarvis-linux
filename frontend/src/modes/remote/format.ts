/**
 * Pure formatting helpers for the remote app. Kept free of React/DOM so they
 * stay Node-testable (format.test.ts).
 */

/** 128312 s -> "1d 11h". Always two units max, never scientific notation. */
export function uptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '—'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Megabytes -> "12.4 GB" above 1024, "512 MB" below. */
export function mb(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${Math.round(value)} MB`
}

/** Safe percentage of used/total; 0 when total is missing or zero. */
export function pct(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, (used / total) * 100))
}

/**
 * Battery level as a whole percentage. Sources disagree: the APK posts 0-100
 * (BatteryManager), iOS Shortcuts and the web Battery API post 0-1 — so a value
 * at or below 1 is a fraction, not a 1% battery.
 */
export function batteryPct(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.round(level <= 1 ? level * 100 : level)
}

/** ISO timestamp -> "hace 4 min" / "hace 2 h" / "hace 3 d". */
export function ago(ts: string | number | null | undefined, now = Date.now()): string {
  if (ts == null) return '—'
  const t = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'ahora'
  const m = Math.round(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} d`
}

/** Last path segment of a Windows or POSIX path, without splitting on the wrong separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
