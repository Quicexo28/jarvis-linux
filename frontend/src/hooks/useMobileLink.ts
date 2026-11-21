import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { apiFetch } from '../api/client'
import type { MobileTokenInfo, MobileStatus } from '../types'

/** Pide `url` cada `everyMs` mientras `active`. Los fallos se ignoran: el panel muestra "sin dato". */
function usePolled<T>(url: string, everyMs: number, active: boolean) {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const pull = async () => {
      try {
        const res = await apiFetch(url)
        const json = await res.json() as T
        if (!cancelled) setData(json)
      } catch { /* sin red: se conserva el último dato */ }
    }
    pull()
    const timer = setInterval(pull, everyMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [url, everyMs, active])
  return [data, setData] as const
}

/** Texto de cuenta atrás del QR móvil. */
function countdownText(token: MobileTokenInfo, connected: boolean, now: number): string {
  if (token.activated || connected) return 'Sesión activa'
  if (token.permanent) return 'Token permanente'
  const diff = token.expiresAt - now
  if (diff <= 0) return 'Expirado'
  const m = Math.floor(diff / 60_000)
  const s = Math.floor((diff % 60_000) / 1000)
  return `Expira en ${m}:${String(s).padStart(2, '0')}`
}

/** Datos del panel "Conexión móvil": token, estado, QR dibujado, cuenta atrás y copiar URL. */
export function useMobileLink(active: boolean) {
  const [token, setToken] = usePolled<MobileTokenInfo>('/api/mobile/token', 60_000, active)
  const [status] = usePolled<MobileStatus>('/api/mobile/status', 10_000, active)
  const [countdown, setCountdown] = useState('')
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const qrCanvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!token || !qrCanvasRef.current) return
    QRCode.toCanvas(qrCanvasRef.current, token.qrUrl, { width: 120, margin: 1 })
  }, [token])

  useEffect(() => {
    if (!active || !token) return
    const connected = status?.connected === true
    const tick = () => setCountdown(countdownText(token, connected, Date.now()))
    tick()
    if (token.activated || connected || token.permanent) return
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [active, token, status])

  const refreshQr = useCallback(async () => {
    try {
      await apiFetch(`/api/mobile/token/refresh`, { method: 'POST' })
      const res = await apiFetch(`/api/mobile/token`)
      setToken(await res.json() as MobileTokenInfo)
    } catch { /* se queda el token anterior */ }
  }, [setToken])

  const copyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url)
      setTimeout(() => setCopiedUrl(null), 1500)
    })
  }, [])

  return { token, status, countdown, copiedUrl, qrCanvasRef, refreshQr, copyUrl }
}
