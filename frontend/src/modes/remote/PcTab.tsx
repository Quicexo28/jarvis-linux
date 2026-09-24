import { useCallback, useEffect, useState } from 'react'
import { S, T, dotStyle, meterFill } from './theme'
import { uptime, mb, pct, baseName } from './format'
import { usePolled } from './hooks'
import {
  listMachines, machineSysInfo, machineProcesses, machineSearch, machineWake, remoteDesktop,
  pairMoonlight,
  type Machine, type SysInfo, type RemoteProcess, type SearchHit, type SunshineHost,
} from './api'
import { openMoonlight } from './native'

function Metric({ label, value, fill }: { label: string; value: string; fill?: number }) {
  return (
    <div>
      <div style={{ ...S.rowBetween, marginBottom: 4 }}>
        <span style={S.label}>{label}</span>
        <span style={{ ...S.value, fontSize: 13 }}>{value}</span>
      </div>
      {fill != null && (
        <div style={{ height: 5, background: T.lineSoft, borderRadius: 3, overflow: 'hidden' }}>
          <div style={meterFill(fill)} />
        </div>
      )}
    </div>
  )
}

/**
 * Una máquina emitiendo por Sunshine.
 *
 * Moonlight es una app aparte y no tiene esquema de URL para «conéctate a este
 * host» (moonlight-android#668), así que lo más cerca del ingreso directo que
 * se puede llegar es: copiar la dirección, abrir Moonlight, y —esto es lo que
 * de verdad ahorra trabajo— teclear aquí el PIN, porque si no hay que entrar a
 * la UI web de Sunshine con su certificado autofirmado desde la tablet.
 */
