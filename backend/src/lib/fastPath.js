/**
 * Deterministic fast path for the basic commands — no LLM in the loop.
 *
 * Through the CLI a "pon un temporizador" costs ~2.5–3.5 s to the first word,
 * and it stops working whenever the model or the subscription has a bad day.
 * The people who keep using their home-made assistants say the same thing:
 * "low latency beats smarts", "do as many dumb things deterministically as
 * possible" (HN threads, 2026). So a handful of SHORT, unambiguous commands —
 * timers, volume, media keys, the time — are parsed here and run through the
 * SAME backend routes the MCP tools use. Anything compound ("…y luego…"),
 * conditional, or not fully parsed returns null and goes to the model exactly
 * as before. Never destructive. Kill switch: JARVIS_FAST_PATH=0.
 */
import { extractDurationMs, extractLabel } from './timerParser.js'
import { hasWakePhrase } from './intentClassifier.js'

const ENABLED = () => process['env']['JARVIS_FAST_PATH'] !== '0'

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[¿?¡!.]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Drop a leading "Jarvis," / "oye Jarvis" — only when it really is the wake word. */
function stripWake(t) {
  const m = t.match(/^(?:(?:hola|oye|ok|bueno)\s+)?\S+?[,\s]+/)
  if (m && hasWakePhrase(m[0])) return t.slice(m[0].length).trim()
  return t
}

// "una hora y media", "dos horas y diez minutos" keep their "y"; any other "y"
// (or "luego", "pero"…) means a second request the model should see whole.
const DURATION_Y_RE = /\by\s+(media|cuarto|\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|cuarenta|cincuenta)\b/g
const COMPOUND_RE = /\b(y|luego|despues|ademas|pero|tambien|cuando|si|porque|antes|mientras)\b/
const MAX_WORDS = 14

const NUM_WORDS = {
  cero: 0, diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90, cien: 100, quince: 15, veinticinco: 25, setentaycinco: 75,
}

function parsePercent(s) {
  const n = Number(s)
  if (Number.isFinite(n)) return n
  return NUM_WORDS[String(s).replace(/\s+/g, '')] ?? null
}

/** "3 minutos", "1 hora y 30 minutos", "45 segundos". */
export function spokenDuration(ms) {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '')
  return [part(h, 'hora', 'horas'), part(m, 'minuto', 'minutos'), h ? '' : part(s, 'segundo', 'segundos')]
    .filter(Boolean).join(' y ') || '0 segundos'
}

/**
 * Pure matcher. Returns { kind, method, path, body } or null.
 * @param {string} text  raw transcript (may start with the wake word)
 */
export function matchFastCommand(text) {
  const t = stripWake(norm(text))
  if (!t || t.split(' ').length > MAX_WORDS) return null
  if (COMPOUND_RE.test(t.replace(DURATION_Y_RE, ' '))) return null

  // Timer: start
  if (/^(?:(?:pon(?:me|le)?|crea(?:me)?|inicia|programa(?:me)?|activa|arranca)\s+)?(?:un|una|el)?\s*(?:temporizador|timer|cuenta regresiva)\b/.test(t)) {
    if (/\ba las?\b/.test(t)) return null  // a clock time is a reminder, not a timer
    const ms = extractDurationMs(t)
    if (!ms || ms < 1000) return null
    const label = extractLabel(text, 'timer')
    // Echo the señor's own words ("para el té") — the parsed label drops the article.
    const said = String(text).match(/\bpara\s+(?:el|la|los|las|mi|mis)\s+[^,.;?!]+$/i)
    return {
      kind: 'timer_start', method: 'POST', path: '/api/skills/timer/start',
      body: { seconds: Math.round(ms / 1000), ...(label ? { label } : {}) },
      labelPhrase: said ? said[0].trim() : (label ? `para ${label}` : ''),
    }
  }
  // Timer: cancel
  const cancel = t.match(/^(?:cancela(?:me)?|quita(?:me)?|borra|elimina|apaga|deten)\s+(?:el|los|la|las|todos los|todas las|mi|mis)?\s*(temporizador(?:es)?|timers?|alarmas?)\b/)
  if (cancel) {
    const label = extractLabel(text, 'timer')
    const all = !label && (/\btodos?\b|\btodas?\b/.test(t) || /es$|s$/.test(cancel[1]))
    return { kind: 'timer_cancel', method: 'POST', path: '/api/skills/timer/cancel', body: all ? { all: true } : (label ? { label } : { all: true }) }
  }
  // Timer: how much is left
  if (/^(?:cuanto (?:le )?(?:queda|falta)|que temporizadores tengo|tengo (?:algun )?temporizador)/.test(t) && /temporizador|timer|queda|falta/.test(t)) {
    return { kind: 'timer_list', method: 'GET', path: '/api/skills/timer/list', body: {} }
  }
  // Volume
  const setVol = t.match(/^(?:pon|deja|ajusta|sube|baja)\s+(?:el\s+)?volumen\s+(?:al?|en)\s+(\d{1,3}|[a-z]+(?: y [a-z]+)?)\s*(?:%|por ?ciento)?$/)
  if (setVol) {
    const value = parsePercent(setVol[1])
    if (value == null || value < 0 || value > 100) return null
    return { kind: 'volume_set', method: 'POST', path: '/api/skills/system/volume', body: { action: 'set', value } }
  }
  if (/^(?:sube(?:le)?|aumenta)\s+(?:el\s+)?volumen(?: un poco| mas)?$/.test(t)) {
    return { kind: 'volume_up', method: 'POST', path: '/api/skills/system/volume', body: { action: 'up', step: 10 } }
  }
  if (/^(?:baja(?:le)?|disminuye)\s+(?:el\s+)?volumen(?: un poco| mas)?$/.test(t)) {
    return { kind: 'volume_down', method: 'POST', path: '/api/skills/system/volume', body: { action: 'down', step: 10 } }
  }
  if (/^(?:silencia(?:lo)?|mutea|quita el (?:sonido|volumen))$/.test(t)) {
    return { kind: 'volume_mute', method: 'POST', path: '/api/skills/system/volume', body: { action: 'mute' } }
  }
  if (/^(?:quita el silencio|activa el sonido|desilencia)$/.test(t)) {
    return { kind: 'volume_unmute', method: 'POST', path: '/api/skills/system/volume', body: { action: 'unmute' } }
  }
  // Media keys
  if (/^(?:pausa|deten|para)\s+(?:la\s+|el\s+)?(?:musica|cancion|reproduccion|video|podcast)$/.test(t)) {
    return { kind: 'media_pause', method: 'POST', path: '/api/skills/system/media', body: { action: 'pause' } }
  }
  if (/^(?:reanuda|continua|sigue con|pon)\s+(?:la\s+|el\s+)?(?:musica|cancion|reproduccion|video|podcast)$/.test(t)) {
    return { kind: 'media_play', method: 'POST', path: '/api/skills/system/media', body: { action: 'play' } }
  }
  if (/^(?:(?:pon la |pasa a la |salta a la )?siguiente(?: cancion| tema)?|salta(?:la)? (?:la )?cancion|pasa (?:la )?cancion)$/.test(t)) {
    return { kind: 'media_next', method: 'POST', path: '/api/skills/system/media', body: { action: 'next' } }
  }
  if (/^(?:(?:pon la |vuelve a la )?(?:cancion )?anterior(?: cancion)?)$/.test(t)) {
    return { kind: 'media_previous', method: 'POST', path: '/api/skills/system/media', body: { action: 'previous' } }
  }
  // The time
  if (/^(?:que hora es|dime la hora|me dices la hora|que horas son)$/.test(t)) {
    return { kind: 'time', method: null, path: null, body: {} }
  }
  return null
}

