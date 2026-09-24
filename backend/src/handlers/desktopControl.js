import { execFile, spawn } from 'child_process'
import { json, readBody } from '../lib/http.js'

// Verbos de escritorio para la voz (Hyprland + Wayland + MPRIS + mako). Mismo
// criterio que systemControl.js: el modelo podría hacer todo esto con
// run_terminal, pero entonces adivina el comando, lo pasa por el gate
// destructivo (run_terminal lo es) y lee salida cruda. Con un verbo dedicado
// la orden cotidiana ("pausa la música", "copia esto") es una llamada fiable.
//
//   clipboard → get / set                                   (wl-paste / wl-copy)
//   media     → status / play / pause / toggle / next / previous   (playerctl)
//   window    → list / active / focus / workspace / move / close / fullscreen (hyprctl)
//   dnd       → on / off / toggle / status                  (makoctl mode)

const CLIP_MAX = 4000

// La ventana de Jarvis (class=jarvis, ver hyprland-jarvis.conf) la mueve el
// propio Tauri con hyprctl en cada wake/sleep; cerrarla o moverla desde aquí
// la dejaría en un sitio que el frontend no sabe (misma carrera que la
// windowrule). Por eso no se toca.
const PROTECTED_CLASS = /^jarvis$/i

async function body(req) {
  try {
    return (await readBody(req)) || {}
  } catch {
    return null
  }
}

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: process.env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0)
      resolve({
        code,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim() || (err && code !== 0 ? err.message : ''),
      })
    })
  })
}

// --- clipboard ---------------------------------------------------------------

// wl-copy se bifurca y su hijo se queda sirviendo la selección. Con execFile
// ese hijo hereda las tuberías de stdout/stderr y la promesa esperaría hasta el
// timeout; por eso se ignoran y se resuelve con 'exit' del padre, no 'close'.
function wlCopy(text) {
  return new Promise((resolve) => {
    const p = spawn('wl-copy', [], { env: process.env, stdio: ['pipe', 'ignore', 'ignore'] })
    const t = setTimeout(() => { p.kill(); resolve(false) }, 3000)
    p.on('error', () => { clearTimeout(t); resolve(false) })
    p.on('exit', (code) => { clearTimeout(t); resolve(code === 0) })
    p.stdin.end(text)
  })
}

export async function handleClipboard(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'get').trim().toLowerCase()

  if (action === 'get') {
    const types = await run('wl-paste', ['--list-types'])
    if (types.code !== 0) return json(res, 200, { ok: true, empty: true, text: '', detail: 'El portapapeles está vacío' })
    if (!/^text\//m.test(types.stdout) && !/UTF8_STRING|STRING/m.test(types.stdout)) {
      const kind = types.stdout.split('\n')[0] || 'desconocido'
      return json(res, 200, { ok: true, text: '', mime: kind, detail: `El portapapeles contiene ${kind}, no texto` })
    }
    const r = await run('wl-paste', ['--no-newline', '--type', 'text'])
    if (r.code !== 0) return json(res, 502, { ok: false, error: 'wl_paste', detail: r.stderr })
    const truncated = r.stdout.length > CLIP_MAX
    return json(res, 200, {
      ok: true,
      text: truncated ? r.stdout.slice(0, CLIP_MAX) : r.stdout,
      length: r.stdout.length,
      truncated,
    })
  }

  if (action === 'set') {
    const text = typeof b.text === 'string' ? b.text : ''
    if (!text) return json(res, 400, { ok: false, error: 'text_requerido' })
    const ok = await wlCopy(text)
    return json(res, ok ? 200 : 502, {
      ok,
      length: text.length,
      detail: ok ? `Copiado al portapapeles (${text.length} caracteres)` : 'wl-copy falló',
    })
  }
  return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'get|set' })
}

// --- media -------------------------------------------------------------------

/**
 * Elige el reproductor al que va la orden. playerctl a secas agarra el
 * PRIMERO de la lista, y aquí la lista la encabezan los proxies MPRIS de
 * KDE Connect (el móvil y la tablet): "pausa la música" pausaba el teléfono.
 * Orden: local sonando > local cualquiera > remoto sonando > remoto.
 * @param {{name:string,status:string}[]} players
 * @returns {string|null}
 */
