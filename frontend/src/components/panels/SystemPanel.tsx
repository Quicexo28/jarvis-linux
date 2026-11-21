import { HudPanel } from '../HudPanel'
import { HudBtn } from '../HudBtn'
import { PanelSection } from '../PanelSection'
import { StatRow } from '../StatRow'
import { HoloMeter } from '../HoloMeter'
import { GestureMonitor } from '../GestureMonitor'
import { SpeakerIdPanel } from '../SpeakerIdPanel'
import { TtsTestWidget } from '../TtsTestWidget'
import { ObsidianStatusBadge } from '../ObsidianStatusBadge'
import { useJarvisStore } from '../../state/jarvisStore'
import { useGestureStore } from '../../state/gestureStore'
import { useUiStore } from '../../state/uiStore'
import { useMobileLink } from '../../hooks/useMobileLink'
import { useSystemTelemetry } from '../../hooks/useSystemTelemetry'
import { gestureTone } from '../../lib/gestureTone'

/** Solo se monta con el modo abierto (o saliendo), así que siempre consulta al backend. */
export function SystemPanel({ exiting }: { exiting: boolean }) {
  const setZoomedMode = useJarvisStore(s => s.setZoomedMode)
  const gestureEnabled = useGestureStore(s => s.enabled)
  const gestureStatus = useGestureStore(s => s.status)
  const gestureFps = useGestureStore(s => s.fps)
  const setGestureDebugOpen = useUiStore(s => s.setGestureDebugOpen)
  const setSpeakerConfigOpen = useUiStore(s => s.setSpeakerConfigOpen)
  const mobile = useMobileLink(true)
  const telemetry = useSystemTelemetry(true)
  const { token, status } = mobile
  const host = telemetry.data?.host

  return (
    <HudPanel mode="Sistema" exiting={exiting} className="mode-panel">
      <PanelSection
        title="Conexión móvil"
        tone={status?.connected ? 'ok' : 'idle'}
        meta={status?.connected ? 'activa' : 'sin sesión'}
      >
        <div className="qr-block">
          <div className="qr-frame">
            <canvas ref={mobile.qrCanvasRef} />
            <span className="qr-countdown">{mobile.countdown}</span>
          </div>
          <div className="qr-urls">
            {token?.tunnelUrl
              ? <StatRow label="Túnel" value={token.tunnelUrl} tone="ok" wrap
                  onClick={() => mobile.copyUrl(token.tunnelUrl!)}
                  title={mobile.copiedUrl === token.tunnelUrl ? 'Copiado' : 'Clic para copiar'} />
              : <StatRow label="Túnel" value="no listo" tone="attn" />}
            {token?.tailscaleUrl && (
              <StatRow label="Tailscale" value={token.tailscaleUrl} tone="info" wrap
                onClick={() => mobile.copyUrl(token.tailscaleUrl!)}
                title={mobile.copiedUrl === token.tailscaleUrl ? 'Copiado' : 'Clic para copiar'} />
            )}
            <StatRow label="LAN" value={token?.lanUrl ?? '—'} wrap
              onClick={token?.lanUrl ? () => mobile.copyUrl(token.lanUrl!) : undefined}
              title={token?.lanUrl ? 'Clic para copiar' : undefined} />
            {status?.connected && (
              <StatRow
                label="Sesión"
                tone="ok"
                value={status.lastSeen
                  ? `hace ${Math.round((Date.now() - status.lastSeen) / 60_000)} min`
                  : 'conectado'}
                unit={status.via ?? undefined}
              />
            )}
          </div>
        </div>
        <HudBtn onClick={mobile.refreshQr}>Nuevo QR</HudBtn>
      </PanelSection>

      <PanelSection
        title="Gestos"
        tone={gestureTone(gestureEnabled, gestureStatus)}
        meta={gestureEnabled && gestureStatus === 'running' ? `${gestureFps} fps` : undefined}
      >
        <GestureMonitor />
        <HudBtn onClick={() => setGestureDebugOpen(true)}>Debug gestos</HudBtn>
      </PanelSection>

      <PanelSection title="Hablante">
        <SpeakerIdPanel onOpenConfig={() => setSpeakerConfigOpen(true)} />
      </PanelSection>

      <PanelSection title="Voz sintética">
        <TtsTestWidget />
      </PanelSection>

      <PanelSection title="Bóveda">
        <ObsidianStatusBadge />
        <HudBtn onClick={() => setZoomedMode('vault')}>Grafo de conocimiento</HudBtn>
      </PanelSection>

      {/* El hue de cada medidor lo decide severityHue dentro de HoloMeter. */}
      <PanelSection
        title="Telemetría"
        tone={telemetry.enabled ? 'info' : 'idle'}
        meta={telemetry.enabled ? undefined : 'off'}
      >
        {telemetry.enabled ? (
          <>
            <HoloMeter label="CPU" value={host?.cpu?.usagePct ?? null} warn={70} crit={90} decimals={1} />
            <HoloMeter label="GPU" value={host?.gpu?.avgUtilizationPct ?? null} warn={80} crit={95} decimals={1} />
            <HoloMeter label="RAM" value={host?.memory?.usagePct ?? null} warn={80} crit={93} decimals={0} />
            <StatRow label="Red ↓" value={(host?.network?.rxMbps ?? 0).toFixed(2)} unit="Mbps" />
            <StatRow label="Red ↑" value={(host?.network?.txMbps ?? 0).toFixed(2)} unit="Mbps" />
          </>
        ) : (
          <StatRow label="Estado" value="desactivada" tone="idle" />
        )}
      </PanelSection>
    </HudPanel>
  )
}
