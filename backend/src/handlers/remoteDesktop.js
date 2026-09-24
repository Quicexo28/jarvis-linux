/**
 * Enlace entre la app remota y los dos escritorios remotos que corren aparte
 * de Jarvis: `pc-remote` (~/pc-remote, streaming H.264 sobre WebSocket, puerto
 * propio) y Sunshine (para Moonlight, sobre UDP).
 *
 * La app no puede construir la URL de pc-remote sola: el token vive en la
 * config de pc-remote y el nombre del tailnet en tailscaled. Esto los junta y
 * de paso dice cual de los dos esta vivo, que es la mitad de la decision —
 * pc-remote aguanta bien en wifi y Moonlight es el que sobrevive a los datos
 * moviles.
 *
 * Alcance: devolver la URL CON token entrega control del escritorio a quien
 * tenga el token web de Jarvis. No abre una puerta nueva (el chat de la app ya
 * habla con el cerebro, que si tiene herramientas de sistema), pero es la
 * razon de que esto no sea publico y siga detras de `requireAuth`.
 */

import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { json, readBody } from '../lib/http.js'
import { getTailscaleHostname, getTailscaleIp } from '../lib/tailscale.js'

const run = promisify(execFile)

const PC_REMOTE_CONFIG = path.join(os.homedir(), '.config', 'pc-remote', 'config.json')
const SUNSHINE_STATE = path.join(os.homedir(), '.config', 'sunshine', 'sunshine_state.json')
const SUNSHINE_UNIT = 'app-dev.lizardbyte.app.Sunshine.service'