export function pickPlayer(players) {
  if (!players.length) return null
  const remote = (p) => /^kdeconnect/i.test(p.name)
  const playing = (p) => /playing/i.test(p.status)
  const rank = (p) => (remote(p) ? 2 : 0) + (playing(p) ? 0 : 1)
  return [...players].sort((a, b) => rank(a) - rank(b))[0].name
}

async function listPlayers() {
  const l = await run('playerctl', ['--list-all'])
  if (l.code !== 0) return []
  const names = l.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  return Promise.all(names.map(async (name) => ({
    name,
    status: (await run('playerctl', ['-p', name, 'status'])).stdout,
  })))
}

async function playerInfo(name) {
  const r = await run('playerctl', ['-p', name, 'metadata', '--format', '{{status}}\t{{artist}}\t{{title}}'])
  const [status = '', artist = '', title = ''] = r.stdout.split('\t')
  return { player: name, status, artist, title }
}

const MEDIA_VERBS = {
  play: 'play', pause: 'pause', toggle: 'play-pause', next: 'next', previous: 'previous',
}

export async function handleMedia(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'status').trim().toLowerCase()
  if (action !== 'status' && !MEDIA_VERBS[action]) {
    return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'status|play|pause|toggle|next|previous' })
  }

  const players = await listPlayers()
  const wanted = String(b.player || '').trim().toLowerCase()
  const name = wanted
    ? (players.find((p) => p.name.toLowerCase().includes(wanted)) || {}).name
    : pickPlayer(players)
  if (!name) return json(res, 404, { ok: false, error: 'sin_reproductor', detail: 'No hay nada reproduciendo ni ningún reproductor abierto' })

  if (action !== 'status') {
    const r = await run('playerctl', ['-p', name, MEDIA_VERBS[action]])
    if (r.code !== 0) return json(res, 502, { ok: false, error: 'playerctl', detail: r.stderr })
    // El cambio de pista tarda un instante en reflejarse en los metadatos.
    if (action === 'next' || action === 'previous') await new Promise((r2) => setTimeout(r2, 400))
  }
  const info = await playerInfo(name)
  const what = [info.title, info.artist].filter(Boolean).join(' — ')
  return json(res, 200, {
    ok: true,
    ...info,
    players: players.map((p) => p.name),
    detail: `${info.status || 'Sin estado'}${what ? `: ${what}` : ''}`,
  })
}

// --- windows -----------------------------------------------------------------

function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Busca la ventana que el señor nombró. Primero por clase (lo que suele decir:
 * "firefox", "kitty"), luego por título. Entre varias, la más reciente en foco
 * (focusHistoryID menor), que es la que tiene en mente.
 * @param {object[]} clients  salida de `hyprctl clients -j`
 * @param {string} target
 */
export function matchWindow(clients, target) {
  const t = normalize(target).trim()
  if (!t) return null
  const usable = clients.filter((c) => c.mapped !== false && c.class)
  const byRecency = (a, b) => (a.focusHistoryID ?? 99) - (b.focusHistoryID ?? 99)
  const byClass = usable.filter((c) => normalize(c.class).includes(t) || normalize(c.initialClass).includes(t))
  if (byClass.length) return byClass.sort(byRecency)[0]
  const byTitle = usable.filter((c) => normalize(c.title).includes(t))
  return byTitle.length ? byTitle.sort(byRecency)[0] : null
}

function summarize(c) {
  return { class: c.class, title: String(c.title || '').slice(0, 80), workspace: c.workspace?.name, address: c.address }
}

async function clients() {
  const r = await run('hyprctl', ['clients', '-j'])
  try { return JSON.parse(r.stdout) } catch { return [] }
}

async function dispatch(...args) {
  const r = await run('hyprctl', ['dispatch', ...args])
  // hyprctl devuelve 0 aunque el dispatcher falle; el error va en stdout.
  const ok = r.code === 0 && !/^(err|invalid)/i.test(r.stdout)
  return { ok, detail: r.stdout || r.stderr }
}

function workspaceArg(v) {
  const s = String(v ?? '').trim()
  if (/^\d+$/.test(s)) return s
  if (/^[+-]\d+$/.test(s)) return `e${s}`
  if (/^[a-z0-9_-]{1,24}$/i.test(s)) return `name:${s}`
  return null
}

