import { useEffect, useState } from 'react'
import { getApiBase } from '../api/client'

interface ObsidianStatus {
  ok: boolean
  configured: boolean
  vaultPath: string | null
  restApiReachable: boolean
  skeletonReady: boolean
}

export function ObsidianStatusBadge() {
  const [status, setStatus] = useState<ObsidianStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function fetchStatus() {
      try {
        const res = await fetch(`${getApiBase()}/api/obsidian/status`)
        const data = await res.json() as ObsidianStatus
        if (!cancelled) { setStatus(data); setLoading(false) }
      } catch {
        if (!cancelled) { setStatus(null); setLoading(false) }
      }
    }
    fetchStatus()
    const timer = setInterval(fetchStatus, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  if (loading) return null

  const configured = status?.configured ?? false
  const restOk     = status?.restApiReachable ?? false

  let label = 'No configurado'
  let color = '#ffd700'
  let icon  = '○'

  if (configured && restOk) {
    label = 'Conectado · API'
    color = '#64ffda'
    icon  = '●'
  } else if (configured) {
    label = 'Vault OK · API no disponible'
    color = '#7dd3fc'
    icon  = '◐'
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 9, letterSpacing: '2px', color: 'var(--cyan, #00e5ff)', opacity: 0.7, marginBottom: 6 }}>
        OBSIDIAN
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        border: `1px solid ${color}44`,
        borderRadius: 4,
        fontSize: 10,
      }}>
        <span style={{ color, fontSize: 12 }}>{icon}</span>
        <span style={{ flex: 1 }}>{label}</span>
      </div>
      {status?.vaultPath && (
        <>
          <div style={{ fontSize: 8, opacity: 0.5, marginTop: 4, wordBreak: 'break-all' }}>
            {status.vaultPath}
          </div>
          <button
            onClick={() => {
              const bridge = (window as any).electronBridge
              if (bridge?.openVault) bridge.openVault(status.vaultPath)
            }}
            style={{
              marginTop: 6,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid #00e5ff44',
              color: '#00e5ff',
              padding: '3px 8px',
              fontSize: 9,
              letterSpacing: '1px',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            ABRIR BÓVEDA
          </button>
        </>
      )}
      {!configured && (
        <div style={{ fontSize: 8, opacity: 0.6, marginTop: 4 }}>
          Set <code>JARVIS_OBSIDIAN_VAULT</code> env var. Ver docs/obsidian-integration-spec.md.
        </div>
      )}
    </div>
  )
}
