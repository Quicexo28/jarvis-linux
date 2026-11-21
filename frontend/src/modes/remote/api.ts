/**
 * Remote-app API seam. Everything the phone talks to lives here so the tabs
 * stay presentational.
 *
 * Remote-machine ops go through /api/agents/control (token-gated, read-only
 * allowlist) and NOT /api/agents/rpc, which is local-only by design because it
 * can spawn processes on another machine.
 */
import { request, getApiBase, getMobileToken } from '../../api/client'

export type Machine = {
  name: string
  os: string | null
  agent_version: string | null
  capabilities: string[]
  online: boolean
  /** This laptop, answered by the backend itself (no agent, no hub). */
  local?: boolean
  /** Human name to show; `name` stays the address ops are sent to. */
  label?: string
}

export type MachinesResponse = {
  ok: boolean
  machines: Machine[]
  hub: 'online' | 'offline'
  execUnlocked: boolean
}

export type SysInfo = {
  cpu_percent: number
  mem_used_mb: number
  mem_total_mb: number
  disk_used_gb: number
  disk_total_gb: number
  uptime_secs: number
  hostname: string
}

export type RemoteProcess = { pid: number; name: string; cpu_percent: number; mem_mb: number }
export type SearchHit = { path: { raw: string; os: string }; size_bytes: number | null; is_dir: boolean }

type Envelope<T> = { ok: boolean; error?: string; result?: T & { status: string; message?: string; denied?: boolean } }

/** One typed op on a remote machine. Throws with a Spanish message on failure. */
async function control<T>(machine: string, op: Record<string, unknown>): Promise<T> {
  const res = await request<Envelope<T>>('/api/agents/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine, op }),
  })
  if (!res.ok) {
    const map: Record<string, string> = {
      machine_offline: 'La máquina no está conectada.',
      timeout: 'La máquina no respondió a tiempo.',
      hub_unreachable: 'El hub de agentes está apagado.',
      op_not_allowed: 'Operación no permitida en remoto.',
      no_macs_known: 'No hay MAC conocida para encenderla.',
    }
    throw new Error(map[res.error ?? ''] ?? res.error ?? 'Error desconocido.')
  }
  if (res.result?.status === 'error') throw new Error(res.result.message ?? 'La máquina devolvió un error.')
  return res.result as T
}

export function listMachines(): Promise<MachinesResponse> {
  return request<MachinesResponse>('/api/agents/list')
}

export function machineSysInfo(machine: string): Promise<SysInfo> {
  return control<SysInfo>(machine, { op: 'sys_info' })
}

export async function machineProcesses(machine: string): Promise<RemoteProcess[]> {
  const r = await control<{ processes: RemoteProcess[] }>(machine, { op: 'list_processes' })
  return r.processes ?? []
}

export async function machineSearch(machine: string, query: string, maxResults = 25): Promise<SearchHit[]> {
  const r = await control<{ hits: SearchHit[] }>(machine, {
    op: 'search',
    params: { query, root: null, max_results: maxResults },
  })
  return r.hits ?? []
}

/** Wake-on-LAN. Only reaches machines on the laptop's own LAN (magic packets don't route). */
export async function machineWake(machine: string): Promise<number> {
  const r = await request<{ ok: boolean; sent?: number; error?: string }>('/api/agents/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine, op: { op: 'wake' } }),
  })
  if (!r.ok) throw new Error(r.error === 'no_macs_known' ? 'No hay MAC conocida para encenderla.' : 'No se pudo enviar el paquete.')
  return r.sent ?? 0
}

/* ----- RGB (setup) ----- */

/** Targets rgb_ctl.py accepts; the desktop GUI splits further, the CLI does not. */
export type RgbTarget = 'all' | 'pc' | 'keyboard'

/** `brightness` = keyboard hardware level 1-5 (Jarvis RGB); the PC side dims via `color`. */
export function rgbSet(color: string, target: RgbTarget = 'all', brightness?: number): Promise<unknown> {
  return request('/api/skills/rgb/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color, target, ...(brightness != null ? { brightness } : {}) }),
  })
}