export async function handleWindow(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  const action = String(b.action || 'list').trim().toLowerCase()

  if (action === 'list') {
    const list = (await clients()).filter((c) => c.mapped !== false && c.class && !PROTECTED_CLASS.test(c.class))
    return json(res, 200, {
      ok: true,
      windows: list.map(summarize),
      detail: list.map((c) => `${c.class} (escritorio ${c.workspace?.name})`).join(', ') || 'No hay ventanas abiertas',
    })
  }
  if (action === 'active') {
    const r = await run('hyprctl', ['activewindow', '-j'])
    let c = null
    try { c = JSON.parse(r.stdout) } catch { /* sin ventana activa */ }
    if (!c || !c.class) return json(res, 200, { ok: true, window: null, detail: 'No hay ventana enfocada' })
    return json(res, 200, { ok: true, window: summarize(c), detail: `${c.class}: ${c.title}` })
  }
  if (action === 'workspace') {
    const ws = workspaceArg(b.workspace)
    if (!ws) return json(res, 400, { ok: false, error: 'workspace_requerido' })
    const d = await dispatch('workspace', ws)
    return json(res, d.ok ? 200 : 502, { ok: d.ok, detail: d.ok ? `Escritorio ${b.workspace}` : d.detail })
  }
  if (action === 'fullscreen') {
    const d = await dispatch('fullscreen', '0')
    return json(res, d.ok ? 200 : 502, { ok: d.ok, detail: d.ok ? 'Pantalla completa alternada' : d.detail })
  }

  if (action === 'focus' || action === 'move' || action === 'close') {
    const target = String(b.target || '').trim()
    let win = null
    if (target) {
      win = matchWindow(await clients(), target)
      if (!win) return json(res, 404, { ok: false, error: 'ventana_no_encontrada', detail: `No hay ninguna ventana de "${target}"` })
    } else if (action !== 'focus') {
      const r = await run('hyprctl', ['activewindow', '-j'])
      try { win = JSON.parse(r.stdout) } catch { /* nada */ }
      if (!win || !win.class) return json(res, 404, { ok: false, error: 'sin_ventana', detail: 'No hay ventana enfocada' })
    } else {
      return json(res, 400, { ok: false, error: 'target_requerido' })
    }
    if (action !== 'focus' && PROTECTED_CLASS.test(win.class)) {
      return json(res, 403, { ok: false, error: 'protegida', detail: 'La ventana de Jarvis la gestiona el propio Jarvis' })
    }
    const sel = `address:${win.address}`
    let d
    if (action === 'focus') d = await dispatch('focuswindow', sel)
    else if (action === 'close') d = await dispatch('closewindow', sel)
    else {
      const ws = workspaceArg(b.workspace)
      if (!ws) return json(res, 400, { ok: false, error: 'workspace_requerido' })
      d = await dispatch('movetoworkspacesilent', `${ws},${sel}`)
    }
    const verb = { focus: 'Enfocada', close: 'Cerrada', move: `Movida al escritorio ${b.workspace}` }[action]
    return json(res, d.ok ? 200 : 502, { ok: d.ok, window: summarize(win), detail: d.ok ? `${verb}: ${win.class}` : d.detail })
  }
  return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'list|active|focus|workspace|move|close|fullscreen' })
}

// --- do not disturb ----------------------------------------------------------

const DND_MODE = 'do-not-disturb'

async function dndActive() {
  const r = await run('makoctl', ['mode'])
  return r.stdout.split('\n').map((s) => s.trim()).includes(DND_MODE)
}

/**
 * Turn do-not-disturb on or off. Shared with the study timer, which silences
 * notifications during focus blocks. Returns the resulting state.
 * @param {boolean} on
 */
export async function setDnd(on) {
  const before = await dndActive()
  if (on && !before) await run('makoctl', ['mode', '-a', DND_MODE])
  if (!on && before) await run('makoctl', ['mode', '-r', DND_MODE])
  return dndActive()
}

export async function handleDnd(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })
  let action = String(b.action || 'status').trim().toLowerCase()
  if (!['on', 'off', 'toggle', 'status'].includes(action)) {
    return json(res, 400, { ok: false, error: 'accion_invalida', detail: 'on|off|toggle|status' })
  }
  if (action === 'toggle') action = (await dndActive()) ? 'off' : 'on'
  const active = action === 'status' ? await dndActive() : await setDnd(action === 'on')
  const expected = action === 'status' ? active : action === 'on'
  return json(res, active === expected ? 200 : 502, {
    ok: active === expected,
    active,
    detail: active ? 'No molestar activado' : 'No molestar desactivado',
  })
}
