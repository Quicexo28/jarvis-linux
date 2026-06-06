import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

type TabId = 'claude' | 'stt' | 'xtts' | 'backend' | 'all'

interface ProcLogEntry {
  service: string
  stream: string
  text: string
  timestamp: number
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'backend', label: 'Backend' },
  { id: 'stt', label: 'STT' },
  { id: 'xtts', label: 'XTTS' },
  { id: 'all', label: 'All' },
]

const SERVICE_COLORS: Record<string, string> = {
  xtts: '\x1b[36m',
  stt: '\x1b[32m',
  backend: '\x1b[33m',
  claude: '\x1b[35m',
}
const RESET = '\x1b[0m'
const RED = '\x1b[31m'

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

const bridge = (window as any).electronBridge

export function CoreTerminal({ onClose }: { onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>('claude')
  const [services, setServices] = useState<Record<string, boolean>>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const inputLineRef = useRef('')
  const busyRef = useRef(false)
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

      if (bridge?.getServices) {
        bridge.getServices().then((info: any) => {
          if (disposed) return
          setServices({ xtts: info.xtts, stt: info.stt, backend: info.backend })
          if (info.buffers) {
            for (const [svc, entries] of Object.entries(info.buffers)) {
              for (const entry of entries as ProcLogEntry[]) {
                const line = `${SERVICE_COLORS[svc] || ''}[${svc}]${RESET} ${entry.text}`
                if (!logsRef.current[svc]) logsRef.current[svc] = []
                logsRef.current[svc].push(line)
                logsRef.current.all.push(line)
              }
            }
          }
        })
      }

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
      if (busyRef.current) return

      if (data === '\r') {
        term.write('\r\n')
        const line = inputLineRef.current.trim()
        inputLineRef.current = ''
        if (!line) { writePrompt(); return }
        busyRef.current = true
        if (bridge?.execClaude) {
          bridge.execClaude(line)
        }
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

  // Subscribe to Claude stream
  useEffect(() => {
    if (!bridge?.onClaudeStream) return
    const unsub = bridge.onClaudeStream((msg: { stream: string; text: string }) => {
      const term = termRef.current
      if (!term) return
      if (msg.stream === 'stdout') {
        term.write(msg.text)
      } else if (msg.stream === 'stderr') {
        term.write(`${RED}${msg.text}${RESET}`)
      } else if (msg.stream === 'done') {
        term.write('\r\n')
        busyRef.current = false
        writePrompt()
      } else if (msg.stream === 'error') {
        term.write(`\r\n${RED}Error: ${msg.text}${RESET}\r\n`)
        busyRef.current = false
        writePrompt()
      }
    })
    return unsub
  }, [writePrompt])

  // Subscribe to process logs
  useEffect(() => {
    if (!bridge?.onProcLog) return
    const unsub = bridge.onProcLog((entry: ProcLogEntry) => {
      const color = entry.stream === 'stderr' ? RED : (SERVICE_COLORS[entry.service] || '')
      const line = `${color}[${entry.service}]${RESET} ${entry.text}`

      if (!logsRef.current[entry.service]) logsRef.current[entry.service] = []
      logsRef.current[entry.service].push(line)
      if (logsRef.current[entry.service].length > 5000) logsRef.current[entry.service].shift()
      logsRef.current.all.push(line)
      if (logsRef.current.all.length > 5000) logsRef.current.all.shift()

      const term = termRef.current
      if (!term) return
      const tab = activeTabRef.current
      if (tab === entry.service || tab === 'all') {
        term.write(line)
      }
    })
    return unsub
  }, [])

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
              {(t.id !== 'claude' && services[t.id] !== undefined) && (
                <span className={`proc-dot ${services[t.id] ? 'on' : 'off'}`} />
              )}
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