/** `systemctl is-active` sale con codigo != 0 cuando el servicio no corre. */
async function unitActive(unit) {
  try {
    const { stdout } = await run('systemctl', ['--user', 'is-active', unit], { timeout: 2000 })
    return stdout.trim() === 'active'
  } catch {
    return false
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function pcRemoteInfo(hostname) {
  const running = await unitActive('pc-remote.service')
  const cfg = await readJson(PC_REMOTE_CONFIG)
  if (!cfg?.token) return { running, url: null, reason: 'sin config de pc-remote' }
  // El puerto por hostname, no por IP: el cert de `tailscale cert` solo vale
  // para el nombre del tailnet.
  if (!hostname) return { running, url: null, reason: 'tailscale sin MagicDNS' }
  const port = cfg.port ?? 8444
  return { running, url: `https://${hostname}:${port}/?t=${encodeURIComponent(cfg.token)}` }
}

/**
 * Clientes emparejados segun el fichero de estado.
 *
 * La clave es `named_devices`; `devices` (que es lo que parecia obvio) no
 * existe en este Sunshine y hacia que la app dijera SIEMPRE «0 emparejados»
 * con clientes ya emparejados delante. Se deja el nombre viejo de reserva por
 * si otra version lo usa.
 */
function pairedCount(state) {
  const root = state?.root
  return root?.named_devices?.length ?? root?.devices?.length ?? 0
}

async function moonlightInfo(ip) {
  const running = await unitActive(SUNSHINE_UNIT)
  // El fichero de estado no existe hasta el primer emparejamiento.
  const state = await readJson(SUNSHINE_STATE)
  const paired = pairedCount(state)
  return { running, host: ip, paired }
}

/* --------------------------------------------------------- hosts Sunshine */

const SUNSHINE_WEB_PORT = 47990
const SUNSHINE_HTTP_PORT = 47989

/**
 * El UUID con el que Moonlight identifica a esta máquina.
 *
 * Moonlight no tiene esquema de URL, pero su `ShortcutTrampoline` (el de sus
 * propios accesos directos) acepta un extra `UUID`, y ese UUID es el `uniqueid`
 * que el host publica en `serverinfo` — el mismo campo que Moonlight guardó al
 * emparejarse. Se pide por el puerto HTTP (47989), que responde sin cert de
 * cliente, así el widget de la tablet puede entrar directo a la máquina en vez
 * de abrir la lista de PCs. Best-effort: sin UUID el widget abre la lista.
 */
async function sunshineUuid(host, port = SUNSHINE_HTTP_PORT) {
  try {
    const res = await fetch(`http://${host}:${port}/serverinfo`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const xml = await res.text()
    return xml.match(/<uniqueid>([^<]+)<\/uniqueid>/i)?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** El nombre que la instancia se da a si misma (`sunshine_name`). */
async function sunshineName(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/serverinfo`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return (await res.text()).match(/<hostname>([^<]+)<\/hostname>/i)?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** Alias hostname-de-tailnet -> nombre que usa el usuario, via env (JSON). */
function aliases() {
  try {
    return JSON.parse(process.env.JARVIS_SUNSHINE_ALIASES ?? '{}')
  } catch {
    return {}
  }
}

/**
 * ¿Hay algo escuchando en el puerto de la UI web de Sunshine?
 *
 * Un TCP a pelo y no la API: responder el saludo TLS ya prueba que Sunshine
 * esta arriba, y ahorra montar el cliente HTTPS contra su cert autofirmado en
 * cada sondeo (esto se llama cada 30 s desde la app).
 */
function portOpen(host, port, timeout = 900) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, host)
  })
}

/** Peers del tailnet, que es donde viven las maquinas que se pueden emitir. */
async function tailnetPeers() {
  try {
    const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 })
    const status = JSON.parse(stdout)
    return Object.values(status.Peer ?? {})
      .filter((p) => p.Online && p.TailscaleIPs?.length)
      .map((p) => ({ name: p.HostName, ip: p.TailscaleIPs[0] }))
  } catch {
    return []
  }
}

/**
 * Todas las maquinas del tailnet que pueden emitir por Moonlight.
 *
 * Se descubren sondeando el puerto, no con una lista fija: el hub conoce a los
 * agentes por su nombre de agente ("main") y el tailnet por su hostname
 * ("santiago"), y no hay forma de casarlos sin inventarse un mapeo. Quien
 * conteste en 47990 tiene Sunshine, y con eso basta para ofrecerlo.
 */
async function sunshineHosts(selfIp) {
  const alias = aliases()
  const peers = await tailnetPeers()
  const probes = await Promise.all(peers.map((p) => portOpen(p.ip, SUNSHINE_WEB_PORT)))

  const hosts = peers
    .filter((_, i) => probes[i])
    .map((p) => ({ name: alias[p.name] ?? p.name, host: p.ip, self: false, paired: null }))

  // El portatil se conoce a si mismo mejor que por un sondeo: lee su unidad y
  // su estado de emparejamiento del disco.
  if (selfIp) {
    const state = await readJson(SUNSHINE_STATE)
    hosts.unshift({
      name: process.env.JARVIS_LOCAL_LABEL ?? 'Jarvis Main',
      host: selfIp,
      self: true,
      paired: pairedCount(state),
      running: await unitActive(SUNSHINE_UNIT),
    })
  }

  // En paralelo: son sondeos independientes de 1.5 s como techo, y en serie
  // sumarían al tiempo de una pantalla que la app abre cada 30 s.
  // Instancias locales EXTRA (una por puerto en `JARVIS_SUNSHINE_EXTRA`).
  //
  // Existen porque una sola instancia no puede emitir dos pantallas: la
  // principal manda la salida headless `projmap` (la pared del proyector) y
  // desde ese stream NO se puede operar el PC, que es un monitor distinto. La
  // segunda emite `eDP-1`. Sunshine deriva todos sus puertos de `port`, asi que
  // basta desplazar la base; aqui solo hace falta saber cual es.
  for (const raw of (process.env.JARVIS_SUNSHINE_EXTRA ?? '').split(',')) {
    const port = Number(raw.trim())
    if (!port || !selfIp) continue
    const name = await sunshineName(selfIp, port)
    hosts.push({ name: name ?? `Sunshine :${port}`, host: selfIp, self: true, httpPort: port, webPort: port + 1, paired: null })
  }

  const uuids = await Promise.all(hosts.map((h) => sunshineUuid(h.host, h.httpPort ?? SUNSHINE_HTTP_PORT)))
  hosts.forEach((h, i) => { h.uuid = uuids[i] })
  return hosts
}

/** GET /api/skills/desktop/remote */
export async function handleRemoteDesktop(_req, res) {
  const [hostname, ip] = await Promise.all([getTailscaleHostname(), getTailscaleIp()])
  const [pcRemote, moonlight, sunshine] = await Promise.all([
    pcRemoteInfo(hostname),
    moonlightInfo(ip),
    sunshineHosts(ip),
  ])
  return json(res, 200, { ok: true, pcRemote, moonlight, sunshine })
}

/**
 * POST /api/skills/desktop/pair  { host, pin, name }
 *
 * Moonlight pide un PIN y hay que teclearlo en la UI web de Sunshine de la
 * maquina que emite. Esto lo hace por el usuario para que no tenga que abrir
 * una UI distinta (y con cert autofirmado) desde la tablet.
 *
 * `host` se valida contra la lista descubierta: el backend firma la peticion
 * con las credenciales de Sunshine, asi que aceptar un host arbitrario seria
 * regalarselas a quien pida.
 */
export async function handleDesktopPair(req, res) {
  const user = process.env.SUNSHINE_USER
  const pass = process.env.SUNSHINE_PASS
  if (!user || !pass) return json(res, 500, { ok: false, error: 'sunshine_creds_missing' })

  let body
  try {
    body = await readBody(req)  // ya devuelve el objeto, no el texto
  } catch {
    return json(res, 400, { ok: false, error: 'bad_json' })
  }

  const pin = String(body?.pin ?? '').trim()
  if (!/^\d{4}$/.test(pin)) return json(res, 400, { ok: false, error: 'bad_pin' })

  const selfIp = await getTailscaleIp()
  const hosts = await sunshineHosts(selfIp)
  // Con dos instancias en la MISMA IP el host ya no es unico: se desempata por
  // puerto para no mandar el PIN a la pantalla equivocada.
  const wanted = Number(body?.httpPort ?? 0)
  const target = hosts.find((h) => h.host === body?.host && (!wanted || (h.httpPort ?? SUNSHINE_HTTP_PORT) === wanted))
  if (!target) return json(res, 400, { ok: false, error: 'unknown_host' })

  const payload = JSON.stringify({ pin, name: String(body?.name ?? 'Jarvis').slice(0, 40) })
  try {
    // curl y no fetch: el cert de Sunshine es autofirmado y `-k` es una bandera
    // en vez de un dispatcher undici a medida.
    const { stdout } = await run('curl', [
      '-sk', '--max-time', '10',
      '-u', `${user}:${pass}`,
      '-H', 'Content-Type: application/json',
      '-d', payload,
      `https://${target.host}:${target.webPort ?? SUNSHINE_WEB_PORT}/api/pin`,
    ], { timeout: 12000 })
    const ok = /"status"\s*:\s*"?true"?/i.test(stdout)
    // Con dos maquinas emitiendo, el fallo tipico es mandar el PIN a la que NO
    // tiene el emparejamiento pendiente. Sin dejar rastro de a QUIEN se envio
    // eso es indistinguible de un PIN mal escrito.
    console.log(`[desktop/pair] ${target.name} (${target.host}) -> ${ok ? 'ok' : 'rechazado'} · respuesta: ${stdout.slice(0, 200)}`)
    return json(res, ok ? 200 : 400, { ok, error: ok ? undefined : 'pin_rejected', machine: target.name })
  } catch (e) {
    console.log(`[desktop/pair] ${target.name} (${target.host}) -> error: ${e.message}`)
    return json(res, 502, { ok: false, error: 'sunshine_unreachable', detail: e.message })
  }
}
