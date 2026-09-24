#!/usr/bin/env node
/**
 * Puente minimo a Tuya Cloud para el blaster IR (VTA-84660 y cualquier otro
 * rebrand de Tuya: la app "VTA Casa Inteligente" es Smart Life por dentro).
 *
 * Por que escenas y no la API de infrarrojos: mandar un codigo IR crudo exige
 * conocer el par (remote_id, key) que la app genero al aprender el boton, y ese
 * catalogo cambia si reemparejas el mando. Una escena "Tap-to-Run" es un ID
 * estable que la app crea una vez y que aqui solo hay que disparar — un POST,
 * sin catalogo que mantener.
 *
 * Uso:
 *   tuya-ir.mjs homes                 lista casas (necesitas el home_id)
 *   tuya-ir.mjs scenes <home_id>      lista escenas con su ID
 *   tuya-ir.mjs run <home_id> <id>    dispara una escena  <- lo que usa Jarvis
 *   tuya-ir.mjs devices               lista dispositivos (para verificar el blaster)
 *
 * Env (en backend/secrets.local.json o exportadas):
 *   TUYA_CLIENT_ID, TUYA_SECRET   de iot.tuya.com -> Cloud -> tu proyecto
 *   TUYA_REGION                   us | eu | cn | in   (default: us)
 */

import crypto from 'node:crypto'

/**
 * Ojo con el data center: NO basta con acertar el continente.
 *
 * Tuya parte America en dos y Colombia cae en **Eastern America**, no en la
 * Western que uno supondria. Con el equivocado el proyecto se crea igual y el
 * token se emite igual, pero la lista de dispositivos vuelve VACIA y el QR de
 * vinculacion se marca como caducado nada mas escanearlo — ningun error dice
 * "region equivocada". Sintoma de que un DC no esta habilitado en el proyecto:
 * codigo 28841107 "data center is suspended".
 */
const REGIONS = {
  us: 'https://openapi.tuyaus.com',        // Western America
  'us-e': 'https://openapi-ueaz.tuyaus.com', // Eastern America  <- Colombia
  eu: 'https://openapi.tuyaeu.com',        // Central Europe
  'eu-w': 'https://openapi-weaz.tuyaeu.com', // Western Europe
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
}

const CLIENT_ID = process.env.TUYA_CLIENT_ID
const SECRET = process.env.TUYA_SECRET
const BASE = REGIONS[process.env.TUYA_REGION ?? 'us'] ?? REGIONS.us

if (!CLIENT_ID || !SECRET) {
  console.error('falta TUYA_CLIENT_ID o TUYA_SECRET')
  process.exit(2)
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex').toUpperCase()

/**
 * Firma de Tuya. El bloque a firmar es METHOD\nSHA256(body)\nheaders\npath, y
 * el prefijo cambia segun haya token o no: sin token (login) es client_id+t+nonce,
 * con token se intercala el access_token. Equivocar el prefijo da 1004 "sign
 * invalid", que es el error que se lleva la tarde de todo el mundo.
 */
async function call(method, path, { body, token } = {}) {
  const t = Date.now().toString()
  const nonce = crypto.randomUUID()
  const payload = body ? JSON.stringify(body) : ''
  const stringToSign = [method, sha256(payload), '', path].join('\n')
  const sign = hmac(CLIENT_ID + (token ?? '') + t + nonce + stringToSign)

  const headers = {
    client_id: CLIENT_ID,
    sign, t, nonce,
    sign_method: 'HMAC-SHA256',
    'Content-Type': 'application/json',
  }
  if (token) headers.access_token = token

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: payload || undefined,
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json()
  if (!data.success) {
    throw new Error(`tuya ${data.code}: ${data.msg} (${method} ${path})`)
  }
  return data.result
}

const token = async () => (await call('GET', '/v1.0/token?grant_type=1')).access_token

/* -------------------------------------------------------------- comandos */

const [cmd, ...args] = process.argv.slice(2)

try {
  const tk = await token()

  if (cmd === 'homes') {
    // El uid del dueño sale del primer dispositivo; Tuya no expone "mis casas"
    // sin uid, y pedirlo a mano es un paso mas que se olvida.
    const devs = await call('GET', '/v1.0/iot-01/associated-users/devices', { token: tk })
    const uid = devs?.devices?.[0]?.uid
    if (!uid) throw new Error('sin dispositivos asociados: vincula la app en iot.tuya.com -> Cloud -> Devices -> Link App Account')
    const homes = await call('GET', `/v1.0/users/${uid}/homes`, { token: tk })
    for (const h of homes) console.log(`${h.home_id}\t${h.name}`)

  } else if (cmd === 'devices') {
    const devs = await call('GET', '/v1.0/iot-01/associated-users/devices', { token: tk })
    for (const d of devs.devices ?? []) {
      console.log(`${d.id}\t${d.category}\t${d.online ? 'online' : 'offline'}\t${d.name}`)
    }

  } else if (cmd === 'scenes') {
    const [homeId] = args
    if (!homeId) throw new Error('uso: tuya-ir.mjs scenes <home_id>')
    const scenes = await call('GET', `/v1.1/homes/${homeId}/scenes`, { token: tk })
    // El id viene como `scene_id`; `id` a secas es undefined y el disparo falla
    // luego con un 404 poco explicativo.
    for (const s of scenes.list ?? scenes) {
      const acts = s.actions?.length ?? 0
      // Informativo, NO un error: el power de un mando IR es un toggle, asi que
      // el numero de pulsos importa. Aqui dos son lo correcto — el proyector
      // pide confirmacion para apagarse — y sirven tambien para encender,
      // porque el segundo cae en la ventana muerta del arranque.
      const warn = acts > 1 ? `  (${acts} pulsos)` : ''
      console.log(`${s.scene_id ?? s.id}\t${s.name}${warn}`)
    }

  } else if (cmd === 'run') {
    const [homeId, sceneId] = args
    if (!homeId || !sceneId) throw new Error('uso: tuya-ir.mjs run <home_id> <scene_id>')
    await call('POST', `/v1.0/homes/${homeId}/scenes/${sceneId}/trigger`, { token: tk })
    console.log('ok')

  } else {
    console.error('comandos: homes | devices | scenes <home_id> | run <home_id> <scene_id>')
    process.exit(2)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