function SunshineRow({ host, onNotice }: { host: SunshineHost; onNotice: (t: string) => void }) {
  const [pinOpen, setPinOpen] = useState(false)
  const [pin, setPin]         = useState('')
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  const launch = () => {
    navigator.clipboard?.writeText(host.host)
    const res = openMoonlight()
    if (res === 'launched') onNotice(`${host.host} copiado. Añádelo en Moonlight si no está.`)
    else if (res === 'store') onNotice('Moonlight no está instalado; abriendo Play Store.')
    else onNotice(`${host.host} copiado. Ábrelo en Moonlight.`)
  }

  const pair = async () => {
    setBusy(true); setError(null)
    try {
      await pairMoonlight(host.host, pin, 'Jarvis')
      onNotice(`Emparejado con ${host.name}.`)
      setPinOpen(false); setPin('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo emparejar.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={S.rowBetween}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={dotStyle(host.running === false ? T.faint : T.ok)} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15 }}>{host.name}</div>
            <div style={{ ...S.hint, fontFamily: T.mono }}>
              {host.host}{host.paired != null && ` · ${host.paired} emparejado(s)`}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button style={S.btnGhost} onClick={() => setPinOpen((v) => !v)}>PIN</button>
          <button style={S.btnAccent} onClick={launch}>Abrir</button>
        </div>
      </div>

      {pinOpen && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              style={{ ...S.input, fontFamily: T.mono, letterSpacing: '3px' }}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="4 dígitos"
              inputMode="numeric"
            />
            <button style={S.btn} disabled={busy || pin.length !== 4} onClick={pair}>
              {busy ? '…' : 'Enviar'}
            </button>
          </div>
          <div style={{ ...S.hint, marginTop: 6 }}>
            En Moonlight, añade <span style={{ fontFamily: T.mono }}>{host.host}</span> y tócalo: te dará un PIN.
            Escríbelo aquí.
          </div>
          {error && <div style={{ ...S.hint, color: T.bad, marginTop: 6 }}>{error}</div>}
        </div>
      )}
    </div>
  )
}

/**
 * Ver la pantalla del portátil, que es lo primero que uno busca en una app
 * llamada «PC». No lo sirve Jarvis: pc-remote y Sunshine son procesos aparte
 * en sus propios puertos, así que aquí solo se muestra su estado y se salta a
 * ellos.
 *
 * Abrir navega la misma pestaña en vez de `target="_blank"`: el WebView del
 * APK no abre ventanas nuevas sin `setSupportMultipleWindows`, y su botón
 * atrás ya devuelve a Jarvis porque `MainActivity` delega en `web.goBack()`.
 */
function RemoteDesktopCard({ onNotice }: { onNotice: (t: string) => void }) {
  const { data, error } = usePolled(remoteDesktop, 30_000)

  const pc = data?.pcRemote

  return (
    <div style={S.card}>
      <div style={{ ...S.rowBetween, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={dotStyle(pc?.running ? T.ok : T.faint)} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 500 }}>Ver la pantalla</div>
            <div style={S.hint}>
              {pc?.running ? 'pc-remote encendido' : 'pc-remote apagado'}
            </div>
          </div>
        </div>
        <button
          style={{ ...S.btnAccent, opacity: pc?.url ? 1 : 0.4 }}
          disabled={!pc?.url}
          onClick={() => {
            if (!pc?.url) return
            window.location.href = pc.url
          }}
        >
          Abrir
        </button>
      </div>

      {pc && !pc.running && (
        <div style={{ ...S.hint, marginBottom: 10 }}>
          Arranca <span style={{ fontFamily: T.mono }}>pc-remote</span> en Jarvis Main.
        </div>
      )}
      {pc?.reason && <div style={{ ...S.hint, color: T.warn, marginBottom: 10 }}>{pc.reason}</div>}

      <div style={{ borderTop: `1px solid ${T.lineSoft}`, paddingTop: 12 }}>
        <div style={{ ...S.sectionTitle, margin: '0 0 8px' }}>Moonlight</div>
        {(data?.sunshine ?? []).map((h) => (
          <SunshineRow key={h.host} host={h} onNotice={onNotice} />
        ))}
        {data && data.sunshine.length === 0 && (
          <div style={S.hint}>Ninguna máquina del tailnet está emitiendo.</div>
        )}
      </div>

      <div style={{ ...S.hint, marginTop: 10 }}>
        pc-remote va sobre TCP y se congela cuando la red pierde paquetes; Moonlight va sobre UDP y aguanta. En wifi
        da igual cuál uses.
      </div>

      {error && <div style={{ ...S.hint, color: T.bad, marginTop: 10 }}>{error}</div>}
    </div>
  )
}

function MachineCard({ machine, onNotice }: { machine: Machine; onNotice: (t: string) => void }) {
  // This laptop opens expanded: it is the machine the user is most likely
  // asking about, and its data costs one local call.
  const [open, setOpen]         = useState(!!machine.local)
  const [info, setInfo]         = useState<SysInfo | null>(null)
  const [procs, setProcs]       = useState<RemoteProcess[] | null>(null)
  const [hits, setHits]         = useState<SearchHit[] | null>(null)
  const [query, setQuery]       = useState('')
  const [busy, setBusy]         = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)

  const guard = async (tag: string, fn: () => Promise<void>) => {
    setBusy(tag); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'Error') } finally { setBusy(null) }
  }

  const loadInfo = useCallback(() => guard('info', async () => {
    setInfo(await machineSysInfo(machine.name))
  }), [machine.name])

  useEffect(() => {
    if (open && machine.online && !info) loadInfo()
    // Only on mount: later opens go through toggle().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && machine.online && !info) loadInfo()
  }

  const dotColor = machine.online ? T.ok : T.faint
  // The app is used from the tablet, so "this PC" would name the wrong machine:
  // the laptop is shown by its own name.
  const title = machine.label ?? machine.name
  const subtitle = machine.local
    ? `${machine.os ?? 'Linux'} · ${machine.name}`
    : machine.online
      ? `${machine.os ?? 'desconocido'} · agente v${machine.agent_version ?? '?'}`
      : 'Sin conexión'

  return (
    <div style={S.card}>
      <button
        onClick={toggle}
        style={{ ...S.rowBetween, width: '100%', background: 'none', border: 'none', padding: 0, color: T.text, fontFamily: T.font, cursor: 'pointer', textAlign: 'left' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={dotStyle(dotColor)} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
            <div style={S.hint}>{subtitle}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={machine.local
            ? { ...S.badge, color: T.accent, borderColor: 'rgba(0,229,255,0.35)' }
            : S.badge}
          >
            {machine.local ? 'Servidor' : 'PC remoto'}
          </span>
          <span style={{ color: T.faint, fontSize: 18, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
        </div>
      </button>

      {open && !machine.online && (
        <div style={{ marginTop: 14 }}>
          <button
            style={{ ...S.btnAccent, width: '100%', opacity: busy === 'wake' ? 0.5 : 1 }}
            onClick={() => guard('wake', async () => {
              const sent = await machineWake(machine.name)
              onNotice(sent > 0 ? `Paquete de encendido enviado a ${machine.name}.` : 'No se envió ningún paquete.')
            })}
          >
            Encender (Wake-on-LAN)
          </button>
          <div style={{ ...S.hint, marginTop: 8 }}>
            Solo funciona si Jarvis Main está en la misma red que el PC — el paquete mágico no viaja por Tailscale.
          </div>
        </div>
      )}

      {open && machine.online && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {info ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Metric label="CPU" value={`${info.cpu_percent.toFixed(0)}%`} fill={info.cpu_percent} />
              <Metric
                label="RAM"
                value={`${mb(info.mem_used_mb)} / ${mb(info.mem_total_mb)}`}
                fill={pct(info.mem_used_mb, info.mem_total_mb)}
              />
              <Metric
                label="Disco"
                value={`${info.disk_used_gb} / ${info.disk_total_gb} GB`}
                fill={pct(info.disk_used_gb, info.disk_total_gb)}
              />
              <Metric label="Encendido" value={uptime(info.uptime_secs)} />
              <div style={S.hint}>{info.hostname}</div>
            </div>
          ) : (
            <div style={S.hint}>{busy === 'info' ? 'Consultando…' : 'Sin datos.'}</div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button style={S.btnGhost} onClick={loadInfo}>Actualizar</button>
            <button
              style={S.btnGhost}
              onClick={() => guard('procs', async () => setProcs(await machineProcesses(machine.name)))}
            >
              {busy === 'procs' ? 'Cargando…' : 'Procesos'}
            </button>
            {procs && <button style={S.btnGhost} onClick={() => setProcs(null)}>Ocultar</button>}
          </div>

          {procs && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {procs.slice(0, 8).map((p) => (
                <div key={p.pid} style={S.rowBetween}>
                  <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ ...S.value, fontSize: 12, color: T.dim }}>{mb(p.mem_mb)}</span>
                </div>
              ))}
              {procs.length === 0 && <div style={S.hint}>Sin procesos reportados.</div>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ ...S.input, minHeight: 40, fontSize: 14 }}
              value={query}
              placeholder="Buscar archivo…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !query.trim()) return
                guard('search', async () => setHits(await machineSearch(machine.name, query.trim())))
              }}
            />
            <button
              style={{ ...S.btnGhost, minHeight: 40 }}
              onClick={() => query.trim() && guard('search', async () => setHits(await machineSearch(machine.name, query.trim())))}
            >
              {busy === 'search' ? '…' : 'Ir'}
            </button>
          </div>

          {hits && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {hits.slice(0, 12).map((h) => (
                <div key={h.path.raw} title={h.path.raw}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {baseName(h.path.raw)}
                  </div>
                  <div style={{ ...S.hint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.path.raw}</div>
                </div>
              ))}
              {hits.length === 0 && <div style={S.hint}>Sin resultados.</div>}
            </div>
          )}
        </div>
      )}

      {error && <div style={{ ...S.hint, color: T.bad, marginTop: 10 }}>{error}</div>}
    </div>
  )
}

