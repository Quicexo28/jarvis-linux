/**
 * Micrófono compartido del renderer (singleton de módulo).
 *
 * POR QUÉ: WebKitGTK captura audio por PipeWire y su cliente
 * (libpipewire-module-protocol-native) hace SIGSEGV cuando varios streams se
 * abren/cierran en el mismo instante. Cambiar el modo de voz off→continuo
 * levantaba TRES getUserMedia en el mismo tick (STT + detección de aplausos +
 * medidor de nivel) mientras el WaveEqualizer ya tenía el suyo; el
 * WebKitWebProcess moría con SIGSEGV en el hilo `pipewire-main-l`
 * (coredump 2026-07-24 18:18, IP=0x3 = salto por puntero liberado) y systemd
 * relanzaba la UI. Mismo bug ya documentado para la cámara en
 * `gestures/cameraFeed.ts` — misma solución: UNA sola apertura por sesión.
 *
 * CONTRATO: los consumidores piden `acquireMic()` y sueltan con `releaseMic()`.
 * El stream real se abre una vez (aperturas concurrentes comparten la MISMA
 * promesa) y se cierra sólo cuando el último consumidor suelta Y pasan
 * LINGER_MS sin que nadie lo vuelva a pedir — así un toggle off→on rápido (o un
 * remount de React) reutiliza el nodo PipeWire en vez de destruirlo y recrearlo.
 *
 * NUNCA llamar `stream.getTracks().forEach(t => t.stop())` sobre el stream
 * devuelto: mataría el micro de todos los demás consumidores.
 */

/** Margen antes de cerrar de verdad tras el último release. */
const LINGER_MS = 5000

let stream: MediaStream | null = null
let refs = 0
let opening: Promise<MediaStream> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

let aecDeviceId: string | undefined
let aecResolved = false

/**
 * deviceId del micro virtual con cancelación de eco de PipeWire
 * ("Jarvis AEC Mic" / nodo jarvis_aec_source). Capturarlo en vez del micro
 * crudo quita la propia voz de Jarvis (TTS por el altavoz) de la entrada.
 * Cacheado: enumerateDevices también toca el portal, y repetirlo en cada
 * apertura es churn extra.
 */
async function resolveAecSourceId(): Promise<string | undefined> {
  if (aecResolved) return aecDeviceId
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const match = devices.find(
      (d) => d.kind === 'audioinput' && /jarvis.*aec|aec.*mic/i.test(d.label),
    )
    aecDeviceId = match?.deviceId
  } catch {
    aecDeviceId = undefined
  }
  aecResolved = true
  return aecDeviceId
}

function isLive(s: MediaStream | null): s is MediaStream {
  return !!s && s.active && s.getAudioTracks().some((t) => t.readyState === 'live')
}

async function openStream(): Promise<MediaStream> {
  try {
    return await openStreamOnce()
  } catch (err) {
    // El nodo AEC de PipeWire se recrea cuando cambia el sink (p.ej. el altavoz
    // Bluetooth se conecta): el deviceId cacheado deja de existir y `exact`
    // falla con OverconstrainedError. Reintentar una vez con el micro por
    // defecto en vez de dejar la sesión sin audio.
    if (aecDeviceId) {
      console.warn('[mic] AEC source unavailable, falling back to default mic', err)
      aecDeviceId = undefined
      aecResolved = false
      return openStreamOnce()
    }
    throw err
  }
}

async function openStreamOnce(): Promise<MediaStream> {
  const aecSourceId = await resolveAecSourceId()
  // Un solo juego de constraints sirve a todos los consumidores:
  //  - noiseSuppression SIEMPRE off: la supresión del navegador se come justo
  //    los transitorios de banda ancha que usa la detección de aplausos, y el
  //    lado servidor ya hace denoise (STT_DENOISE_MODE=deepfilter).
  //  - autoGainControl off: haría vagar el suelo de ruido estimado del clap.
  //  - echoCancellation sólo cuando NO hay fuente AEC de PipeWire (dos AEC en
  //    cascada se pelean y degradan ambos).
  return navigator.mediaDevices.getUserMedia({
    audio: aecSourceId
      ? {
          deviceId: { exact: aecSourceId },
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
  })
}

function hardClose(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
  const s = stream
  stream = null
  if (s) {
    console.log('[mic] closing shared stream')
    s.getTracks().forEach((t) => { try { t.stop() } catch {} })
  }
}

/**
 * Toma una referencia al micro compartido. Cada llamada que resuelve DEBE
 * emparejarse con un `releaseMic()`.
 */
export async function acquireMic(): Promise<MediaStream> {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
  refs++
  try {
    if (isLive(stream)) return stream
    if (!opening) {
      const p = openStream()
      opening = p
      p.then(
        (s) => { stream = s; console.log('[mic] shared stream open') },
        (err) => { console.warn('[mic] getUserMedia failed', err) },
      ).finally(() => { if (opening === p) opening = null })
    }
    const s = await opening
    stream = s
    // Si el nodo muere solo (se recrea la fuente AEC, se desconecta el
    // dispositivo), olvidar el stream para que la siguiente toma reabra en vez
    // de repartir tracks muertos.
    for (const t of s.getAudioTracks()) {
      t.onended = () => { if (stream === s) { console.warn('[mic] track ended'); stream = null } }
    }
    return s
  } catch (err) {
    refs = Math.max(0, refs - 1)
    throw err
  }
}

/** Suelta una referencia. El stream muere LINGER_MS después de la última. */
export function releaseMic(): void {
  refs = Math.max(0, refs - 1)
  if (refs > 0) return
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (refs === 0) hardClose()
  }, LINGER_MS)
}

/** El stream vivo, si lo hay (para consumidores que sólo miran). */
export function getMicStream(): MediaStream | null {
  return isLive(stream) ? stream : null
}
