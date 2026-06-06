import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { execSync, execFileSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { isBuiltin } from 'module'
import { runClaude } from '../lib/claudeCli.js'
import { routes } from '../routes.js'
import { saveSkillEntry, removeSkillEntry, invokeRoute } from '../lib/skillManifest.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const DYNAMIC_DIR = join(__dir, 'dynamic')

const FORCE_RE = /\b(rehaz|regenera|reconstruye|vuelve a (crear|hacer)|actualiza la habilidad)\b/i

function slugify(text) {
  return text.toLowerCase()
    .replace(/[áàâä]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i').replace(/[óòôö]/g, 'o')
    .replace(/[úùûü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40)
}

function extractCodeBlock(text) {
  const match = text.match(/```(?:javascript|js)?\n([\s\S]*?)```/)
  return match ? match[1].trim() : text.trim()
}

// Capability manifest: this is what makes self-build "real". It documents the
// actual API surface a generated skill can reach — the skill bus to the renderer
// (camera/notify), native fallbacks, and how to save/return media — so opus
// composes genuine capabilities instead of toy endpoints.
const CODE_GEN_SYSTEM = `Eres el generador de herramientas (skills) de Jarvis. Generas un módulo Node.js ESM que añade una capacidad REAL al asistente.

RESPONDE SOLO con un bloque de código JavaScript. Sin texto, sin explicaciones.

CONTRATO DEL MÓDULO:
- ES modules (import/export).
- export const route = { method: 'GET'|'POST', path: '/api/skills/<slug>', handler }
- export const meta = { description: string, triggers: string[] }  // frases con las que el usuario pediría esta acción
- handler(req, res) importa { json, readBody } de '../lib/http.js' y SIEMPRE responde con json(res, code, payload).
- El payload debe incluir: { ok: boolean, spoken: string, ...datos }. "spoken" es una frase corta en español (estilo Jarvis, trata al usuario de "señor") que se leerá por voz.
- handler robusto: envuelve en try/catch; ante fallo responde { ok:false, spoken:'...' }.

CAPACIDADES DISPONIBLES (úsalas según haga falta):
1) Bus al navegador (donde viven cámara, micrófono, notificaciones). El renderer está conectado cuando hasClient() es true:
   import { requestClient, hasClient } from '../lib/skillBus.js'
   - await requestClient('enumerate_devices') -> { cameras:[{deviceId,label}], microphones:[...] }
   - await requestClient('capture_photo', { deviceId? }) -> { dataUrl, width, height, source }  // dataUrl = image/jpeg base64
   - await requestClient('notify', { text }) -> { shown:true }
   requestClient puede lanzar 'no_client' o 'timeout' -> maneja el fallback.
2) Fallback nativo (sin navegador, headless):
   import { enumerateCamerasNative, capturePhotoNative, saveDataUrl, saveMedia, fileToDataUrl, mediaDir } from '../lib/nativePrimitives.js'
   - capturePhotoNative(nombre?) -> ruta del archivo guardado (usa ffmpeg o Python+OpenCV).
   - saveDataUrl(dataUrl, nombre) -> guarda una imagen base64 del navegador en disco, devuelve la ruta.
3) Node builtins (fs, child_process, etc.). Puedes importar paquetes npm: decláralos con import y Jarvis los instala.
   child_process para PowerShell/Python si necesitas tocar el sistema operativo.

PATRÓN PARA HARDWARE (decide solo): primero intenta el bus si hasClient(); si no hay cliente o falla, usa el fallback nativo.

EJEMPLO (tomar una foto):
\`\`\`javascript
import { json } from '../lib/http.js'
import { requestClient, hasClient } from '../lib/skillBus.js'
import { saveDataUrl, capturePhotoNative, fileToDataUrl } from '../lib/nativePrimitives.js'

export const meta = {
  description: 'Toma una foto con la cámara del equipo y la guarda',
  triggers: ['toma una foto', 'tomame una foto', 'sacame una foto', 'usa la camara', 'conectate a la camara'],
}

export const route = {
  method: 'GET',
  path: '/api/skills/tomar-foto',
  async handler(_req, res) {
    const name = 'foto-' + Date.now() + '.jpg'
    try {
      if (hasClient()) {
        const shot = await requestClient('capture_photo', {}, 20000)
        const path = saveDataUrl(shot.dataUrl, name)
        return json(res, 200, { ok: true, spoken: 'Foto tomada, señor.', path })
      }
      const path = capturePhotoNative(name)
      return json(res, 200, { ok: true, spoken: 'Foto tomada, señor.', path, dataUrl: fileToDataUrl(path) })
    } catch (e) {
      return json(res, 200, { ok: false, spoken: 'No pude acceder a la cámara, señor.', error: String(e) })
    }
  },
}
\`\`\``

async function generateCode(capability, slug, fixError) {
  let prompt = `Genera la herramienta para esta capacidad: "${capability}".
El path debe ser '/api/skills/${slug}'.
Responde SOLO con el bloque de código JavaScript.`
  if (fixError) {
    prompt += `\n\nEl intento anterior falló la verificación de sintaxis con este error:\n${fixError}\nCorrígelo y devuelve el módulo completo.`
  }
  const raw = await runClaude(prompt, {
    systemPromptText: CODE_GEN_SYSTEM,
    timeoutMs: 60000,
    model: 'opus',
    fallbackReply: '',
    namespace: 'jarvis-selfbuild',
  })
  return extractCodeBlock(raw)
}

// node --check validates syntax (incl. ESM import statements) without executing.
function checkSyntax(filePath) {
  try {
    execFileSync('node', ['--check', filePath], { stdio: 'pipe' })
    return null
  } catch (e) {
    return String(e.stderr || e.message).slice(0, 600)
  }
}

function installExternalDeps(code) {
  const pkgs = [...code.matchAll(/from ['"]([^./'][^'"]*)['"]/g)]
    .map((m) => m[1])
    .filter((pkg) => !isBuiltin(pkg))
  if (!pkgs.length) return { installed: false }
  const backendDir = join(__dir, '..', '..')
  for (const pkg of pkgs) {
    try {
      execSync(`npm install ${pkg}`, { cwd: backendDir, stdio: 'pipe' })
      console.log(`[self-build] installed ${pkg}`)
    } catch {
      return { installed: false, failed: pkg }
    }
  }
  return { installed: true }
}

// Push a route into the live table, replacing any same method+path entry so
// rebuilds don't leave a stale duplicate ahead of the new one.
function registerRoute(route) {
  const i = routes.findIndex((r) => r.method === route.method && r.path === route.path)
  if (i >= 0) routes.splice(i, 1)
  routes.push(route)
}

async function activateModule(filePath, capability, slug) {
  const url = pathToFileURL(filePath).href + '?v=' + Date.now()
  const mod = await import(url)
  if (!mod.route) throw new Error('module exports no route')
  registerRoute(mod.route)
  const meta = mod.meta || {}
  saveSkillEntry({
    slug,
    path: mod.route.path,
    method: mod.route.method,
    description: meta.description || capability,
    triggers: meta.triggers || [capability],
  })
  // Auto-invoke so the action happens this turn (e.g. actually take the photo),
  // not just "skill activated".
  let spoken = `Habilidad de ${capability} activada y lista, señor.`
  try {
    const result = await invokeRoute(mod.route, {})
    if (result && typeof result.spoken === 'string' && result.spoken) spoken = result.spoken
  } catch (e) {
    console.warn('[self-build] auto-invoke failed:', e.message)
  }
  return spoken
}

export async function handleSelfBuild({ capability }) {
  if (!existsSync(DYNAMIC_DIR)) mkdirSync(DYNAMIC_DIR, { recursive: true })

  const slug = slugify(capability)
  const filePath = join(DYNAMIC_DIR, `${slug}.js`)
  const force = FORCE_RE.test(capability)

  // Dedup: reuse an existing skill unless the user asked to rebuild it.
  if (existsSync(filePath) && !force) {
    try {
      return await activateModule(filePath, capability, slug)
    } catch (e) {
      console.warn('[self-build] existing skill failed to load, regenerating:', e.message)
    }
  }

  // Generate (opus), validate syntax, retry once on failure.
  let code = await generateCode(capability, slug)
  if (!code || code.length < 30) {
    return 'No pude generar esa habilidad en este momento. Intenta describir la capacidad con más detalle.'
  }
  writeFileSync(filePath, code, 'utf8')
  let synErr = checkSyntax(filePath)
  if (synErr) {
    code = await generateCode(capability, slug, synErr)
    if (code && code.length >= 30) writeFileSync(filePath, code, 'utf8')
    synErr = checkSyntax(filePath)
    if (synErr) {
      try { unlinkSync(filePath) } catch {}
      console.warn('[self-build] syntax check failed twice:', synErr)
      return 'Generé la habilidad pero tenía errores de sintaxis. Lo intentaré de nuevo si me lo pides.'
    }
  }

  // Hot-load. On failure: install external deps + restart, else roll back.
  try {
    return await activateModule(filePath, capability, slug)
  } catch (e) {
    console.warn('[self-build] hot-load failed:', e.message)
    const dep = installExternalDeps(code)
    if (dep.failed) {
      try { unlinkSync(filePath) } catch {}
      removeSkillEntry(slug)
      return `No pude instalar la dependencia ${dep.failed}. Verifica la conexión y que npm esté disponible.`
    }
    if (dep.installed) {
      console.log('[self-build] deps installed, signaling backend restart (exit 99)')
      process.exit(99)
    }
    // No deps to blame — the module is broken. Roll back so it can't break boot.
    try { unlinkSync(filePath) } catch {}
    removeSkillEntry(slug)
    return 'Generé la habilidad pero falló al cargarse. La descarté para no dejar el sistema inestable.'
  }
}
