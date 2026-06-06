/**
 * DisplayCard — on-screen overlay for content that's awkward to say out loud:
 * file paths, URLs, addresses, math formulas, tables, and pick-a-file candidate
 * lists. Driven by displayStore; Jarvis pushes content via the skill bus so the
 * voice reply can stay a short natural summary while the exact text shows here.
 */

import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { useDisplayStore, type DisplayCardData } from '../state/displayStore'

const PALETTE = {
  bg: 'rgba(8, 14, 20, 0.92)',
  border: 'rgba(56, 213, 255, 0.55)',
  glow: 'rgba(56, 213, 255, 0.25)',
  accent: '#38d5ff',
  text: '#e8f6ff',
  dim: '#7fa6b8',
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {})
}

// Reveal a path/file in the OS file explorer, if the Electron bridge exposes it.
function revealInExplorer(path: string) {
  const bridge = (window as any).electronBridge
  if (bridge?.showInFolder) bridge.showInFolder(path)
}

function Formula({ latex }: { latex: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    try {
      katex.render(latex, ref.current, { throwOnError: false, displayMode: true })
    } catch {
      ref.current.textContent = latex
    }
  }, [latex])
  return <div ref={ref} style={{ fontSize: 22, color: PALETTE.text, padding: '8px 0' }} />
}

function Btn({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: `1px solid ${PALETTE.border}`,
        color: PALETTE.accent,
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

// Split a markdown table row into trimmed cells, dropping the empty edges that
// surround leading/trailing pipes.
function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
}

// A separator row like |---|:--:|---| (the line under the header).
function isSeparator(line: string): boolean {
  return /\|/.test(line) && /^[\s|:-]+$/.test(line) && /-/.test(line)
}

// Render markdown content. Tables (GFM pipe syntax) become real <table>s; every
// other line is plain text. Keeps it dependency-free — covers the cases Jarvis
// actually emits (tables, paths, short notes) without a full markdown engine.
function MarkdownBody({ text }: { text: string }) {
  const lines = String(text ?? '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]
    const next = lines[i + 1] ?? ''
    // Table start: a header row followed by a separator row.
    if (line.includes('|') && isSeparator(next)) {
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push(
        <table key={key++} style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, margin: '6px 0' }}>
          <thead>
            <tr>
              {header.map((h, c) => (
                <th key={c} style={{ border: '1px solid rgba(56,213,255,0.3)', padding: '4px 8px', textAlign: 'left', color: '#38d5ff', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, ci) => (
                  <td key={ci} style={{ border: '1px solid rgba(56,213,255,0.18)', padding: '4px 8px', color: '#e8f6ff' }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
      continue
    }
    // Non-table line. Skip blank lines but keep paragraph spacing.
    if (line.trim()) {
      blocks.push(<div key={key++} style={{ color: '#e8f6ff', lineHeight: 1.5 }}>{line}</div>)
    } else {
      blocks.push(<div key={key++} style={{ height: 6 }} />)
    }
    i++
  }

  return <div>{blocks}</div>
}

function Body({ card }: { card: DisplayCardData }) {
  const mono: CSSProperties = {
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    fontSize: 14,
    color: PALETTE.text,
    wordBreak: 'break-all',
    lineHeight: 1.5,
  }

  switch (card.kind) {
    case 'formula':
      return <Formula latex={card.body ?? ''} />

    case 'url':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <a href={card.body} target="_blank" rel="noreferrer" style={{ ...mono, color: PALETTE.accent }}>
            {card.body}
          </a>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={() => copy(card.body ?? '')}>Copiar</Btn>
          </div>
        </div>
      )

    case 'path':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={mono}>{card.body}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={() => copy(card.body ?? '')}>Copiar</Btn>
            <Btn onClick={() => revealInExplorer(card.body ?? '')}>Abrir carpeta</Btn>
          </div>
        </div>
      )

    case 'candidates':
      return (
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(card.items ?? []).map((it, i) => (
            <li key={i} style={{ color: PALETTE.text }}>
              <span style={{ fontWeight: 600 }}>{it.label}</span>
              {it.meta && <span style={{ color: PALETTE.dim, fontSize: 12 }}> — {it.meta}</span>}
            </li>
          ))}
        </ol>
      )

    case 'markdown':
      return <MarkdownBody text={card.body ?? ''} />

    case 'text':
    default:
      return <div style={{ ...mono, whiteSpace: 'pre-wrap' }}>{card.body}</div>
  }
}

export function DisplayCard() {
  const visible = useDisplayStore((s) => s.visible)
  const card = useDisplayStore((s) => s.card)
  const hide = useDisplayStore((s) => s.hide)

  // Esc closes the card.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, hide])

  if (!visible || !card) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0, right: 0, bottom: 0, left: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 6vw',
        pointerEvents: 'none',
        zIndex: 4000,
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          minWidth: 320,
          maxWidth: 520,
          background: PALETTE.bg,
          border: `1px solid ${PALETTE.border}`,
          borderRadius: 12,
          boxShadow: `0 0 40px ${PALETTE.glow}, inset 0 0 20px rgba(0,0,0,0.4)`,
          backdropFilter: 'blur(8px)',
          color: PALETTE.text,
          padding: 18,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ color: PALETTE.accent, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>
            {card.title ?? 'Información'}
          </span>
          <button
            onClick={hide}
            style={{ background: 'transparent', border: 'none', color: PALETTE.dim, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
        <Body card={card} />
        {card.caption && (
          <div style={{ marginTop: 10, color: PALETTE.dim, fontSize: 12 }}>{card.caption}</div>
        )}
      </div>
    </div>
  )
}
