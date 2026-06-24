import { useBootStore } from '../state/bootStore'

/**
 * Mini HUD shown while in PIP (ventana flotante). Mantiene a Jarvis visible
 * con un núcleo pulsante; un clic restaura la pantalla completa.
 */
export function PipLayer() {
  const leavePip = useBootStore((s) => s.leavePip)

  const restore = () => {
    leavePip()
    try { window.resizeTo(window.screen.width, window.screen.height) } catch { /* Electron lo maneja vía bridge */ }
  }

  return (
    <div className="pip-layer" onClick={restore} title="Volver a pantalla completa">
      <div className="wake-pulse wake-pulse--active">
        <span className="wake-pulse__ring" />
        <span className="wake-pulse__ring" />
        <span className="wake-pulse__core" />
      </div>
      <div className="pip-label">Jarvis</div>
      <div className="pip-sub">En espera · Clic para expandir</div>
    </div>
  )
}
