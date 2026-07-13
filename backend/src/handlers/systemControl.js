import { execFile } from 'child_process'
import { json, readBody } from '../lib/http.js'

// Control de sistema de alto nivel para el brain de voz en Linux (CachyOS/Arch,
// Hyprland, PipeWire). run_terminal ya permite cualquier comando, pero estos
// endpoints dan verbos seguros y validados que la voz puede invocar sin que el
// brain tenga que adivinar el comando exacto ni exponer shell arbitrario.
//
//   power      → poweroff / reboot / suspend / lock / logout
//   volume     → up / down / set / mute / unmute / toggle / get   (pamixer)
//   bluetooth  → status / devices / scan / connect / disconnect / on / off
//   process    → list (top CPU) / kill (por nombre, protege críticos)

const SINK = '@DEFAULT_AUDIO_SINK@'

async function body(req) {
  try {
    return (await readBody(req)) || {}
  } catch {
    return null
  }
}

// Promesa fina sobre execFile: nunca rechaza, devuelve { code, stdout, stderr }.
function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: process.env }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0)
      resolve({
        code,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim() || (err && code !== 0 ? err.message : ''),
      })
    })
  })
}

// --- power -------------------------------------------------------------------
export async function handleSystemPower(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || '').trim().toLowerCase()

  const MAP = {
    off:      ['systemctl', ['poweroff']],
    poweroff: ['systemctl', ['poweroff']],
    apagar:   ['systemctl', ['poweroff']],
    reboot:   ['systemctl', ['reboot']],
    reiniciar:['systemctl', ['reboot']],
    suspend:  ['systemctl', ['suspend']],
    suspender:['systemctl', ['suspend']],
    lock:     ['loginctl', ['lock-session']],
    bloquear: ['loginctl', ['lock-session']],
    logout:   ['hyprctl', ['dispatch', 'exit']],
  }
  const spec = MAP[action]
  if (!spec) return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'usa off|reboot|suspend|lock|logout' })

  // Seguro: apagar/reiniciar son irreversibles y un falso positivo de voz puede
  // tumbar la sesión. Exigen confirm=true; sin él se pide confirmación verbal.
  const needsConfirm = /^(off|poweroff|apagar|reboot|reiniciar)$/.test(action)
  if (needsConfirm && b.confirm !== true) {
    const verbo = /reboot|reiniciar/.test(action) ? 'reiniciar' : 'apagar'
    return json(res, 200, {
      ok: false,
      needs_confirm: true,
      action,
      detail: `¿Seguro que quiere ${verbo} el equipo? Pídamelo otra vez con confirmación.`,
    })
  }

  const r = await run(spec[0], spec[1], 5000)
  // poweroff/reboot pueden cortar el proceso antes de responder; eso es éxito.
  const ok = r.code === 0 || /off|reboot|suspend/.test(action)
  return json(res, ok ? 200 : 502, {
    ok,
    action,
    detail: ok ? `${action} ejecutado` : (r.stderr || 'falló'),
  })
}

// --- volume ------------------------------------------------------------------
async function readVolume() {
  const v = await run('pamixer', ['--get-volume'])
  const m = await run('pamixer', ['--get-mute'])
  const level = parseInt(v.stdout, 10)
  return { level: Number.isFinite(level) ? level : null, muted: m.stdout === 'true' }
}

export async function handleSystemVolume(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || '').trim().toLowerCase()
  const step = Number.isFinite(b.step) ? Math.max(1, Math.min(50, b.step)) : 5

  let argv = null
  switch (action) {
    case 'up': case 'subir':       argv = ['--increase', String(step)]; break
    case 'down': case 'bajar':     argv = ['--decrease', String(step)]; break
    case 'mute': case 'silenciar': argv = ['--mute']; break
    case 'unmute':                 argv = ['--unmute']; break
    case 'toggle':                 argv = ['--toggle-mute']; break
    case 'set': case 'poner': {
      const val = Math.max(0, Math.min(100, parseInt(b.value, 10)))
      if (!Number.isFinite(val)) return json(res, 400, { ok: false, error: 'value_requerido', detail: '0-100' })
      argv = ['--set-volume', String(val)]
      break
    }
    case 'get': case '': {
      const st = await readVolume()
      return json(res, 200, { ok: true, ...st, detail: `Volumen ${st.level}%${st.muted ? ' (silenciado)' : ''}` })
    }
    default:
      return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'up|down|set|mute|unmute|toggle|get' })
  }

  const r = await run('pamixer', argv)
  const st = await readVolume()
  return json(res, r.code === 0 ? 200 : 502, {
    ok: r.code === 0,
    ...st,
    detail: r.code === 0 ? `Volumen ${st.level}%${st.muted ? ' (silenciado)' : ''}` : (r.stderr || 'falló'),
  })
}

// --- bluetooth ---------------------------------------------------------------
function parseDevices(raw) {
  // líneas: "Device AA:BB:CC:DD:EE:FF Nombre del equipo"
  return raw.split('\n').map((l) => {
    const m = l.match(/^Device\s+([0-9A-F:]{17})\s+(.*)$/i)
    return m ? { mac: m[1], name: m[2].trim() } : null
  }).filter(Boolean)
}

