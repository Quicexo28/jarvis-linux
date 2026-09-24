import { useEffect, useState } from 'react'
import { useGestureStore } from '../state/gestureStore'
import { HUE, withAlpha } from '../lib/theme'
import { StatRow } from './StatRow'
import { Badge } from './Badge'

/**
 * Monitor del pipeline de gestos.
 *
 * Los colores ya no son literales: `ok` = mano vista / gesto disparando,
 * `fail` = mano perdida, `attn` = pausa o arranque, `info` = dato neutro. Antes
 * este fichero tenía siete hex distintos (#64ffda, #ffd700, #ff5252, #00f0ff,
 * #ffffff11/15/18) elegidos uno a uno, así que "verde" significaba una cosa
 * aquí y otra en el panel de al lado.
 *
 * Los crosshairs se quedan como SVG a mano: son dos cuadrados de 56 px que se
 * repintan a la tasa del pipeline, y un componente genérico sería más código
 * para el mismo dibujo.
 */
export function GestureMonitor() {
  const enabled = useGestureStore(s => s.enabled)
  const output = useGestureStore(s => s.output)
  const status = useGestureStore(s => s.status)
  const statusDetail = useGestureStore(s => s.statusDetail)
  const fps = useGestureStore(s => s.fps)
  const [clickFlash, setClickFlash] = useState(false)
  const [backFlash, setBackFlash] = useState(false)

  useEffect(() => {
    if (output.click) { setClickFlash(true); const t = setTimeout(() => setClickFlash(false), 300); return () => clearTimeout(t) }
  }, [output.click])

  useEffect(() => {
    if (output.back) { setBackFlash(true); const t = setTimeout(() => setBackFlash(false), 300); return () => clearTimeout(t) }
  }, [output.back])

  const { debug } = output
  const zoomPct = ((output.pinch.zoom - 0.5) / 2.5) * 100
  const crossSize = 56
  const grabCx = crossSize / 2 + Math.max(-1, Math.min(1, output.grab.deltaX)) * (crossSize / 2 - 4)
  const grabCy = crossSize / 2 + Math.max(-1, Math.min(1, output.grab.deltaY)) * (crossSize / 2 - 4)

  if (!enabled) return <StatRow label="Pipeline" value="desactivado" tone="idle" />

  return (
    <div className="gesture-monitor">
      {status === 'starting' && <StatRow label="Pipeline" value="iniciando cámara y modelo…" tone="attn" />}
      {status === 'running' && <StatRow label="Backend" value={statusDetail} unit={`${fps} fps`} tone="ok" />}
      {status === 'error' && <StatRow label="Error" value={statusDetail} tone="fail" wrap />}

      <div className="gesture-hands">
        <HandIndicator label="Izquierda" detected={debug.leftDetected} gesture={debug.leftGesture} />
        <HandIndicator label="Derecha" detected={debug.rightDetected} gesture={debug.rightGesture} />
      </div>

      <div className="gesture-badges">
        {(['grab', 'point', 'peace_sep', 'peace_close'] as const).map(g => (
          <Badge key={`L:${g}`} tone={debug.leftGesture === g ? 'ok' : 'idle'}>
            {`L·${g.replace('_', ' ')}`}
          </Badge>
        ))}
        <Badge tone={debug.rightGesture === 'pinch' ? 'ok' : 'idle'}>R·pinch</Badge>
        {/* El tap es el botón del cursor: sin verlo aquí, un umbral mal
            calibrado se diagnostica como "los menús no responden". */}
        <Badge tone={output.tap.pressed ? 'ok' : 'idle'}>tap</Badge>
        {/* Qué mano manda AHORA: con una sola mano a la vista, esa maneja la
            interfaz. Sin este dato, "no responde" y "responde con la otra mano"
            se ven igual. */}
        <Badge tone={output.pointerHand ? 'info' : 'idle'}>
          {output.pointerHand ? `puntero·${output.pointerHand === 'left' ? 'IZQ' : 'DER'}` : 'sin puntero'}
        </Badge>
      </div>

      {/* Zoom: barra propia y no HoloMeter porque el valor es un MULTIPLICADOR
          relativo (0.5–3.0), no un porcentaje de nada. */}
      <div className="gesture-zoom">
        <span className="gesture-zoom-label">Zoom</span>
        <div className="gesture-zoom-track">
          <div
            className="gesture-zoom-fill"
            style={{
              width: `${Math.max(0, Math.min(100, zoomPct))}%`,
              background: output.pinch.paused ? HUE.attn : HUE.info,
              boxShadow: `0 0 8px ${withAlpha(output.pinch.paused ? HUE.attn : HUE.info, 0.5)}`,
            }}
          />
        </div>
        <span className="gesture-zoom-value">{output.pinch.zoom.toFixed(2)}</span>
        {output.pinch.paused && <Badge tone="attn">pausa</Badge>}
      </div>

      <div className="gesture-cross-row">
        <Crosshair size={crossSize} label="Grab">
          {output.grab.active && (
            <>
              <circle cx={grabCx} cy={grabCy} r={4} fill={HUE.info} opacity={0.85} />
              <circle cx={grabCx} cy={grabCy} r={7} fill="none" stroke={HUE.info} strokeWidth={0.5} opacity={0.4} />
            </>
          )}
        </Crosshair>

        <Crosshair size={crossSize} label="Point">
          {output.point.active && (
            // screenX/Y ya vienen en coords de pantalla 0..1 (espejo aplicado en el hook)
            <circle
              cx={4 + output.point.screenX * (crossSize - 8)}
              cy={4 + output.point.screenY * (crossSize - 8)}
              r={4} fill={HUE.ok} opacity={0.85}
            />
          )}
        </Crosshair>

        <div className="gesture-events">
          <Badge tone={clickFlash ? 'ok' : 'idle'} live={clickFlash}>click</Badge>
          <Badge tone={backFlash ? 'attn' : 'idle'} live={backFlash}>back</Badge>
        </div>
      </div>
    </div>
  )
}

function Crosshair({ size, label, children }: { size: number; label: string; children?: React.ReactNode }) {
  const grid = withAlpha(HUE.idle, 0.25)
  return (
    <div className="gesture-cross">
      <span className="gesture-cross-label">{label}</span>
      <svg width={size} height={size} className="gesture-cross-svg">
        <line x1={size / 2} y1={0} x2={size / 2} y2={size} stroke={grid} strokeWidth={0.5} />
        <line x1={0} y1={size / 2} x2={size} y2={size / 2} stroke={grid} strokeWidth={0.5} />
        <circle cx={size / 2} cy={size / 2} r={size / 2 - 2} fill="none" stroke={withAlpha(HUE.idle, 0.15)} strokeWidth={0.5} />
        {children}
      </svg>
    </div>
  )
}

function HandIndicator({ label, detected, gesture }: { label: string; detected: boolean; gesture: string }) {
  const hue = detected ? HUE.ok : HUE.fail
  return (
    <div
      className="gesture-hand"
      style={{
        borderColor: withAlpha(detected ? HUE.info : HUE.idle, detected ? 0.3 : 0.15),
        background: detected ? withAlpha(HUE.info, 0.04) : 'transparent',
      }}
    >
      <div className="gesture-hand-head">
        <i className="gesture-hand-dot" style={{ background: hue, boxShadow: `0 0 5px ${hue}` }} />
        <span className="gesture-hand-label">{label}</span>
      </div>
      <div className="gesture-hand-gesture" style={{ color: detected ? HUE.info : undefined }}>
        {detected ? gesture.replace('_', ' ') : '—'}
      </div>
    </div>
  )
}
