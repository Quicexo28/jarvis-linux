/**
 * Proyector como PANTALLA, no como equipo.
 *
 * El proyector (AOC/Xnano HA109, Allwinner H713, Android 11) no participa en
 * Jarvis: no es cerebro, ni oidos, ni altavoz. Solo tiene que mostrar en la
 * pared lo mismo que el HDMI mostraba antes, y hacerlo solo.
 *
 * Tres pasos manuales se van por caminos distintos:
 *
 *   cable HDMI     -> Moonlight sobre WiFi contra el Sunshine de este portatil
 *   menu de entrada-> desaparece: nunca sale de su propio Android
 *   mando a distancia -> un comando de encendido externo (blaster IR, enchufe)
 *
 * El encendido NO se implementa por marca a proposito. Cada blaster/enchufe
 * habla un protocolo distinto (Broadlink, Tuya, Shelly, Home Assistant) y
 * meterlos aqui ataria el backend a uno. En su lugar el operador configura un
 * COMANDO en env y esto lo ejecuta; cambiar de marca es cambiar una linea de
 * secrets.local.json, sin tocar codigo.
 *
 * `on` es idempotente: si el proyector ya responde por ADB no vuelve a mandar
 * el pulso de encendido — en un blaster IR el codigo de power suele ser un
 * TOGGLE, asi que repetirlo apagaria justo lo que se pedia encender.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { json, readBody } from '../lib/http.js'

const run = promisify(execFile)

const SUNSHINE_HTTP_PORT = 47989
/** Moonlight se distribuye bajo dos paquetes; el fork es comun en tablets. */
const MOONLIGHT_PACKAGES = ['com.limelight', 'com.limelight.noir']
const TRAMPOLINE = 'com.limelight.ShortcutTrampoline'

const cfg = () => ({
  host: process.env.JARVIS_PROJECTOR_HOST ?? '',
  // Vacio = descubrir por mDNS. Ver `resolveAddr`.
  port: process.env.JARVIS_PROJECTOR_ADB_PORT ?? '',
  adb: process.env.JARVIS_ADB_BIN ?? 'adb',
  onCmd: process.env.JARVIS_PROJECTOR_POWER_ON_CMD ?? '',
  offCmd: process.env.JARVIS_PROJECTOR_POWER_OFF_CMD ?? '',
  bootWaitMs: Number(process.env.JARVIS_PROJECTOR_BOOT_WAIT_MS ?? 60000),
  label: process.env.JARVIS_PROJECTOR_LABEL ?? 'Proyector',
  // Id de la app de Sunshine a lanzar (normalmente "Desktop"). SIN esto el
  // trampolin se queda en la LISTA de apps de esa maquina y alguien tiene que
  // pulsar OK con el mando — justo lo que queriamos eliminar. Sunshine no
  // publica los ids en `apps.json` (los asigna en runtime) ni en `/api/apps`;
  // sale de `<currentgame>` en serverinfo mientras la app corre.
  appId: process.env.JARVIS_PROJECTOR_APP_ID ?? '',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ adb */

/**
 * El puerto de ADB es ALEATORIO y cambia en cada arranque.
 *
 * La "depuracion inalambrica" de Android 11+ no es el adbd clasico del 5555:
 * levanta un listener TLS en un puerto al azar, distinto tras cada reinicio y
 * distinto del puerto de emparejamiento. Fijarlo exigiria `persist.adb.tcp.port`
 * y por tanto root — pero adbd lo ANUNCIA por mDNS (`_adb-tls-connect._tcp`),
 * asi que descubrirlo sale gratis y sin tocar el dispositivo.
 *
 * Se cachea porque `adb mdns services` tarda ~1-2 s, y se invalida en cuanto un
 * connect falla: eso es justo la senal de que el proyector se reinicio y rotó.
 */
let cachedAddr = null

/**
 * El serial NO siempre es `IP:puerto`.
 *
 * Cuando adb reconecta por su cuenta a un dispositivo ya emparejado, lo lista
 * bajo su nombre de servicio mDNS (`adb-<guid>-<sufijo>._adb-tls-connect._tcp`)
 * y NO bajo la IP. Un `adb -s 192.168.1.100:<puerto>` contra ese dispositivo
 * falla con "device not found" aunque salga conectado en `adb devices`. Por eso
 * se prefiere lo que ya esta listo y en estado `device`, y solo si no hay nada
 * se cae al descubrimiento por puerto.
 */
async function readySerial(c) {
  try {
    const { stdout } = await run(c.adb, ['devices'], { timeout: 6000 })
    const ready = stdout.split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter(([serial, state]) => serial && state === 'device')
      .map(([serial]) => serial)
    // Nuestra IP primero; si no, el nombre mDNS (un solo Android emparejado).
    return ready.find((s) => s.startsWith(`${c.host}:`))
      ?? ready.find((s) => s.includes('_adb-tls-connect'))
      ?? null
  } catch {
    return null
  }
}

async function discoverAddr(c) {
  try {
    const { stdout } = await run(c.adb, ['mdns', 'services'], { timeout: 12000 })
    for (const line of stdout.split('\n')) {
      if (!line.includes('_adb-tls-connect')) continue
      const found = line.trim().match(/(\d+\.\d+\.\d+\.\d+:\d+)$/)?.[1]
      // Con varios Android en la LAN hay que quedarse con NUESTRA IP.
      if (found && found.startsWith(`${c.host}:`)) return found
    }
  } catch { /* sin mdns: cae al puerto fijo si lo hay */ }
  return null
}

/** Serial a usar, por orden: ya conectado > configurado > cache > mDNS. */
async function resolveAddr(c) {
  if (!c.host) return null
  const live = await readySerial(c)
  if (live) return live
  if (c.port) return `${c.host}:${c.port}`
  if (cachedAddr?.startsWith(`${c.host}:`)) return cachedAddr
  cachedAddr = await discoverAddr(c)
  return cachedAddr
}

async function adb(c, args, timeout = 8000) {
  const a = await resolveAddr(c)
  if (!a) throw new Error('sin direccion adb')
  return run(c.adb, ['-s', a, ...args], { timeout, maxBuffer: 2 * 1024 * 1024 })
}

/**
 * `adb connect` es barato e idempotente; el demonio ignora la repetida.
 *
 * Si falla con el puerto cacheado se re-descubre UNA vez: tras un arranque en
 * frio el cache siempre esta rancio, y sin este reintento el primer `on` de
 * cada dia fallaria aunque el proyector ya estuviese listo.
 */
async function adbConnect(c) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await resolveAddr(c)
    if (!a) return false
    try {
      const { stdout } = await run(c.adb, ['connect', a], { timeout: 8000 })
      if (/connected to/i.test(stdout)) return true
    } catch { /* cae al re-descubrimiento */ }
    if (c.port) return false   // puerto fijado a mano: no hay nada que descubrir
    cachedAddr = null
  }
  return false
}

