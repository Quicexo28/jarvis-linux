/**
 * Split a line of display text into plain and LaTeX segments.
 *
 * The voice brain writes step-by-step derivations as markdown with math
 * between dollar signs; `DisplayCard` renders the math segments with KaTeX and
 * the rest as plain text. Pure (no DOM) so it stays Node-testable.
 *
 *   `$$…$$` → display math, `$…$` → inline math. `\$` is a literal dollar.
 *   An unclosed `$` is text, never math: "cuesta $5" must not swallow the line.
 */
export type MathSegment = { kind: 'text' | 'inline' | 'display'; value: string }

export function splitMath(line: string): MathSegment[] {
  const out: MathSegment[] = []
  let text = ''
  let i = 0
  const flush = () => {
    if (text) out.push({ kind: 'text', value: text })
    text = ''
  }
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '$') {
      text += '$'
      i += 2
      continue
    }
    if (ch === '$') {
      const display = line[i + 1] === '$'
      const open = display ? 2 : 1
      const close = display ? line.indexOf('$$', i + 2) : findInlineClose(line, i + 1)
      if (close > i + open - 1 && close !== -1) {
        const value = line.slice(i + open, close).trim()
        if (value) {
          flush()
          out.push({ kind: display ? 'display' : 'inline', value })
          i = close + open
          continue
        }
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

function findInlineClose(line: string, from: number): number {
  for (let j = from; j < line.length; j++) {
    if (line[j] === '\\') { j++; continue }
    if (line[j] === '$') return j
  }
  return -1
}

/**
 * Group lines so a `$$` block spanning several lines becomes one line:
 *   $$
 *   E = mc^2
 *   $$
 * Anything else passes through untouched.
 */
export function joinMathBlocks(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('$$') && (t === '$$' || !t.slice(2).includes('$$'))) {
      const end = lines.findIndex((l, j) => j > i && l.includes('$$'))
      if (end !== -1) {
        const inner = [t.slice(2), ...lines.slice(i + 1, end), lines[end].slice(0, lines[end].indexOf('$$'))]
        out.push(`$$${inner.join(' ').trim()}$$`)
        i = end
        continue
      }
    }
    out.push(lines[i])
  }
  return out
}
