/**
 * UnlockGate — first-run owner unlock on a new PC.
 *
 * On AWAKE it asks the backend whether the portable owner vault is locked
 * (typically a fresh install). If so, it shows a blocking password modal; the
 * password is sent to /api/security/unlock, which decrypts the vault, caches it
 * locally (DPAPI), and reloads the voiceprint. After that the PC boots
 * hands-free and the modal never shows again.
 */

import { useEffect, useRef, useState } from 'react'
import { getApiBase } from '../api/client'

const PALETTE = {
  bg: 'rgba(8, 14, 20, 0.97)',
  border: 'rgba(56, 213, 255, 0.55)',
  glow: 'rgba(56, 213, 255, 0.25)',
  accent: '#38d5ff',
  text: '#e8f6ff',
  dim: '#7fa6b8',
  err: '#ff6b6b',
}

export function UnlockGate() {
  const [needsUnlock, setNeedsUnlock] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    fetch(`${getApiBase()}/api/security/status`)
      .then((r) => r.json())
      .then((s) => { if (alive && s && s.needsUnlock) setNeedsUnlock(true) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (needsUnlock) setTimeout(() => inputRef.current?.focus(), 50)
  }, [needsUnlock])

  if (!needsUnlock) return null

  const submit = async () => {
    if (!value || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${getApiBase()}/api/security/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: value }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setNeedsUnlock(false)
        setValue('')
      } else {
        setError(data.spoken || 'No pude desbloquear.')
      }
    } catch {
      setError('Error de conexión con el backend.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
    >
      <div style={{
        width: 440, maxWidth: '90vw', padding: '30px 30px 26px',
        background: PALETTE.bg, border: `1px solid ${PALETTE.border}`,
        borderRadius: 16, boxShadow: `0 0 48px ${PALETTE.glow}`,
        color: PALETTE.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}>
        <div style={{ fontSize: 13, letterSpacing: 1.5, color: PALETTE.accent, textTransform: 'uppercase', marginBottom: 10 }}>
          Identificación de owner
        </div>
        <div style={{ fontSize: 16, marginBottom: 6 }}>Desbloquear Jarvis en este equipo</div>
        <div style={{ fontSize: 13, color: PALETTE.dim, marginBottom: 18, lineHeight: 1.4 }}>
          Ingrese su contraseña de owner para activar el reconocimiento de su voz en esta PC. Solo se pide una vez por equipo.
        </div>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Contraseña de owner"
          autoComplete="off"
          disabled={busy}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '12px 14px',
            background: 'rgba(0,0,0,0.4)', border: `1px solid ${error ? PALETTE.err : PALETTE.border}`,
            borderRadius: 8, color: PALETTE.text, fontSize: 16, outline: 'none', letterSpacing: 2,
          }}
        />
        {error && <div style={{ color: PALETTE.err, fontSize: 13, marginTop: 10 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button
            onClick={submit}
            disabled={!value || busy}
            style={{
              padding: '10px 22px', background: value && !busy ? PALETTE.accent : 'rgba(56,213,255,0.2)',
              color: value && !busy ? '#04121a' : PALETTE.dim, border: 'none', borderRadius: 8,
              cursor: value && !busy ? 'pointer' : 'default', fontSize: 14, fontWeight: 600,
            }}
          >
            {busy ? 'Verificando…' : 'Desbloquear'}
          </button>
        </div>
      </div>
    </div>
  )
}
