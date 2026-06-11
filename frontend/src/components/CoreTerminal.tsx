import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

type TabId = 'claude' | 'stt' | 'xtts' | 'backend' | 'all'

const TABS: { id: TabId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'backend', label: 'Backend' },
  { id: 'stt', label: 'STT' },
  { id: 'xtts', label: 'XTTS' },
  { id: 'all', label: 'All' },
]

const THEME = {
  background: '#0a0e14',
  foreground: '#c8f4ff',
  cursor: '#00f0ff',
  cursorAccent: '#0a0e14',
  selectionBackground: 'rgba(0, 240, 255, 0.2)',
  selectionForeground: '#ffffff',
  black: '#03080d',
  red: '#ff5252',
  green: '#64ffda',
  yellow: '#ffd700',
  blue: '#00b8d4',
  magenta: '#ce93d8',
  cyan: '#00f0ff',
  white: '#c8f4ff',
  brightBlack: '#546e7a',
  brightRed: '#ff8a80',
  brightGreen: '#b9f6ca',
  brightYellow: '#ffe082',
  brightBlue: '#80d8ff',
  brightMagenta: '#ea80fc',
  brightCyan: '#84ffff',
  brightWhite: '#ffffff',
}

export function CoreTerminal({ onClose }: { onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>('claude')
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputLineRef = useRef('')
  const logsRef = useRef<Record<string, string[]>>({ xtts: [], stt: [], backend: [], all: [] })
  const activeTabRef = useRef<TabId>(activeTab)

  activeTabRef.current = activeTab

  const createTerminal = useCallback(() => {
    if (!containerRef.current) return
    if (termRef.current) {
      termRef.current.dispose()
    }
    const term = new Terminal({
      theme: THEME,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    return term
  }, [])

  const writePrompt = useCallback(() => {
    if (!termRef.current) return
    termRef.current.write('\x1b[36mjarvis>\x1b[0m ')
  }, [])

  const replayLogs = useCallback((tab: TabId) => {
    if (!termRef.current) return
    termRef.current.clear()
    const lines = tab === 'claude' ? [] : (logsRef.current[tab] || [])
    for (const line of lines) {
      termRef.current.write(line)
    }
    if (tab === 'claude') writePrompt()
  }, [writePrompt])

  // Init terminal with delay for expand animation
  useEffect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      if (disposed) return
      const term = createTerminal()
      if (!term) return

      writePrompt()
    }, 150)

    return () => { disposed = true; clearTimeout(timer); termRef.current?.dispose() }
  }, [createTerminal, writePrompt])

  // Handle Claude tab input
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    const disposable = term.onData((data) => {
      if (activeTabRef.current !== 'claude') return

      if (data === '\r') {
        term.write('\r\n')
        inputLineRef.current = ''
        writePrompt()
      } else if (data === '\x7f') {
        if (inputLineRef.current.length > 0) {
          inputLineRef.current = inputLineRef.current.slice(0, -1)
          term.write('\b \b')
        }
      } else if (data >= ' ') {
        inputLineRef.current += data
        term.write(data)
      }
    })

    return () => disposable.dispose()
  }, [writePrompt])

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(() => { fitRef.current?.fit() })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Tab switch
  useEffect(() => {
    replayLogs(activeTab)
  }, [activeTab, replayLogs])

  return (
    <div className="core-terminal">
      <div className="core-terminal-header">
        <div className="core-terminal-tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`core-terminal-tab${activeTab === t.id ? ' active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {onClose && (
          <button className="core-terminal-back" onClick={onClose}>← Volver</button>
        )}
      </div>
      <div className="core-terminal-body" ref={containerRef} />
    </div>
  )
}
