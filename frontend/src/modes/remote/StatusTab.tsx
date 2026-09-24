import { S, T, dotStyle, meterFill } from './theme'
import { ago, pct, batteryPct } from './format'
import { usePolled, type GeoStatus } from './hooks'
import { ctxCurrent } from './api'
import { getApiBase } from '../../api/client'
import { isNativeApp, nativeVersion, nativeReporterRunning, nativeBattery, openNativeSettings } from './native'
import type { SystemTelemetry } from '../../types'

function Bar({ label, value, fill }: { label: string; value: string; fill: number }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...S.rowBetween, marginBottom: 4 }}>
        <span style={S.label}>{label}</span>
        <span style={{ ...S.value, fontSize: 13 }}>{value}</span>
      </div>
      <div style={{ height: 5, background: T.lineSoft, borderRadius: 3, overflow: 'hidden' }}>
        <div style={meterFill(fill)} />
      </div>
    </div>
  )
}

export function StatusTab({
  online, telemetry, geo,
}: {
  online: boolean | null
  telemetry: SystemTelemetry | null
  geo: { status: GeoStatus; enable: () => void }
}) {
  const { data: ctx } = usePolled(ctxCurrent, 60_000)
  const native  = isNativeApp()
  const battery = nativeBattery()
  const cpu     = telemetry?.host?.cpu?.usagePct ?? 0
  const memUsed = telemetry?.host?.memory?.usedGB ?? 0
  const memTot  = telemetry?.host?.memory?.totalGB ?? 0
  const gpu     = telemetry?.host?.gpu?.avgUtilizationPct ?? 0
  const apkUrl  = `${getApiBase()}/jarvis-companion.apk`

  return (
    <div>
      <div style={S.sectionTitle}>Jarvis Main</div>
      <div style={S.card}>
        {online === false ? (
          <div style={{ ...S.hint, color: T.bad }}>Sin conexión con el backend — reintentando.</div>
        ) : telemetry ? (
          <>
            <Bar label="CPU" value={`${cpu.toFixed(0)}%`} fill={cpu} />
            <Bar label="RAM" value={`${memUsed.toFixed(1)} / ${memTot.toFixed(0)} GB`} fill={pct(memUsed, memTot)} />
            <Bar label="GPU" value={`${gpu.toFixed(0)}%`} fill={gpu} />
          </>
        ) : (
          <div style={S.hint}>Cargando telemetría…</div>
        )}
      </div>

      <div style={S.sectionTitle}>Este dispositivo</div>
      <div style={S.card}>
        <div style={{ ...S.rowBetween, marginBottom: 10 }}>
          <span style={S.label}>Modo</span>
          <span style={{ ...S.value, fontSize: 13 }}>{native ? `App ${nativeVersion() ?? ''}`.trim() : 'Navegador'}</span>
        </div>
        {native && (
          <div style={{ ...S.rowBetween, marginBottom: 10 }}>
            <span style={S.label}>Reporte en segundo plano</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={dotStyle(nativeReporterRunning() ? T.ok : T.warn)} />
              <span style={{ ...S.value, fontSize: 13 }}>{nativeReporterRunning() ? 'activo' : 'detenido'}</span>
            </span>
          </div>
        )}
        {battery && (
          <div style={{ ...S.rowBetween, marginBottom: 10 }}>
            <span style={S.label}>Batería</span>
            <span style={{ ...S.value, fontSize: 13 }}>{batteryPct(battery.level)}% {battery.charging ? '· cargando' : ''}</span>
          </div>
        )}
        <div style={S.rowBetween}>
          <span style={S.label}>Ubicación</span>
          {geo.status === 'on' ? (
            <span style={{ ...S.value, fontSize: 13, color: T.ok }}>compartiendo</span>
          ) : geo.status === 'denied' ? (
            <span style={{ ...S.value, fontSize: 13, color: T.bad }}>denegada</span>
          ) : (
            <button style={{ ...S.btnGhost, minHeight: 34 }} onClick={geo.enable}>Activar</button>
          )}
        </div>
      </div>

      <div style={S.sectionTitle}>Dispositivos vistos</div>
      <div style={S.card}>
        {ctx && Object.keys(ctx.devices ?? {}).length > 0 ? (
          Object.entries(ctx.devices).map(([name, d]) => (
            <div key={name} style={{ ...S.rowBetween, marginBottom: 8 }}>
              <span style={{ fontSize: 14 }}>{name}</span>
              <span style={{ ...S.hint }}>
                {d.battery ? `${batteryPct(d.battery.level)}%${d.battery.charging ? ' ⚡' : ''} · ` : ''}
                {ago(d.battery?.ts ?? d.presence?.ts ?? d.location?.ts)}
              </span>
            </div>
          ))
        ) : (
          <div style={S.hint}>Aún no hay reportes de móviles.</div>
        )}
        {ctx?.current?.location?.place && (
          <div style={{ ...S.hint, marginTop: 6 }}>Última ubicación: {ctx.current.location.place}</div>
        )}
      </div>

      <div style={S.sectionTitle}>App</div>
      <div style={S.card}>
        <div style={{ ...S.hint, marginBottom: 12 }}>
          La app de Android trae esta misma pantalla más el reporte en segundo plano (batería, ubicación,
          presencia) que un navegador no puede hacer.
        </div>
        <a href={apkUrl} download style={{ textDecoration: 'none' }}>
          <button style={{ ...S.btnAccent, width: '100%' }}>Descargar APK</button>
        </a>
        {native && (
          <button style={{ ...S.btn, width: '100%', marginTop: 8 }} onClick={openNativeSettings}>
            Ajustes de la app
          </button>
        )}
        <div style={{ ...S.hint, marginTop: 10, wordBreak: 'break-all' }}>{apkUrl}</div>
      </div>
    </div>
  )
}
