/**
 * Mail — read-only access to the owner's inbox over IMAP.
 *
 * IMAP + an app password instead of the Gmail API for the same reason the
 * calendar uses ICS: no OAuth client to register and refresh. Gmail: enable
 * 2-step verification, create an app password, put it in secrets.local.json.
 *
 *   JARVIS_IMAP_USER  (required)  e.g. santiago@gmail.com
 *   JARVIS_IMAP_PASS  (required)  the 16-char app password, NOT the account one
 *   JARVIS_IMAP_HOST  (imap.gmail.com)   JARVIS_IMAP_PORT (993)
 *
 * READ ONLY by design: listing and reading. Sending mail on the owner's behalf
 * is an outward action that would need its own confirmation flow, and marking
 * messages read would change his inbox behind his back — so every fetch here
 * uses BODY.PEEK semantics (imapflow does not set \Seen on fetch/download).
 *
 * imapflow is imported lazily: the backend must boot even if the dependency is
 * missing or mail is not configured.
 */

const MAX_LIST = 25
const MAX_BODY = 6000
const TIMEOUT_MS = 20_000

function config() {
  const user = process.env.JARVIS_IMAP_USER
  const pass = process.env.JARVIS_IMAP_PASS
  if (!user || !pass) return null
  return {
    host: process.env.JARVIS_IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.JARVIS_IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: TIMEOUT_MS,
  }
}

export function mailConfigured() {
  return !!config()
}

async function withClient(fn) {
  const cfg = config()
  if (!cfg) {
    const err = new Error('mail_not_configured')
    err.code = 'mail_not_configured'
    throw err
  }
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow(cfg)
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      return await fn(client)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

function addr(list) {
  const a = list?.[0]
  if (!a) return null
  return { name: a.name || null, address: a.address || null }
}

/**
 * Build the IMAP SEARCH criteria. Pure — exported for tests.
 * @param {{unread?: boolean, query?: string, sinceDays?: number, from?: string}} o
 */
export function searchCriteria({ unread = false, query, sinceDays, from } = {}, now = Date.now()) {
  const c = {}
  if (unread) c.seen = false
  if (sinceDays) c.since = new Date(now - Number(sinceDays) * 86400e3)
  if (from) c.from = String(from)
  const q = String(query || '').trim()
  if (q) c.or = [{ subject: q }, { from: q }, { body: q }]
  return Object.keys(c).length ? c : { all: true }
}

/**
 * Newest messages matching the filters (headers only).
 * @returns {Promise<{ok: true, total: number, messages: object[]}>}
 */
export async function inbox({ unread = true, limit = 10, query, sinceDays, from } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 10, MAX_LIST))
  return withClient(async (client) => {
    const uids = (await client.search(searchCriteria({ unread, query, sinceDays, from }), { uid: true })) || []
    const pick = uids.slice(-n) // UIDs ascend with arrival, newest last
    const messages = []
    if (pick.length) {
      for await (const m of client.fetch(pick, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
        messages.push({
          uid: m.uid,
          from: addr(m.envelope?.from),
          subject: m.envelope?.subject || '(sin asunto)',
          date: (m.internalDate || m.envelope?.date)?.toISOString?.() ?? null,
          unread: !m.flags?.has('\\Seen'),
        })
      }
    }
    messages.sort((a, b) => String(b.date).localeCompare(String(a.date)))
    return { ok: true, total: uids.length, messages }
  })
}

/** Find the best text part in a bodystructure: text/plain, else text/html. Exported for tests. */
export function textPart(node) {
  let html = null
  const walk = (n) => {
    if (!n) return null
    const type = String(n.type || '').toLowerCase()
    if (type === 'text/plain' && n.disposition !== 'attachment') return n.part || '1'
    if (type === 'text/html' && !html && n.disposition !== 'attachment') html = n.part || '1'
    for (const c of n.childNodes || []) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  const plain = walk(node)
  return plain ? { part: plain, html: false } : html ? { part: html, html: true } : null
}

/** HTML → readable text, crude on purpose (it is going to be summarised). Exported for tests. */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function streamToString(stream, max) {
  let out = ''
  for await (const chunk of stream) {
    out += chunk.toString('utf8')
    if (out.length > max * 3) break
  }
  return out
}

/** One message's headers + body text (truncated). Does NOT mark it read. */
export async function readMessage(uid) {
  const id = Number(uid)
  if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error('invalid_uid'), { code: 'invalid_uid' })
  return withClient(async (client) => {
    const m = await client.fetchOne(id, { uid: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: true })
    if (!m) throw Object.assign(new Error('not_found'), { code: 'not_found' })
    const tp = textPart(m.bodyStructure)
    let text = ''
    if (tp) {
      const { content } = await client.download(id, tp.part, { uid: true })
      text = await streamToString(content, MAX_BODY)
      if (tp.html) text = htmlToText(text)
    }
    return {
      ok: true,
      uid: id,
      from: addr(m.envelope?.from),
      to: (m.envelope?.to || []).map((a) => a.address).filter(Boolean),
      subject: m.envelope?.subject || '(sin asunto)',
      date: m.internalDate?.toISOString?.() ?? null,
      text: text.replace(/\r/g, '').trim().slice(0, MAX_BODY),
      truncated: text.length > MAX_BODY,
    }
  })
}
