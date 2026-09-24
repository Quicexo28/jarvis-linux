import { useState } from 'react'
import { S, T, dotStyle } from './theme'
import { listMachines, machineWake } from './api'
import { usePolled } from './hooks'
import { SetupRgb } from './SetupRgb'

/**
 * Real actions only. The placeholder rows (Sala / TV / Aire) named devices that
 * do not exist yet, so every button was a dead end; what this tab actually has
 * to offer today is powering the PCs on.
 */
export function HomeTab({ onNotice }: { onNotice: (text: string) => void }) {
  const { data, loading, reload } = usePolled(listMachines, 30_000)
  const [busy, setBusy] = useState<string | null>(null)

  // Machines that can be woken: known, with an agent, currently down.
  const sleeping = (data?.machines ?? []).filter((m) => !m.online && !m.local)

  const wake = async (name: string) => {
    setBusy(name)
    try {
      const sent = await machineWake(name)
      onNotice(sent > 0 ? `Encendiendo ${name}…` : `No se envió ningún paquete a ${name}.`)
      setTimeout(reload, 4000)
    } catch (e) {
      onNotice(e instanceof Error ? e.message : `No se pudo encender ${name}.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <SetupRgb onNotice={onNotice} />

      <div style={S.sectionTitle}>Encender equipos</div>

      {loading && !data && <div style={{ ...S.card, ...S.hint }}>Buscando equipos…</div>}

      {data?.machines.filter((m) => !m.local).map((m) => (
        <div key={m.name} style={{ ...S.card, ...S.rowBetween }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={dotStyle(m.online ? T.ok : T.faint)} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 500 }}>{m.label ?? m.name}</div>
              <div style={S.hint}>{m.online ? 'Encendido' : 'Apagado o suspendido'}</div>
            </div>
          </div>
          {m.online ? (
            <span style={{ ...S.value, fontSize: 13, color: T.ok }}>activo</span>
          ) : (
            <button
              style={{ ...S.btnAccent, minHeight: 38, opacity: busy === m.name ? 0.5 : 1 }}
              onClick={() => wake(m.name)}
            >
              {busy === m.name ? 'Enviando…' : 'Encender'}
            </button>
          )}
        </div>
      ))}

      {data && data.machines.filter((m) => !m.local).length === 0 && (
        <div style={{ ...S.card, ...S.hint }}>Ninguna máquina registrada todavía.</div>
      )}

      <div style={{ ...S.hint, padding: '4px 2px' }}>
        {sleeping.length > 0
          ? 'Wake-on-LAN solo llega si Jarvis Main está en la misma red que el equipo — el paquete mágico no viaja por Tailscale.'
          : 'Todo encendido. Cualquier otra orden («baja el volumen», «cambia el color del setup») va por chat o dictado.'}
      </div>
    </div>
  )
}
