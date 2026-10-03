import { useState } from 'react'
import { S, T } from './theme'
import { elevationKey, signChallenge } from './native'
import { elevate, elevateChallenge, elevateEnroll, elevateStatus } from './api'

/**
 * Step-up authorisation for one risky chat turn (backend lib/riskAuth.js).
 *
 * Two factors, both checked by the SERVER: the special password, and a
 * signature from the tablet's hardware Keystore key, which only signs after
 * the fingerprint or the device PIN. The first time, the key is enrolled with
 * the same password. Success hands back a one-shot ticket that the caller
 * spends on resending the message.
 *
 * In a plain browser there is no Keystore key, so risky actions simply cannot
 * be authorised from there — on purpose: the password alone is one factor.
 */
export function AuthSheet({
  message, onTicket, onCancel,
}: {
  message: string
  onTicket: (ticket: string) => void
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const publicKey = elevationKey()

  const authorize = async () => {
    if (!publicKey || !password || busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await elevateStatus(publicKey)
      if (!status.configured) throw new Error('Falta fijar la contraseña especial en el PC (scripts/set-code-password.js --risk).')
      if (status.locked) throw new Error('Demasiados intentos fallidos. Espera unos minutos.')
      if (!status.enrolled) {
        const enrolled = await elevateEnroll(publicKey, password, 'tablet')
        if (!enrolled.ok) throw new Error(enrolled.message || 'No se pudo inscribir la tablet.')
      }
      const { challenge } = await elevateChallenge()
      const signature = await signChallenge(challenge)   // ← huella o PIN
      const r = await elevate(publicKey, challenge, signature, password)
      if (!r.ok || !r.ticket) throw new Error(r.message || 'Autorización rechazada.')
      setPassword('')
      onTicket(r.ticket)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Autorización fallida.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={() => !busy && onCancel()}
    >
      <div
        style={{
          ...S.card, width: '100%', maxWidth: 620, margin: 0, borderRadius: `${T.radius}px ${T.radius}px 0 0`,
          paddingBottom: 'calc(20px + env(safe-area-inset-bottom))', borderColor: 'rgba(251,191,36,0.45)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ ...S.sectionTitle, color: T.warn, margin: '0 0 8px' }}>Acción de riesgo</div>
        <div style={{ fontSize: 15, marginBottom: 6 }}>Jarvis necesita autorización para:</div>
        <div style={{ ...S.hint, color: T.dim, marginBottom: 14, whiteSpace: 'pre-wrap' }}>«{message}»</div>

        {!publicKey ? (
          <div style={{ ...S.hint, color: T.bad, marginBottom: 12 }}>
            Las acciones de riesgo solo se autorizan desde la app de la tablet (Android 11 o superior), con huella o PIN.
          </div>
        ) : (
          <>
            <input
              style={{ ...S.input, width: '100%', boxSizing: 'border-box', marginBottom: 10 }}
              type="password"
              autoComplete="off"
              placeholder="Contraseña especial"
              value={password}
              disabled={busy}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') authorize() }}
            />
            <div style={{ ...S.hint, marginBottom: 12 }}>Después la tablet te pedirá la huella o el PIN. Autoriza solo este mensaje.</div>
          </>
        )}

        {error && <div style={{ fontSize: 13, color: T.bad, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ ...S.btn, flex: 1 }} disabled={busy} onClick={onCancel}>Cancelar</button>
          {publicKey && (
            <button style={{ ...S.btnAccent, flex: 2 }} disabled={busy || !password} onClick={authorize}>
              {busy ? 'Autorizando…' : 'Autorizar con huella'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
