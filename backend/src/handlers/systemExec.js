import { execFile, exec } from 'child_process'
import { json, readBody } from '../lib/http.js'

// Capacidad de terminal total para el brain de voz en Linux/Hyprland.
//
// El brain ya corre con `--dangerously-skip-permissions`, pero su system prompt
// solo le enumera tools de UI/archivos, así que rechaza órdenes como "lanza el
// navegador". Estos dos endpoints le dan acceso explícito:
//   - launch_app  → abre apps GUI vía `hyprctl dispatch exec` (respeta window
//                   rules del WM; el proceso no queda colgado del backend).
//   - run_terminal→ ejecuta cualquier comando de shell (auto mode: hace lo que
//                   se le pida) y devuelve stdout/stderr/exit para que el brain
//                   razone sobre el resultado.

// Nombres amistosos (español/voz) → comando real para launch_app. Si la app no
// está en el mapa, se usa el texto literal como comando.
const ALIASES = {
  navegador: 'xdg-open https://www.google.com',
  browser: 'xdg-open https://www.google.com',
  internet: 'xdg-open https://www.google.com',
  google: 'xdg-open https://www.google.com',
  archivos: 'xdg-open ~',
  explorador: 'xdg-open ~',
  ficheros: 'xdg-open ~',
}

function resolveCommand(app) {
  const key = String(app || '').trim().toLowerCase()
  if (!key) return ''
  return ALIASES[key] || key
}

async function body(req) {
  try {
    return (await readBody(req)) || {}
  } catch {
    return null
  }
}

// --- launch_app: abrir apps GUI por el WM ------------------------------------
export async function handleAppLaunch(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })

  const cmd = resolveCommand(b.app)
  if (!cmd) return json(res, 400, { ok: false, error: 'app_requerida' })

  return new Promise((resolve) => {
    execFile('hyprctl', ['dispatch', 'exec', cmd], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(json(res, 503, {
          ok: false,
          error: 'hyprctl_no_disponible',
          detail: (stderr || err.message || '').toString().trim(),
        }))
        return
      }
      const out = (stdout || '').toString().trim()
      if (out && !/ok/i.test(out)) {
        resolve(json(res, 502, { ok: false, error: 'launch_fallido', detail: out }))
        return
      }
      resolve(json(res, 200, { ok: true, launched: cmd }))
    })
  })
}

// --- run_terminal: ejecutar comandos arbitrarios -----------------------------
const MAX_OUT = 8000          // chars de stdout/stderr devueltos al brain
const DEFAULT_TIMEOUT = 30000 // ms

export async function handleRunTerminal(req, res) {
  const b = await body(req)
  if (!b) return json(res, 400, { ok: false, error: 'bad_request' })

  const command = String(b.command || '').trim()
  if (!command) return json(res, 400, { ok: false, error: 'command_requerido' })

  // detach: para procesos GUI/largos que no deben bloquear ni mantener la
  // conexión abierta (ej. abrir una app y seguir). setsid los desacopla.
  if (b.detach) {
    try {
      const child = exec(`setsid -f ${command}`, {
        cwd: b.cwd || process.env.HOME,
      })
      child.unref?.()
      return json(res, 200, { ok: true, detached: true, command })
    } catch (e) {
      return json(res, 500, { ok: false, error: 'spawn_fallido', detail: e.message })
    }
  }

  const timeout = Number.isFinite(b.timeout) ? Math.min(b.timeout, 300000) : DEFAULT_TIMEOUT
  return new Promise((resolve) => {
    exec(command, {
      cwd: b.cwd || process.env.HOME,
      timeout,
      maxBuffer: 1024 * 1024 * 8,
      env: process.env,
    }, (err, stdout, stderr) => {
      const out = (stdout || '').toString().slice(0, MAX_OUT)
      const errOut = (stderr || '').toString().slice(0, MAX_OUT)
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0)
      const timedOut = !!(err && err.killed && err.signal === 'SIGTERM')
      resolve(json(res, 200, {
        ok: code === 0,
        exit: code,
        stdout: out,
        stderr: errOut,
        timedOut,
      }))
    })
  })
}