/**
 * ¿Responde el Android del proyector?
 *
 * `getprop sys.boot_completed` y no `adb devices`: tras un arranque en frio el
 * dispositivo aparece en la lista bastantes segundos antes de poder lanzar una
 * activity, y un `am start` en esa ventana se pierde en silencio.
 */
async function adbReady(c) {
  if (!c.host) return false
  if (!(await adbConnect(c))) return false
  try {
    const { stdout } = await adb(c, ['shell', 'getprop', 'sys.boot_completed'], 5000)
    return stdout.trim() === '1'
  } catch {
    return false
  }
}

/** ¿Esta la pantalla encendida? Distingue "apagado" de "en reposo". */
async function screenOn(c) {
  try {
    const { stdout } = await adb(c, ['shell', 'dumpsys', 'power'], 6000)
    // mHoldingDisplaySuspendBlocker sigue vivo mientras el panel esta activo.
    return /mHoldingDisplaySuspendBlocker=true|Display Power: state=ON/i.test(stdout)
  } catch {
    return false
  }
}

/* -------------------------------------------------------------- encendido */

/**
 * Ejecuta el comando de encendido/apagado del operador.
 *
 * Va por `sh -c` porque lo tipico es una tuberia o un curl con comillas. La
 * cadena viene de env (secrets.local.json), NUNCA del cuerpo de la peticion:
 * esto no es una via para ejecutar comandos arbitrarios en remoto.
 */
async function powerCmd(cmd, label) {
  if (!cmd) return { ok: false, error: 'power_cmd_missing' }
  try {
    await run('/bin/sh', ['-c', cmd], { timeout: 15000 })
    console.log(`[projector] ${label}: comando ejecutado`)
    return { ok: true }
  } catch (e) {
    console.log(`[projector] ${label}: comando fallo -> ${e.message}`)
    return { ok: false, error: 'power_cmd_failed', detail: e.message }
  }
}