export function PcTab({ onNotice }: { onNotice: (text: string) => void }) {
  const { data, error, loading, reload } = usePolled(listMachines, 60_000)

  return (
    <div>
      <div style={{ ...S.sectionTitle, margin: '4px 2px 10px' }}>Escritorio remoto</div>
      <RemoteDesktopCard onNotice={onNotice} />

      <div style={{ ...S.rowBetween, margin: '18px 2px 10px' }}>
        <span style={{ ...S.sectionTitle, margin: 0 }}>Equipos</span>
        <button style={{ ...S.btnGhost, minHeight: 30, fontSize: 12 }} onClick={reload}>Refrescar</button>
      </div>

      {data?.hub === 'offline' && (
        <div style={{ ...S.card, borderColor: 'rgba(251,191,36,0.35)' }}>
          <div style={{ color: T.warn, fontSize: 14, marginBottom: 4 }}>Hub de agentes apagado</div>
          <div style={S.hint}>Arranca <span style={{ fontFamily: T.mono }}>jarvis-agenthub</span> en Jarvis Main para hablar con las máquinas.</div>
        </div>
      )}

      {loading && !data && <div style={{ ...S.card, ...S.hint }}>Buscando máquinas…</div>}
      {error && <div style={{ ...S.card, ...S.hint, color: T.bad }}>{error}</div>}

      {data?.machines.map((m) => <MachineCard key={m.name} machine={m} onNotice={onNotice} />)}

      {data && data.machines.length === 0 && (
        <div style={{ ...S.card, ...S.hint }}>Ninguna máquina registrada todavía.</div>
      )}

      <div style={{ ...S.hint, padding: '4px 2px' }}>
        «Jarvis Main» es el equipo que ejecuta a Jarvis; «PC remoto» son las máquinas con agente. Desde el móvil solo
        van consultas de lectura y el encendido: ejecutar comandos o abrir archivos sigue reservado al cerebro
        local{data && !data.execUnlocked ? '' : ' (desbloqueado por JARVIS_AGENTS_REMOTE_EXEC)'}.
      </div>
    </div>
  )
}
