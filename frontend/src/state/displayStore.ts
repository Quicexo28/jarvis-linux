import { create } from 'zustand'

/**
 * Display store — drives the on-screen "card" overlay (DisplayCard) that shows
 * things awkward to verbalize: file paths, URLs, addresses, math formulas,
 * tables, and pick-a-file candidate lists. Jarvis pushes content via the skill
 * bus (`display_show` / `display_hide` primitives) instead of reading it aloud.
 */

export type DisplayKind = 'path' | 'url' | 'formula' | 'text' | 'markdown' | 'candidates'

export interface DisplayCandidate {
  label: string          // shown name, e.g. "informe.pdf"
  value: string          // real value, e.g. full path
  meta?: string          // optional detail, e.g. "2.3 MB · Descargas"
}

export interface DisplayCardData {
  kind: DisplayKind
  title?: string         // optional header, e.g. "Ruta movida"
  body?: string          // main content: path / url / LaTeX / text / markdown
  items?: DisplayCandidate[] // for kind === 'candidates'
  caption?: string       // small footnote under the content
}

interface DisplayState {
  visible: boolean
  card: DisplayCardData | null
  show: (card: DisplayCardData) => void
  hide: () => void
}

export const useDisplayStore = create<DisplayState>((set) => ({
  visible: false,
  card: null,
  show: (card) => set({ visible: true, card }),
  hide: () => set({ visible: false }),
}))
