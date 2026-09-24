/**
 * Design tokens for the remote app (phone/tablet web UI + Android WebView).
 *
 * One accent, one surface ladder, one spacing scale — the whole point is that
 * every screen looks assembled from the same parts. Inline styles (like the
 * rest of the frontend) so this ships without a CSS pipeline of its own.
 */
export const T = {
  bg:        '#05070d',
  surface:   '#0b1018',
  surfaceUp: '#111a26',
  line:      '#1b2635',
  lineSoft:  '#141d29',
  text:      '#e6edf7',
  dim:       '#8ea0b8',
  faint:     '#5c6b80',
  accent:    '#00e5ff',
  ok:        '#4ade80',
  warn:      '#fbbf24',
  bad:       '#f87171',
  radius:    14,
  font:      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
  mono:      'ui-monospace, SFMono-Regular, Menlo, monospace',
} as const

import type { CSSProperties as CSS } from 'react'

export const S: Record<string, CSS> = {
  screen: {
    display: 'flex', flexDirection: 'column', height: '100dvh',
    background: T.bg, color: T.text, fontFamily: T.font,
    fontSize: 15, lineHeight: 1.45, WebkitTapHighlightColor: 'transparent',
  },
  // Deliberately thin: on a tablet held in the hand the header is pure chrome,
  // and every pixel it takes comes out of the content. It carries the wordmark
  // and a status dot; the status *word* only appears when something is wrong
  // (see RemoteApp), because "en línea" told the user nothing they didn't
  // already know from the app responding.
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 18px 6px', borderBottom: `1px solid ${T.lineSoft}`,
    paddingTop: 'calc(6px + env(safe-area-inset-top))', background: T.bg,
  },
  wordmark: { fontSize: 11, letterSpacing: '2.5px', fontWeight: 600, color: T.dim },
  content: { flex: 1, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column' },
  // Phone-first, but a tablet or a desktop browser must not stretch a chat
  // bubble across 1500 px — everything lives inside one centered column. Flex
  // (not minHeight) so the chat composer can stick to the bottom of the screen.
  column: { width: '100%', maxWidth: 620, margin: '0 auto', padding: '16px 16px 24px', flex: 1, display: 'flex', flexDirection: 'column' },
  bar: { width: '100%', maxWidth: 620, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  nav: { borderTop: `1px solid ${T.lineSoft}`, background: T.surface, paddingBottom: 'env(safe-area-inset-bottom)' },
  navInner: { width: '100%', maxWidth: 620, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' },
  navItem: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: '10px 0 8px', background: 'none', border: 'none', cursor: 'pointer',
    fontFamily: T.font, fontSize: 10, letterSpacing: '0.5px',
  },
  card: {
    background: T.surface, border: `1px solid ${T.line}`, borderRadius: T.radius,
    padding: 16, marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 11, letterSpacing: '1.6px', textTransform: 'uppercase',
    color: T.faint, margin: '4px 2px 10px', fontWeight: 600,
  },
  rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  btn: {
    minHeight: 44, padding: '0 16px', borderRadius: 10, cursor: 'pointer',
    background: T.surfaceUp, border: `1px solid ${T.line}`, color: T.text,
    fontFamily: T.font, fontSize: 14, fontWeight: 500,
  },
  btnAccent: {
    minHeight: 44, padding: '0 16px', borderRadius: 10, cursor: 'pointer',
    background: 'rgba(0,229,255,0.12)', border: `1px solid rgba(0,229,255,0.45)`,
    color: T.accent, fontFamily: T.font, fontSize: 14, fontWeight: 600,
  },
  btnGhost: {
    minHeight: 36, padding: '0 12px', borderRadius: 9, cursor: 'pointer',
    background: 'transparent', border: `1px solid ${T.line}`, color: T.dim,
    fontFamily: T.font, fontSize: 13,
  },
  input: {
    flex: 1, minHeight: 44, padding: '0 14px', borderRadius: 10,
    background: T.surfaceUp, border: `1px solid ${T.line}`, color: T.text,
    fontFamily: T.font, fontSize: 15, outline: 'none',
  },
  badge: {
    fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', fontWeight: 600,
    padding: '3px 8px', borderRadius: 999, border: `1px solid ${T.line}`,
    color: T.dim, whiteSpace: 'nowrap',
  },
  label: { fontSize: 12, color: T.dim },
  value: { fontSize: 15, fontFamily: T.mono, color: T.text },
  hint: { fontSize: 12, color: T.faint, lineHeight: 1.5 },
}

/** Small colored status dot with a matching glow. */
export function dotStyle(color: string): CSS {
  return { width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }
}

/** Thin horizontal meter used for CPU/RAM/disk. */
export function meterFill(pct: number): CSS {
  const p = Math.max(0, Math.min(100, pct))
  const color = p > 90 ? T.bad : p > 70 ? T.warn : T.accent
  return { width: `${p}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.4s ease' }
}