async function resolveTarget(target) {
  const t = String(target || '').trim()
  if (/^[0-9A-F:]{17}$/i.test(t)) return t // ya es MAC
  const paired = parseDevices((await run('bluetoothctl', ['devices'])).stdout)
  const tl = t.toLowerCase()
  const hit = paired.find((d) => d.name.toLowerCase().includes(tl))
  return hit ? hit.mac : null
}

export async function handleSystemBluetooth(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'status').trim().toLowerCase()

  if (action === 'status') {
    const show = (await run('bluetoothctl', ['show'])).stdout
    const powered = /Powered:\s*yes/i.test(show)
    return json(res, 200, { ok: true, powered, detail: `Bluetooth ${powered ? 'encendido' : 'apagado'}` })
  }
  if (action === 'on' || action === 'encender') {
    const r = await run('bluetoothctl', ['power', 'on'])
    return json(res, 200, { ok: r.code === 0, detail: 'Bluetooth encendido' })
  }
  if (action === 'off' || action === 'apagar') {
    const r = await run('bluetoothctl', ['power', 'off'])
    return json(res, 200, { ok: r.code === 0, detail: 'Bluetooth apagado' })
  }
  if (action === 'devices' || action === 'paired') {
    const devs = parseDevices((await run('bluetoothctl', ['devices'])).stdout)
    return json(res, 200, {
      ok: true, devices: devs,
      detail: devs.length ? `Emparejados: ${devs.map((d) => d.name).join(', ')}` : 'No hay dispositivos emparejados',
    })
  }
  if (action === 'scan' || action === 'buscar') {
    await run('bluetoothctl', ['--timeout', '8', 'scan', 'on'], 12000)
    const devs = parseDevices((await run('bluetoothctl', ['devices'])).stdout)
    return json(res, 200, {
      ok: true, devices: devs,
      detail: devs.length ? `Encontrados: ${devs.map((d) => d.name).join(', ')}` : 'No se encontraron dispositivos',
    })
  }
  if (action === 'connect' || action === 'conectar' || action === 'disconnect' || action === 'desconectar') {
    const mac = await resolveTarget(b.target)
    if (!mac) return json(res, 404, { ok: false, error: 'dispositivo_no_encontrado', detail: `No hallé "${b.target}" entre los emparejados` })
    const verb = /(connect|conectar)/.test(action) ? 'connect' : 'disconnect'
    const r = await run('bluetoothctl', [verb, mac], 15000)
    const ok = r.code === 0 && /successful|Connected: yes|Connected: no/i.test(r.stdout)
    return json(res, ok ? 200 : 502, {
      ok, mac,
      detail: ok ? `${verb === 'connect' ? 'Conectado a' : 'Desconectado de'} ${b.target}` : (r.stdout || r.stderr || 'falló'),
    })
  }
  return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'status|devices|scan|connect|disconnect|on|off' })
}

// --- process -----------------------------------------------------------------
// Nunca matar: PID bajos, init/WM/sesión, ni el propio Jarvis.
const PROTECTED = /^(systemd|init|hyprland|Hyprland|wayland|pipewire|wireplumber|dbus|dbus-daemon|sshd|login|gdm|sddm|getty|node|jarvis|claude|seatd|polkitd|gnome-keyring)/i

export async function handleSystemProcess(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'list').trim().toLowerCase()

  if (action === 'list' || action === 'listar') {
    const r = await run('ps', ['-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu'])
    const lines = r.stdout.split('\n')
    const top = lines.slice(1, 13).map((l) => {
      const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/)
      return m ? { pid: +m[1], cpu: +m[2], mem: +m[3], name: m[4] } : null
    }).filter(Boolean)
    return json(res, 200, {
      ok: true, processes: top,
      detail: `Top CPU: ${top.slice(0, 5).map((p) => `${p.name} (${p.cpu}%)`).join(', ')}`,
    })
  }

  if (action === 'kill' || action === 'matar' || action === 'cerrar') {
    const name = String(b.name || '').trim()
    if (!name) return json(res, 400, { ok: false, error: 'name_requerido' })

    // resolver PIDs que coincidan por nombre/cmdline
    const pg = await run('pgrep', ['-fi', name])
    const pids = pg.stdout.split('\n').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 1000)
    if (!pids.length) return json(res, 404, { ok: false, error: 'proceso_no_encontrado', detail: `No hay proceso "${name}"` })

    const killed = []
    const skipped = []
    for (const pid of pids) {
      const comm = (await run('ps', ['-p', String(pid), '-o', 'comm='])).stdout
      if (PROTECTED.test(comm)) { skipped.push(comm); continue }
      const r = await run('kill', ['-TERM', String(pid)])
      if (r.code === 0) killed.push(comm || pid)
    }
    if (!killed.length) {
      return json(res, 403, { ok: false, error: 'protegido', detail: `No cerré nada (procesos protegidos: ${skipped.join(', ') || 'ninguno'})` })
    }
    return json(res, 200, {
      ok: true, killed, skipped,
      detail: `Cerrado: ${killed.join(', ')}${skipped.length ? `. Protegidos omitidos: ${skipped.join(', ')}` : ''}`,
    })
  }
  return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'list|kill' })
}