/** Spoken confirmation built from what the route ACTUALLY returned. */
export function fastReply(cmd, r, now = new Date()) {
  switch (cmd.kind) {
    case 'time':
      return `Son las ${now.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' })}, señor.`
    case 'timer_start': {
      const label = cmd.labelPhrase ? ` ${cmd.labelPhrase}` : ''
      const asleep = r?.result?.owner === 'backend' ? ' La interfaz está dormida, así que le aviso yo.' : ''
      return `Temporizador de ${spokenDuration(cmd.body.seconds * 1000)}${label} en marcha, señor.${asleep}`
    }
    case 'timer_cancel':
      return cmd.body.all ? 'Temporizadores cancelados, señor.' : `Temporizador de ${cmd.body.label} cancelado, señor.`
    case 'timer_list': {
      const live = (r?.result?.timers || []).filter((x) => x.status !== 'done' && x.remainingMs > 0)
      if (!live.length) return 'No tiene temporizadores activos, señor.'
      return live.map((x) => `${x.label ? `Al de ${x.label}` : 'Al temporizador'} le quedan ${spokenDuration(x.remainingMs)}`).join('. ') + ', señor.'
    }
    case 'volume_set': case 'volume_up': case 'volume_down':
      return typeof r?.level === 'number' ? `Volumen al ${r.level} por ciento, señor.` : 'Listo, señor.'
    case 'volume_mute': return 'Sonido silenciado, señor.'
    case 'volume_unmute': return 'Sonido activado, señor.'
    case 'media_pause': return 'En pausa, señor.'
    case 'media_play': return 'Reanudando, señor.'
    case 'media_next': case 'media_previous': {
      const what = [r?.title, r?.artist].filter(Boolean).join(', de ')
      return what ? `Ahora suena ${what}.` : 'Listo, señor.'
    }
    default: return 'Listo, señor.'
  }
}

/** The MCP tool name the trace should show for this command. */
export function fastToolName(cmd) {
  if (cmd.kind.startsWith('timer_')) return `mcp__jarvis__timer.${cmd.kind.slice('timer_'.length)}`
  if (cmd.kind.startsWith('volume_')) return 'mcp__jarvis__system_volume'
  if (cmd.kind.startsWith('media_')) return 'mcp__jarvis__system_media'
  return null
}

/**
 * Run a matched command through its backend route (in-process). Returns
 * { reply, tool, input } or null when it failed — the caller then hands the
 * turn to the model, which can explain or try another way.
 * @param {string} text
 * @param {(route: {method, path}, body: object) => Promise<object>} call
 */
export async function tryFastPath(text, call) {
  if (!ENABLED()) return null
  const cmd = matchFastCommand(text)
  if (!cmd) return null
  let r = null
  if (cmd.path) {
    try { r = await call({ method: cmd.method, path: cmd.path }, cmd.body) } catch { return null }
    if (!r || r.ok === false) {
      console.log(`[fast] ${cmd.kind} failed (${r?.error || 'no_result'}) — handing the turn to the model`)
      return null
    }
  }
  const reply = fastReply(cmd, r)
  console.log(`[fast] ${cmd.kind} -> ${reply}`)
  return { reply, tool: fastToolName(cmd), input: cmd.body, kind: cmd.kind }
}