/** ¿Contesta el proyector en la red? Unica senal fiable de que encendio. */
async function reachable(c) {
  try {
    await run('ping', ['-c', '1', '-W', '1', c.host], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * Espera a que el proyector arranque.
 *
 * La senal es la RED, no ADB. La depuracion inalambrica sale desactivada en
 * cada arranque, asi que esperar ADB aqui garantizaba un `boot_timeout` incluso
 * cuando todo habia ido bien: el proyector encendido, Moonlight lanzado por su
 * propio `BootReceiver` y el escritorio ya en la pared. ADB, si aparece, es un
 * extra que permite empujar el stream desde aqui; su ausencia no es un fallo.
 */
async function waitForBoot(c, budgetMs) {
  const deadline = Date.now() + budgetMs
  let online = false
  while (Date.now() < deadline) {
    if (await adbReady(c)) return { online: true, adb: true }
    if (!online && (await reachable(c))) online = true
    // Ya en red: se le da un margen corto por si ADB llega, y se sigue.
    if (online && Date.now() > deadline - budgetMs * 0.5) return { online: true, adb: false }
    await sleep(3000)
  }
  return { online, adb: false }
}

/* -------------------------------------------------------------- moonlight */

/** El `uniqueid` con el que Moonlight identifica a ESTE portatil. */
async function localSunshineUuid() {
  try {
    const res = await fetch(`http://127.0.0.1:${SUNSHINE_HTTP_PORT}/serverinfo`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    const xml = await res.text()
    return xml.match(/<uniqueid>([^<]+)<\/uniqueid>/i)?.[1]?.trim() || null
  } catch {
    return null
  }
}

async function installedMoonlight(c) {
  try {
    const { stdout } = await adb(c, ['shell', 'pm', 'list', 'packages'], 8000)
    return MOONLIGHT_PACKAGES.find((p) => stdout.includes(`package:${p}`)) ?? null
  } catch {
    return null
  }
}

/**
 * Lanza Moonlight apuntando al portatil.
 *
 * Mismo truco que el widget Android (`Moonlight.kt`): el trampolin exportado
 * acepta un extra `UUID` y entra directo a esa maquina. Sin UUID, o si el
 * trampolin se niega, se abre la lista de PCs — degradar es preferible a no
 * proyectar nada.
 */
async function launchMoonlight(c, uuid) {
  const pkg = await installedMoonlight(c)
  if (!pkg) return { ok: false, error: 'moonlight_not_installed' }

  if (uuid) {
    const args = ['shell', 'am', 'start', '-n', `${pkg}/${TRAMPOLINE}`, '--es', 'UUID', uuid]
    if (c.appId) args.push('--es', 'AppId', c.appId)
    try {
      await adb(c, args, 10000)
      return { ok: true, mode: c.appId ? 'stream' : 'host', pkg }
    } catch (e) {
      console.log(`[projector] trampolin rechazado (${uuid}): ${e.message}`)
    }
  }
  try {
    await adb(c, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 10000)
    return { ok: true, mode: 'app', pkg }
  } catch (e) {
    return { ok: false, error: 'launch_failed', detail: e.message }
  }
}

/* ----------------------------------------------------------------- rutas */

/** GET /api/skills/projector/status */
export async function handleProjectorStatus(_req, res) {
  const c = cfg()
  if (!c.host) return json(res, 200, { ok: true, configured: false, reason: 'JARVIS_PROJECTOR_HOST sin definir' })

  const ready = await adbReady(c)
  const [screen, pkg, uuid] = ready
    ? await Promise.all([screenOn(c), installedMoonlight(c), localSunshineUuid()])
    : [false, null, await localSunshineUuid()]

  return json(res, 200, {
    ok: true,
    configured: true,
    label: c.label,
    host: (await resolveAddr(c)) ?? `${c.host}:?`,
    // `online` = hay ADB (control disponible). `powered` = contesta en la red.
    // Se separan porque lo NORMAL es powered sin online: el proyector arranca
    // con la depuracion inalambrica desactivada y aun asi esta proyectando.
    online: ready,
    powered: ready || (await reachable(c)),
    screenOn: screen,
    moonlight: pkg,
    sunshineUuid: uuid,
    canPowerOn: Boolean(c.onCmd),
    canPowerOff: Boolean(c.offCmd),
  })
}

/**
 * POST /api/skills/projector/on   { force?: boolean }
 *
 * Enciende si hace falta, espera al arranque y deja Moonlight en pantalla.
 * `force` salta la comprobacion de idempotencia (util si el proyector esta
 * encendido pero en otra entrada).
 */
export async function handleProjectorOn(req, res) {
  const c = cfg()
  if (!c.host) return json(res, 400, { ok: false, error: 'not_configured' })

  let body = {}
  try { body = (await readBody(req)) ?? {} } catch { /* cuerpo vacio es valido */ }

  const steps = []
  // La idempotencia se decide por la RED, nunca por ADB.
  //
  // Sondear con `adbReady` era un bug con dientes: la depuracion inalambrica
  // sale desactivada en cada arranque, asi que un proyector encendido y
  // proyectando responde `false`, el handler cree que esta apagado y manda el
  // pulso... que al ser un TOGGLE lo APAGA. Verificado en vivo: `on` sobre un
  // proyector ya encendido cortaba el stream.
  let ready = await adbReady(c)
  const powered = ready || (await reachable(c))
  steps.push({ step: 'probe', powered, adb: ready })

  if (!powered || body.force) {
    if (!c.onCmd) {
      return json(res, 503, {
        ok: false, error: 'power_cmd_missing',
        detail: 'proyector apagado y JARVIS_PROJECTOR_POWER_ON_CMD sin definir',
        steps,
      })
    }
    const pulse = await powerCmd(c.onCmd, 'encender')
    steps.push({ step: 'power', ...pulse })
    if (!pulse.ok) return json(res, 502, { ok: false, error: pulse.error, detail: pulse.detail, steps })

    const boot = await waitForBoot(c, c.bootWaitMs)
    ready = boot.adb
    steps.push({ step: 'boot', online: boot.online, adb: boot.adb })

    // Solo es fallo si NI SIQUIERA contesta en la red: eso si significa que el
    // pulso no encendio nada.
    if (!boot.online) {
      return json(res, 504, {
        ok: false, error: 'boot_timeout',
        detail: `${c.host} no responde tras ${Math.round(c.bootWaitMs / 1000)}s — el pulso no encendio`,
        steps,
      })
    }
    // En red pero sin ADB = caso NORMAL. El propio proyector lanza el stream
    // desde su `BootReceiver`, que es justo el diseno: no hay nada que empujar
    // desde aqui y esperar ADB solo produciria un falso `boot_timeout`.
    if (!boot.adb) {
      console.log('[projector] on -> encendido; el stream lo arranca el proyector')
      return json(res, 200, {
        ok: true,
        message: `${c.label} encendido — proyectando el escritorio`,
        selfStart: true,
        steps,
      })
    }
  }

  // Encendido pero sin ADB: no hay nada que empujar y NO se toca el power.
  // Este es el estado de reposo normal del sistema.
  if (!ready) {
    return json(res, 200, {
      ok: true,
      message: `${c.label} ya encendido`,
      selfStart: true,
      steps,
    })
  }

  // A partir de aqui hay ADB, asi que se puede empujar el stream (arranque en
  // el que la depuracion seguia activa, o encendido a mano con ella puesta).

  // Pantalla dormida: un toque de WAKEUP, no de POWER (POWER es un toggle y
  // apagaria lo que acaba de arrancar).
  if (!(await screenOn(c))) {
    try { await adb(c, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], 5000) } catch { /* best-effort */ }
    steps.push({ step: 'wake' })
  }

  const uuid = await localSunshineUuid()
  const launch = await launchMoonlight(c, uuid)
  steps.push({ step: 'launch', ...launch })

  const ok = launch.ok
  console.log(`[projector] on -> ${ok ? `proyectando (${launch.mode})` : launch.error}`)
  return json(res, ok ? 200 : 502, {
    ok,
    error: ok ? undefined : launch.error,
    detail: ok ? undefined : launch.detail,
    message: ok ? `${c.label} proyectando el escritorio` : undefined,
    steps,
  })
}

/**
 * POST /api/skills/projector/off
 *
 * Cierra el stream antes de cortar la corriente: matar el proceso en seco deja
 * la sesion de Sunshine colgada y el siguiente `on` entra en una sesion zombi.
 */
export async function handleProjectorOff(_req, res) {
  const c = cfg()
  if (!c.host) return json(res, 400, { ok: false, error: 'not_configured' })

  const steps = []
  if (await adbReady(c)) {
    const pkg = await installedMoonlight(c)
    if (pkg) {
      try { await adb(c, ['shell', 'am', 'force-stop', pkg], 8000); steps.push({ step: 'stop', pkg }) }
      catch (e) { steps.push({ step: 'stop', ok: false, detail: e.message }) }
    }
  }

  if (!c.offCmd) {
    return json(res, 200, {
      ok: true, powered: false,
      message: `${c.label}: stream cerrado (sin comando de apagado configurado)`,
      steps,
    })
  }
  const pulse = await powerCmd(c.offCmd, 'apagar')
  steps.push({ step: 'power', ...pulse })
  return json(res, pulse.ok ? 200 : 502, {
    ok: pulse.ok,
    error: pulse.ok ? undefined : pulse.error,
    message: pulse.ok ? `${c.label} apagado` : undefined,
    steps,
  })
}
