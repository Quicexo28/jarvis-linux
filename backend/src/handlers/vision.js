/**
 * Vision — letting Jarvis SEE.
 *
 * Until now Jarvis was blind: it could talk, act and remember, but it could not
 * look at the screen the user is staring at, so "¿qué error sale ahí?" or "lee
 * esto" were impossible. That is the single largest capability gap for an
 * assistant belonging to someone who spends the day in front of a monitor.
 *
 * Two eyes:
 *   POST /api/skills/vision/screen  — a screenshot of a monitor (grim, Wayland)
 *   POST /api/skills/vision/camera  — a frame from the webcam, via the renderer's
 *                                     existing capture_photo primitive
 *
 * Both return a base64 PNG/JPEG that the MCP layer hands to the model as an
 * IMAGE block, which is what actually makes it visible to Claude.
 *
 * Downscaling is not cosmetic: a raw 1920x1080 PNG is several MB of base64,
 * which is slow to move and wasteful in tokens. Claude sees no more detail above
 * ~1568px on the long edge, so that is the cap.
 */

import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json, readBody } from '../lib/http.js'
import { requestClient, hasClient } from '../lib/skillBus.js'

const GRIM = process['env']['JARVIS_GRIM_BIN'] || 'grim'
const MAGICK = process['env']['JARVIS_MAGICK_BIN'] || 'magick'
const MAX_EDGE = Number(process['env']['JARVIS_VISION_MAX_EDGE'] || 1568)
// A screenshot can contain anything on screen (passwords, private messages), so
// it never leaves this machine except as the model's input for the turn that
// asked for it, and the temp file is deleted immediately.
const SHOT_TIMEOUT_MS = 8000

function run(cmd, args, timeoutMs = SHOT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd}: ${stderr || err.message}`))
      resolve(String(stdout))
    })
  })
}

/**
 * Capture one monitor and return it as a downscaled base64 PNG.
 * @param {string} output  Wayland output name (hyprctl monitors), '' = focused
 */
/**
 * Which monitor to shoot when the caller didn't say.
 *
 * `grim` with no -o composites EVERY output into one image. On this machine that
 * stacks the laptop panel on top of `projmap`, the HEADLESS output that feeds the
 * projector — so half the picture was a wall nobody is looking at, the aspect
 * ratio was nonsense, and the model answered about the wrong half. The focused
 * monitor is what "mi pantalla" means.
 */
async function defaultOutput() {
  try {
    const out = await run('hyprctl', ['monitors', '-j'], 3000)
    const monitors = JSON.parse(out)
    const focused = monitors.find((m) => m.focused)
    if (focused?.name && focused.name !== 'projmap') return focused.name
    const real = monitors.find((m) => m.name !== 'projmap')
    return real?.name ?? ''
  } catch {
    return ''
  }
}

async function grabScreen(output) {
  const raw = join(tmpdir(), `jarvis-shot-${Date.now()}.png`)
  const small = raw.replace(/\.png$/, '.jpg')
  const args = []
  if (output) args.push('-o', output)
  args.push(raw)
  await run(GRIM, args)
  try {
    // Downscale AND re-encode as JPEG. Measured on this 1920x1080 panel: the
    // resized PNG is 691 KB while JPEG q85 is 142 KB — ~5x less to push through
    // MCP stdio, with screen text still perfectly readable at 1568px.
    await run(MAGICK, [raw, '-resize', `${MAX_EDGE}x${MAX_EDGE}>`, '-quality', '85', small])
    const buf = await readFile(small)
    unlink(raw).catch(() => {})
    unlink(small).catch(() => {})
    return { base64: buf.toString('base64'), mimeType: 'image/jpeg', bytes: buf.length }
  } catch (e) {
    // No ImageMagick: return the full PNG rather than failing. Bigger is better
    // than blind.
    console.warn('[vision] resize skipped —', e?.message)
    const buf = await readFile(raw)
    unlink(raw).catch(() => {})
    return { base64: buf.toString('base64'), mimeType: 'image/png', bytes: buf.length }
  }
}

/**
 * POST /api/skills/vision/screen { output?: string }
 * Returns { ok, image: { base64, mimeType, bytes } }.
 */
export async function handleVisionScreen(req, res) {
  let body = {}
  try { body = (await readBody(req)) || {} } catch {}
  const output = String(body.output ?? '').trim() || (await defaultOutput())
  try {
    const image = await grabScreen(output)
    console.log(`[vision] screen${output ? ` (${output})` : ''} -> ${Math.round(image.bytes / 1024)} KB`)
    return json(res, 200, { ok: true, image })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'capture_failed', detail: String(e?.message ?? e) })
  }
}

/**
 * POST /api/skills/vision/camera
 * Uses the renderer's capture_photo primitive, which reuses the hidden <video>
 * the gesture pipeline already keeps open — so no second camera permission and
 * no second stream (opening one is what makes WebKitGTK's PipeWire client crash).
 */
export async function handleVisionCamera(_req, res) {
  if (!hasClient()) {
    return json(res, 503, { ok: false, error: 'renderer_not_connected' })
  }
  try {
    const result = await requestClient('capture_photo', {}, 15000)
    // The primitive returns a data URL; split it into the MCP image shape.
    const raw = String(result?.dataUrl ?? result?.image ?? '')
    const m = raw.match(/^data:(image\/[a-z]+);base64,(.+)$/)
    if (!m) return json(res, 500, { ok: false, error: 'unexpected_photo_shape' })
    return json(res, 200, {
      ok: true,
      image: { mimeType: m[1], base64: m[2], bytes: Math.floor(m[2].length * 0.75) },
    })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'capture_failed', detail: String(e?.message ?? e) })
  }
}
