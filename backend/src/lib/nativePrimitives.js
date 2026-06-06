/**
 * Native primitives — backend-side (Node) fallbacks for capabilities that can
 * also run in the renderer. Used by self-built skills when no AWAKE renderer is
 * connected to the skill bus (hasClient() === false), so Jarvis stays able to
 * act headless.
 *
 * Windows-first (PowerShell / ffmpeg / Python+OpenCV), matching the host.
 */

import { execSync, execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

const __dir = dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = join(__dir, '..', '..')
const VENV_PY = join(BACKEND_ROOT, 'voice', 'python', '.venv', 'Scripts', 'python.exe')

/** Directory where Jarvis saves captured media. */
export function mediaDir() {
  const dir = join(homedir(), 'Pictures', 'Jarvis')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Save a Buffer to the media dir, returns the absolute path. */
export function saveMedia(buf, name) {
  const path = join(mediaDir(), name)
  writeFileSync(path, buf)
  return path
}

/** Save a renderer-produced data URL (e.g. image/jpeg;base64,...) to disk. */
export function saveDataUrl(dataUrl, name) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl)
  if (!m) throw new Error('invalid_data_url')
  return saveMedia(Buffer.from(m[2], 'base64'), name)
}

/**
 * Enumerate cameras attached to the machine via Windows PnP. Returns [{ name }].
 * Best-effort: returns [] if PowerShell/PnP is unavailable.
 */
export function enumerateCamerasNative() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-PnpDevice -Class Camera,Image -Status OK | Select-Object -ExpandProperty FriendlyName"',
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name }))
  } catch {
    return []
  }
}

function pythonExe() {
  return existsSync(VENV_PY) ? VENV_PY : 'python'
}

/**
 * Capture one still frame natively. Tries ffmpeg dshow first, then Python+OpenCV
 * (auto-installs opencv-python if missing). Returns the saved file path.
 * @param {string} [outName] file name under the media dir
 * @returns {string} absolute path of the saved image
 */
export function capturePhotoNative(outName = `foto-${Date.now()}.jpg`) {
  const outPath = join(mediaDir(), outName)

  // 1) ffmpeg via DirectShow, using the first detected camera name.
  const cams = enumerateCamerasNative()
  if (cams.length) {
    try {
      execFileSync('ffmpeg', ['-y', '-f', 'dshow', '-i', `video=${cams[0].name}`, '-frames:v', '1', outPath], {
        timeout: 15000, stdio: 'ignore',
      })
      if (existsSync(outPath)) return outPath
    } catch { /* ffmpeg missing or device busy — fall through */ }
  }

  // 2) Python + OpenCV fallback.
  const py = pythonExe()
  const escaped = outPath.replace(/\\/g, '\\\\')
  const script = [
    'import sys',
    'try:',
    '    import cv2',
    'except ImportError:',
    '    import subprocess',
    '    subprocess.run([sys.executable, "-m", "pip", "install", "opencv-python"], check=True)',
    '    import cv2',
    'cap = cv2.VideoCapture(0)',
    'ok, frame = cap.read()',
    'cap.release()',
    'sys.exit(0 if (ok and cv2.imwrite(r"' + escaped + '", frame)) else 1)',
  ].join('\n')
  const scriptPath = join(mediaDir(), '.capture.py')
  writeFileSync(scriptPath, script, 'utf8')
  execFileSync(py, [scriptPath], { timeout: 120000, stdio: 'ignore' })
  if (existsSync(outPath)) return outPath
  throw new Error('native_capture_failed')
}

/** Read a saved media file back as a base64 data URL (for returning to the UI). */
export function fileToDataUrl(path, mime = 'image/jpeg') {
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}
