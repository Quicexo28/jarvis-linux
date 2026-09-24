/**
 * Shared state for the remote app: backend reachability, host telemetry and the
 * ambient-context reporting the phone does while the page is open.
 *
 * The reporting hooks live in the shell (not in a tab) so signals keep flowing
 * whichever tab is on screen — inside the APK the native ReporterService does
 * the same job in the background; these are the foreground, higher-resolution
 * version of it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiBase, request } from '../../api/client'
import type { SystemTelemetry } from '../../types'
import { postCtx } from './api'
import { isNativeApp } from './native'

/** Device name this page reports as, so phone and tablet don't mask each other. */
export const CTX_DEVICE = isNativeApp()
  ? 'tablet'
  : /Android/i.test(navigator.userAgent) ? 'tablet' : 'iphone'

/** Backend heartbeat every 15 s. `null` until the first probe answers. */
export function useOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch(`${getApiBase()}/health`)
        if (!cancelled) setOnline(res.ok)
      } catch {
        if (!cancelled) setOnline(false)
      }
    }
    check()
    const timer = setInterval(check, 15_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  return online
}

/** Host telemetry, polled at `everyMs` (default 30 s). */
export function useTelemetry(everyMs = 30_000): SystemTelemetry | null {
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null)
  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const res = await request<SystemTelemetry>('/api/system/telemetry')
        if (!cancelled) setTelemetry(res)
      } catch {}
    }
    pull()
    const timer = setInterval(pull, everyMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [everyMs])
  return telemetry
}

export type GeoStatus = 'off' | 'on' | 'denied'

/**
 * Foreground location reporting, throttled to one POST per minute. iOS only
 * grants geolocation from a user gesture, so `enable` is wired to a button.
 */
export function useLocationReporting(): { status: GeoStatus; enable: () => void } {
  const [status, setStatus] = useState<GeoStatus>('off')
  const watchRef = useRef<number | null>(null)
  const lastSentRef = useRef(0)

  const enable = useCallback(() => {
    if (!navigator.geolocation) { setStatus('denied'); return }
    if (watchRef.current != null) return
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus('on')
        const now = Date.now()
        if (now - lastSentRef.current < 60_000) return
        lastSentRef.current = now
        const { latitude, longitude, accuracy } = pos.coords
        postCtx('location', { lat: latitude, lon: longitude, accuracy, source: 'web', device: CTX_DEVICE }).catch(() => {})
      },
      () => setStatus('denied'),
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
    )
  }, [])

  useEffect(() => () => {
    if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current)
  }, [])

  return { status, enable }
}

/** Report foreground/background presence on mount, on visibility change and every 60 s. */
export function usePresenceReporting(): void {
  useEffect(() => {
    const report = () => {
      postCtx('presence', { foreground: document.visibilityState === 'visible', device: CTX_DEVICE }).catch(() => {})
    }
    report()
    document.addEventListener('visibilitychange', report)
    const timer = setInterval(report, 60_000)
    return () => { document.removeEventListener('visibilitychange', report); clearInterval(timer) }
  }, [])
}

/**
 * Generic poller for a promise-returning loader. Returns the last value, the
 * last error message and a manual `reload`.
 */
export function usePolled<T>(load: () => Promise<T>, everyMs: number): {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let cancelled = false
    const pull = async () => {
      try {
        const res = await loadRef.current()
        if (!cancelled) { setData(res); setError(null) }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    pull()
    if (everyMs <= 0) return () => { cancelled = true }
    const timer = setInterval(pull, everyMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [everyMs, nonce])

  const reload = useCallback(() => { setLoading(true); setNonce((n) => n + 1) }, [])
  return { data, error, loading, reload }
}
