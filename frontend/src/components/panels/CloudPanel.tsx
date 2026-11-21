import { HudPanel } from '../HudPanel'
import { HudBtn } from '../HudBtn'
import { PanelSection } from '../PanelSection'
import { StatRow } from '../StatRow'
import { ObsidianStatusBadge } from '../ObsidianStatusBadge'
import { useJarvisStore } from '../../state/jarvisStore'

export function CloudPanel({ exiting }: { exiting: boolean }) {
  const setZoomedMode = useJarvisStore(s => s.setZoomedMode)
  return (
    <HudPanel mode="Nube" exiting={exiting} className="mode-panel mode-panel--grid">
      <PanelSection title="Sincronización" tone="idle" meta="pendiente">
        <StatRow label="Backup de voz" value="no" tone="idle" />
        <StatRow label="Planos 2D/3D" value="no" tone="idle" />
        <StatRow label="Historial cruzado" value="no" tone="idle" />
      </PanelSection>
      <PanelSection title="Bóveda" tone="info">
        <ObsidianStatusBadge />
        <HudBtn onClick={() => setZoomedMode('vault')}>Abrir grafo de conocimiento</HudBtn>
      </PanelSection>
    </HudPanel>
  )
}
