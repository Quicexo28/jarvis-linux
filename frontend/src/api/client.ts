const STORAGE_KEY      = 'jarvis.api.base'
const MOBILE_TOKEN_KEY = 'jarvis.mobile.token'
const DEFAULT_BASE     = 'http://127.0.0.1:8788'

export function getApiBase(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  return (stored ?? DEFAULT_BASE).replace(/\/$/, '')
}

export function setApiBase(url: string): void {
  localStorage.setItem(STORAGE_KEY, url)
}

export function clearApiBase(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function getMobileToken(): string | null {
  return localStorage.getItem(MOBILE_TOKEN_KEY)
}

export function setMobileToken(token: string): void {
  localStorage.setItem(MOBILE_TOKEN_KEY, token)
}

export function clearMobileToken(): void {
  localStorage.removeItem(MOBILE_TOKEN_KEY)
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getMobileToken()
  const extraHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {}
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), ...extraHeaders },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}
