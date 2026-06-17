import { json, readBody } from '../lib/http.js'

const PC = process.env.PC_CONTROL_URL || 'http://localhost:8792'

async function proxyToPc(method, endpoint, body, res) {
  try {
    const r = await fetch(`${PC}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method !== 'GET' ? JSON.stringify(body) : undefined,
    })
    const data = await r.json()
    return json(res, r.status, data)
  } catch (e) {
    return json(res, 503, { ok: false, error: 'pc_control_unavailable', detail: e.message })
  }
}

async function withBody(req, handler, res) {
  try {
    const body = req.method === 'GET' ? {} : await readBody(req)
    return handler(body || {})
  } catch (e) {
    return json(res, 400, { ok: false, error: 'bad_request', detail: e.message })
  }
}

export async function handlePcWindows(req, res) {
  return proxyToPc('GET', '/windows', null, res)
}

export async function handlePcActiveWindow(req, res) {
  return proxyToPc('GET', '/active_window', null, res)
}

export async function handlePcReadUi(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/read_ui', body, res), res)
}

export async function handlePcLaunch(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/launch', body, res), res)
}

export async function handlePcFocus(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/focus', body, res), res)
}

export async function handlePcProcesses(req, res) {
  return proxyToPc('GET', '/processes', null, res)
}

export async function handlePcKill(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/kill', body, res), res)
}

export async function handlePcType(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/type', body, res), res)
}

export async function handlePcKeys(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/keys', body, res), res)
}

export async function handlePcClick(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/click', body, res), res)
}

export async function handlePcMouseMove(req, res) {
  return withBody(req, (body) => proxyToPc('POST', '/mouse_move', body, res), res)
}
