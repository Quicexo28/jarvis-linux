import { useState, useRef } from 'react'
import type { WallType, Segment, SavedPlan } from '../types'
import { GRID_CELLS, CELL_METERS, VIEWBOX_SIZE, STEP, PLAN_STORAGE_KEY } from '../constants'

function snap(v: number) {
  return Math.max(0, Math.min(GRID_CELLS, Math.floor(v / STEP)))
}

export function loadSavedPlans(): SavedPlan[] {
  try {
    const raw = localStorage.getItem(PLAN_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SavedPlan[]) : []
  } catch {
    return []
  }
}

export function Plan2DEditor() {
  const [segments, setSegments] = useState<Segment[]>([])
  const [draft, setDraft] = useState<Segment | null>(null)
  const [hoverCell, setHoverCell] = useState<{ cx: number; cy: number } | null>(null)
  const [room, setRoom] = useState('')
  const [planName, setPlanName] = useState('')
  const [savedPlans, setSavedPlans] = useState<SavedPlan[]>(() => loadSavedPlans())
  const [wallType, setWallType] = useState<WallType>('solid')
  const [planTool, setPlanTool] = useState<'draw' | 'erase'>('draw')
  const svgRef = useRef<SVGSVGElement | null>(null)

  const toCell = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    const x = ((clientX - rect.left) / rect.width) * VIEWBOX_SIZE
    const y = ((clientY - rect.top) / rect.height) * VIEWBOX_SIZE
    return { cx: snap(x), cy: snap(y) }
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const point = toCell(e.clientX, e.clientY)
    if (!point) return

    if (planTool === 'erase') {
      setSegments((prev) => prev.filter((seg) => {
        const minX = Math.min(seg.x1, seg.x2)
        const maxX = Math.max(seg.x1, seg.x2)
        const minY = Math.min(seg.y1, seg.y2)
        const maxY = Math.max(seg.y1, seg.y2)
        return !(point.cx >= minX && point.cx <= maxX && point.cy >= minY && point.cy <= maxY)
      }))
      return
    }

    const start: Segment = { x1: point.cx, y1: point.cy, x2: point.cx, y2: point.cy, wallType }
    setDraft(start)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const point = toCell(e.clientX, e.clientY)
    if (!point) return
    setHoverCell(point)
    if (planTool === 'erase') return
    if (!draft) return
    const dx = Math.abs(point.cx - draft.x1)
    const dy = Math.abs(point.cy - draft.y1)
    const horizontal = dx >= dy
    setDraft({
      x1: draft.x1,
      y1: draft.y1,
      x2: horizontal ? point.cx : draft.x1,
      y2: horizontal ? draft.y1 : point.cy,
      wallType: draft.wallType,
    })
  }

  const onPointerUp = () => {
    if (planTool === 'erase') return
    if (draft && !(draft.x1 === draft.x2 && draft.y1 === draft.y2)) setSegments((prev) => [...prev, draft])
    setDraft(null)
  }

  const onPointerLeave = () => {
    onPointerUp()
    setHoverCell(null)
  }

  const persistPlans = (plans: SavedPlan[]) => {
    setSavedPlans(plans)
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plans))
  }

  const saveByRoomName = () => {
    const roomSafe = room.trim()
    const nameSafe = planName.trim()
    if (!roomSafe || !nameSafe || segments.length === 0) return
    const payload: SavedPlan = { room: roomSafe, name: nameSafe, segments, updatedAt: new Date().toISOString() }
    const next = [...savedPlans]
    const idx = next.findIndex((p) => p.room.toLowerCase() === roomSafe.toLowerCase() && p.name.toLowerCase() === nameSafe.toLowerCase())
    if (idx >= 0) next[idx] = payload
    else next.unshift(payload)
    persistPlans(next)
  }

  const loadPlan = (plan: SavedPlan) => {
    setSegments(plan.segments)
    setRoom(plan.room)
    setPlanName(plan.name)
  }

  return (
    <div className="plan2d-overlay">
      <div className="glass plan2d-panel">
        <div className="label">Editor 2D</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Líneas: {segments.length}</span>
          <span>Área: {(GRID_CELLS * CELL_METERS).toFixed(0)}m × {(GRID_CELLS * CELL_METERS).toFixed(0)}m</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button className={`btn ${planTool === 'draw'   ? 'active' : ''}`} onClick={() => setPlanTool('draw')}>Dibujar</button>
          <button className={`btn ${planTool === 'erase'  ? 'active' : ''}`} onClick={() => setPlanTool('erase')}>Borrar</button>
          <button className={`btn ${wallType  === 'solid' ? 'active' : ''}`} onClick={() => setWallType('solid')}>Sólido</button>
          <button className={`btn ${wallType  === 'low'   ? 'active' : ''}`} onClick={() => setWallType('low')}>Bajo</button>
          <button className="btn" onClick={() => setSegments((prev) => prev.slice(0, -1))}>↩</button>
          <button className="btn" onClick={() => setSegments([])}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="input" placeholder="Habitación" value={room} onChange={(e) => setRoom(e.target.value)} />
          <input className="input" placeholder="Nombre del plano" value={planName} onChange={(e) => setPlanName(e.target.value)} />
          <button
            className="btn"
            onClick={saveByRoomName}
            disabled={!room.trim() || !planName.trim() || segments.length === 0}
          >
            Guardar
          </button>
        </div>
        {savedPlans.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="label">Guardados</div>
            {savedPlans.slice(0, 5).map((p) => (
              <button key={`${p.room}-${p.name}`} className="btn" onClick={() => loadPlan(p)}>
                {p.room} · {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="glass plan2d-canvas-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
          className="plan2d-svg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        >
          {Array.from({ length: GRID_CELLS + 1 }).flatMap((_, i) =>
            Array.from({ length: GRID_CELLS + 1 }).map((__, j) => (
              <circle
                key={`${i}-${j}`}
                cx={i * STEP}
                cy={j * STEP}
                r={i % 2 === 0 && j % 2 === 0 ? 1.8 : 1}
                className="plan-grid-dot"
              />
            ))
          )}
          {segments.map((s, idx) => (
            <line
              key={idx}
              x1={s.x1 * STEP} y1={s.y1 * STEP}
              x2={s.x2 * STEP} y2={s.y2 * STEP}
              className={`plan-wall-line${s.wallType === 'low' ? ' low' : ''}`}
            />
          ))}
          {draft && (
            <line
              x1={draft.x1 * STEP} y1={draft.y1 * STEP}
              x2={draft.x2 * STEP} y2={draft.y2 * STEP}
              className={`plan-wall-line draft${draft.wallType === 'low' ? ' low' : ''}`}
            />
          )}
          {hoverCell && (
            <circle cx={hoverCell.cx * STEP} cy={hoverCell.cy * STEP} r={5} className="plan-hover-dot" />
          )}
          {draft && (
            <circle cx={draft.x1 * STEP} cy={draft.y1 * STEP} r={6} className="plan-start-dot" />
          )}
        </svg>
      </div>
    </div>
  )
}
