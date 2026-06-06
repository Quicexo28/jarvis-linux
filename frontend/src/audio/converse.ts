// Streaming turn client. POSTs to /api/jarvis/converse and reads the NDJSON
// response, dispatching one event per line:
//   {type:'sentence', text}  — a complete spoken sentence, as Claude generates
//   {type:'done', ...result} — final structured turn result
//   {type:'error', error}    — backend failure
//
// The caller speaks each sentence in order so audio starts on sentence 1 while
// Claude is still writing the rest. Resolves when the stream ends.

export interface ConverseHandlers {
  onSentence?: (text: string) => void
  onDone?: (result: any) => void
  signal?: AbortSignal
}

export async function streamConverse(
  url: string,
  payload: unknown,
  h: ConverseHandlers = {},
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: h.signal,
  })
  if (!res.ok || !res.body) throw new Error(`converse_http_${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: any
    try { msg = JSON.parse(trimmed) } catch { return }
    if (msg.type === 'sentence') h.onSentence?.(String(msg.text ?? ''))
    else if (msg.type === 'done') h.onDone?.(msg)
    else if (msg.type === 'error') throw new Error(`converse_${msg.error}`)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      handleLine(line)
    }
  }
  if (buf) handleLine(buf)
}