export function rgbPreset(name: string): Promise<unknown> {
  return request('/api/skills/rgb/preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** Last colour applied by ANYONE (this app, voice, or the GUI on main). */
export type RgbState = { color: string; kb_brightness?: number; source?: string; ts?: number }

export async function rgbState(): Promise<RgbState | null> {
  const r = await request<{ ok: boolean; state: RgbState | null }>('/api/skills/rgb/state')
  return r.state ?? null
}

export async function rgbPresets(): Promise<string[]> {
  const r = await request<{ ok: boolean; presets?: string[] }>('/api/skills/rgb/presets')
  return r.presets ?? []
}

/* ----- escritorio remoto ----- */

/**
 * pc-remote y Sunshine corren fuera de Jarvis, cada uno en su puerto. El
 * backend arma la URL porque el token de pc-remote vive en su propia config y
 * el nombre del tailnet en tailscaled — la app no puede deducir ninguno.
 */
export type SunshineHost = {
  /** Nombre para enseñar; `host` es la dirección a la que se apunta Moonlight. */
  name: string
  host: string
  self: boolean
  /** Solo se sabe del portátil (se lee de disco); null en las demás. */
  paired: number | null
  running?: boolean
}

export type RemoteDesktop = {
  ok: boolean
  pcRemote: { running: boolean; url: string | null; reason?: string }
  moonlight: { running: boolean; host: string | null; paired: number }
  sunshine: SunshineHost[]
}

export function remoteDesktop(): Promise<RemoteDesktop> {
  return request<RemoteDesktop>('/api/skills/desktop/remote')
}

/** Teclea el PIN de Moonlight en la UI web de Sunshine de esa máquina. */
export async function pairMoonlight(host: string, pin: string, name: string): Promise<void> {
  const res = await request<{ ok: boolean; error?: string }>('/api/skills/desktop/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, pin, name }),
  })
  if (!res.ok) {
    const map: Record<string, string> = {
      bad_pin: 'El PIN son 4 dígitos.',
      pin_rejected: 'Sunshine rechazó el PIN. Pide uno nuevo en Moonlight.',
      unknown_host: 'Esa máquina ya no aparece emitiendo.',
      sunshine_unreachable: 'No se pudo hablar con Sunshine.',
      sunshine_creds_missing: 'Faltan las credenciales de Sunshine en el backend.',
    }
    throw new Error(map[res.error ?? ''] ?? 'No se pudo emparejar.')
  }
}

/* ----- mando del PC (acciones directas, sin pasar por el modelo) ----- */

/**
 * Las rutas de escritorio responden 404/502 con un `detail` en español que
 * vale la pena enseñar ("No hay nada reproduciendo"); `request` lo tiraría
 * por un "HTTP 404" genérico, así que aquí se lee el cuerpo siempre.
 */
async function desk<T>(path: string, payload: Record<string, unknown>): Promise<T & { ok: boolean; detail?: string }> {
  const token = getMobileToken()
  const res = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  })
  let data: (T & { ok: boolean; detail?: string }) | null = null
  try { data = await res.json() } catch { /* cuerpo vacío */ }
  if (!data) throw new Error(`Sin respuesta (HTTP ${res.status}).`)
  if (!data.ok) throw new Error(data.detail ?? 'No se pudo.')
  return data
}

export type MediaState = { player: string; status: string; artist: string; title: string }
export type MediaAction = 'status' | 'toggle' | 'next' | 'previous'
export const media = (action: MediaAction) => desk<MediaState>('/api/skills/system/media', { action })

export type VolumeState = { level: number | null; muted: boolean }
export const volume = (action: 'get' | 'up' | 'down' | 'toggle' | 'set', value?: number) =>
  desk<VolumeState>('/api/skills/system/volume', { action, ...(value != null ? { value } : {}) })

export type PcWindow = { class: string; title: string; workspace?: string; address: string }
export async function listWindows(): Promise<PcWindow[]> {
  return (await desk<{ windows: PcWindow[] }>('/api/skills/system/window', { action: 'list' })).windows ?? []
}
export const windowAction = (action: 'focus' | 'close', address: string) =>
  desk('/api/skills/system/window', { action, address })
export const gotoWorkspace = (workspace: number) =>
  desk('/api/skills/system/window', { action: 'workspace', workspace })

export const clipboardGet = () => desk<{ text: string; mime?: string; empty?: boolean }>('/api/skills/system/clipboard', { action: 'get' })
export const clipboardSet = (text: string) => desk('/api/skills/system/clipboard', { action: 'set', text })

export const dnd = (action: 'status' | 'toggle') => desk<{ active: boolean }>('/api/skills/system/dnd', { action })

/* ----- conversation + home ----- */

export type TurnReply = {
  reply: string
  /** The risk gate refused a tool this turn: offer fingerprint + password and resend. */
  authRequired: { risk: string; reason: string } | null
  elevated: boolean
}

/** `elevation` = one-shot ticket from elevate(); authorises exactly this turn. */
export async function sendTurn(message: string, elevation?: string): Promise<TurnReply> {
  const res = await postJson<{ ok: boolean; reply?: string; authRequired?: TurnReply['authRequired']; elevated?: boolean }>(
    '/api/jarvis/turn', { message, context: { source: 'mobile' }, ...(elevation ? { elevation } : {}) },
  )
  if (!res.ok && !res.reply) throw new Error('turn_failed')
  return { reply: res.reply ?? '...', authRequired: res.authRequired ?? null, elevated: !!res.elevated }
}

/* ----- step-up authorisation for risky actions (backend lib/riskAuth.js) ----- */

/**
 * POST that returns the JSON body even on 4xx: the elevate endpoints answer
 * 401/409/429 with a Spanish `message`, which `request` would throw away.
 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const token = getMobileToken()
  const res = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  try { return await res.json() as T } catch { throw new Error(`HTTP ${res.status}`) }
}

type ElevateResult = { ok: boolean; error?: string; message?: string }

export const elevateStatus = (publicKey: string) =>
  postJson<{ configured: boolean; enrolled: boolean; locked: boolean }>('/api/jarvis/elevate/status', { publicKey })

export const elevateEnroll = (publicKey: string, password: string, label: string) =>
  postJson<ElevateResult>('/api/jarvis/elevate/enroll', { publicKey, password, label })

export const elevateChallenge = () =>
  postJson<{ ok: boolean; challenge: string }>('/api/jarvis/elevate/challenge', {})

export const elevate = (publicKey: string, challenge: string, signature: string, password: string) =>
  postJson<ElevateResult & { ticket?: string }>('/api/jarvis/elevate', { publicKey, challenge, signature, password })

/* ----- ambient context ----- */

export type CtxDevice = {
  battery?: { level: number; charging: boolean; ts: string }
  location?: { lat: number; lon: number; place?: string | null; ts: string }
  presence?: { foreground: boolean; ts: string }
}

export type CtxCurrent = {
  ok: boolean
  current: CtxDevice
  devices: Record<string, CtxDevice>
}

export function ctxCurrent(): Promise<CtxCurrent> {
  return request<CtxCurrent>('/api/mobile/ctx/current')
}

export function postCtx(path: 'location' | 'presence' | 'battery', body: Record<string, unknown>): Promise<unknown> {
  return request(`/api/mobile/ctx/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
