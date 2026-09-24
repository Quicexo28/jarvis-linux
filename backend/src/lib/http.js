export function json(res, code, payload) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.end(JSON.stringify(payload))
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Read the body as raw bytes, aborting once `maxBytes` is exceeded.
 *
 * The cap is enforced WHILE streaming rather than from Content-Length: that
 * header is a claim by the client, and a chunked upload carries none at all,
 * so trusting it would let a caller pin arbitrary memory before we ever look.
 * Rejects with `code = 'BODY_TOO_LARGE'` so the handler can answer 413.
 */
export function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (aborted) {
        // Se DRENA lo que queda en vez de cortar: destruir el socket aquí
        // impide que la respuesta 413 llegue nunca al cliente (curl y
        // HttpURLConnection ven la conexión cortada y ningún cuerpo, así que el
        // usuario recibiría "sin conexión" en vez de "archivo muy grande").
        // El tope duro está por si el emisor no piensa parar.
        if (size > maxBytes * 4) req.destroy()
        return
      }
      if (size > maxBytes) {
        aborted = true
        chunks.length = 0
        const error = new Error('body_too_large')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
    req.on('error', (error) => { if (!aborted) reject(error) })
  })
}
