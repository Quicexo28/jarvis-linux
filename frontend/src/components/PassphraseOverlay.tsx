/**
 * PassphraseOverlay — modal that asks the owner for the code-change permission
 * password. Shown only when the backend requests it over the skill bus before a
 * self-coding action (run_command / checkpoint / rollback / restart). Driven by
 * passphraseStore. The typed value is sent back to the backend, which verifies
 * it against the stored hash; the password never persists in the renderer.
 */

import { useEffect, useRef, useState } from 'react'
import { usePassphraseStore } from '../state/passphraseStore'

const PALETTE = {
  bg: 'rgba(8, 14, 20, 0.96)',
  border: 'rgba(56, 213, 255, 0.55)',
  glow: 'rgba(56, 213, 255, 0.25)',
  accent: '#38d5ff',
  text: '#e8f6ff',
  dim: '#7fa6b8',
}

export function PassphraseOverlay() {
  const pending = usePassphraseStore((s) => s.pending)
  const submit = usePassphraseStore((s) => s.submit)
  const cancel = usePassphraseStore((s) => s.cancel)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset + focus whenever a new request opens.
  useEffect(() => {
    if (pending) {
      setValue('')
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [pending])

  if (!pending) return null

  const onSubmit = () => {
    if (!value) return
    submit(value)
    setValue('')
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel()
        if (e.key === 'Enter') onSubmit()
      }}
    >
      <div
        style={{
          width: 420, maxWidth: '90vw', padding: '28px 28px 24px',
          background: PALETTE.bg, border: `1px solid ${PALETTE.border}`,
          borderRadius: 14, boxShadow: `0 0 40px ${PALETTE.glow}`,
          color: PALETTE.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 13, letterSpacing: 1.5, color: PALETTE.accent, textTransform: 'uppercase', marginBottom: 10 }}>
          Permiso requerido
        </div>
        <div style={{ fontSize: 15, color: PALETTE.text, marginBottom: 6 }}>
          Cambio en el código de Jarvis
        </div>
        <div style={{ fontSize: 13, color: PALETTE.dim, marginBottom: 18, lineHeight: 1.4 }}>
          {pending.reason || 'Ingrese la contraseña para autorizar esta acción.'}
        </div>
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Contraseña"
          autoComplete="off"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '12px 14px',
            background: 'rgba(0,0,0,0.4)', border: `1px solid ${PALETTE.border}`,
            borderRadius: 8, color: PALETTE.text, fontSize: 16, outline: 'none',
            letterSpacing: 2,
          }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button
            onClick={cancel}
            style={{
              padding: '9px 18px', background: 'transparent', color: PALETTE.dim,
              border: `1px solid ${PALETTE.dim}`, borderRadius: 8, cursor: 'pointer', fontSize: 14,
            }}
          >
            Cancelar
          </button>
          <button
            onClick={onSubmit}
            disabled={!value}
            style={{
              padding: '9px 20px', background: value ? PALETTE.accent : 'rgba(56,213,255,0.2)',
              color: value ? '#04121a' : PALETTE.dim, border: 'none', borderRadius: 8,
              cursor: value ? 'pointer' : 'default', fontSize: 14, fontWeight: 600,
            }}
          >
            Autorizar
          </button>
        </div>
      </div>
    </div>
  )
}
