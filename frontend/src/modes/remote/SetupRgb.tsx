import { useEffect, useRef, useState } from 'react'
import { S, T } from './theme'
import { usePolled } from './hooks'
import { hexToHsv, hsToPoint, hsvToHex, pointToHs } from './color'
import { rgbSet, rgbPreset, rgbPresets, rgbState, type RgbTarget } from './api'

/**
 * Setup lighting: Jarvis RGB (`rgb_ctl.py` on `main`, same script its desktop
 * GUI drives) reached through backend → agent exec.
 *
 * Mirrors that GUI's two brightness controls, because they are different
 * things: the wheel's value slider darkens the colour itself (what the PC side
 * obeys), while "Brillo teclado" is the keyboard's own hardware level 1-5
 * (`kb_brightness` there, `--brightness` on the CLI). Per-device effects and
 * keyboard modes are absent only because they have no HTTP surface yet.
 */

const TARGETS: [value: RgbTarget, label: string][] = [
  ['all', 'Todo'],
  ['pc', 'PC'],
  ['keyboard', 'Teclado'],
]

const HEX_RE = /^#?[0-9a-fA-F]{6}$/
/** Hue ring; the white core is layered on top for saturation. */
const WHEEL_BG = [
  'radial-gradient(circle closest-side, #ffffff 0%, rgba(255,255,255,0) 72%)',
  'conic-gradient(from 0deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
].join(', ')

export function SetupRgb({ onNotice }: { onNotice: (text: string) => void }) {
  const [target, setTarget] = useState<RgbTarget>('all')
  const [hue, setHue]       = useState(0)
  const [sat, setSat]       = useState(1)
  const [val, setVal]       = useState(100)
  const [kb, setKb]         = useState(5)
  const [hex, setHex]       = useState('')
  const [busy, setBusy]     = useState<string | null>(null)
  const wheel = useRef<HTMLDivElement>(null)
  const { data: presets } = usePolled(rgbPresets, 300_000)
  // Mirror of the desktop GUI: both write the same state file on `main`, so a
  // colour picked over there lands here (and the other way round). Adopting
  // only when the colour actually differs is what keeps the two from ping-ponging.
  const { data: shared } = usePolled(rgbState, 3000)

  const color = hsvToHex(hue, sat, val / 100)

  useEffect(() => {
    const remote = shared?.color?.replace('#', '').toLowerCase()
    if (!remote || remote === color) return
    const { h, s, v } = hexToHsv(remote)
    setHue(h)
    // A fully dark colour carries no hue/saturation: keep the wheel where the
    // user left it instead of snapping the marker to the centre.
    if (v > 0) { setSat(s); setVal(Math.round(v * 100)) } else { setVal(5) }
    if (shared?.kb_brightness) setKb(shared.kb_brightness)
    // `color` is derived from the state this effect sets; depending on it would
    // re-run the adoption against itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared?.color, shared?.ts])

  const apply = async (value: string, tag = 'color', brightness = kb) => {
    setBusy(tag)
    try {
      await rgbSet(value, target, brightness)
      onNotice(value === 'off' ? 'Setup apagado.' : `Setup en #${value.replace('#', '')}.`)
    } catch (e) {
      onNotice(e instanceof Error ? e.message : 'No se pudo cambiar el color.')
    } finally {
      setBusy(null)
    }
  }

  const applyPreset = async (name: string) => {
    setBusy(`p:${name}`)
    try {
      await rgbPreset(name)
      onNotice(`Preset ${name} aplicado.`)
    } catch (e) {
      onNotice(e instanceof Error ? e.message : `No se pudo aplicar ${name}.`)
    } finally {
      setBusy(null)
    }
  }

  // Dragging only moves the marker; the light changes on release, so a slow
  // finger doesn't fire dozens of RPCs at the Windows box.
  const track = (e: React.PointerEvent) => {
    const box = wheel.current?.getBoundingClientRect()
    if (!box) return
    const radius = box.width / 2
    const { h, s } = pointToHs(e.clientX - box.left - radius, e.clientY - box.top - radius, radius)
    setHue(h)
    setSat(s)
  }

  const marker = hsToPoint(hue, sat, 50) // percent-space: radius 50 = the rim

  return (
    <>
      <div style={S.sectionTitle}>Setup</div>
      <div style={S.card}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          {TARGETS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTarget(value)}
              style={{
                ...S.btnGhost,
                flex: 1,
                minHeight: 34,
                ...(target === value
                  ? { color: T.accent, borderColor: 'rgba(0,229,255,0.45)', background: 'rgba(0,229,255,0.10)' }
                  : null),
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <div
            ref={wheel}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); track(e) }}
            onPointerMove={(e) => { if (e.buttons) track(e) }}
            onPointerUp={() => apply(color)}
            style={{
              position: 'relative', width: '100%', maxWidth: 230, aspectRatio: '1',
              borderRadius: '50%', background: WHEEL_BG,
              border: `1px solid ${T.line}`, touchAction: 'none', cursor: 'crosshair',
              filter: `brightness(${Math.max(0.25, val / 100)})`,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: `${50 + marker.dx}%`, top: `${50 + marker.dy}%`,
                width: 20, height: 20, marginLeft: -10, marginTop: -10,
                borderRadius: '50%', background: `#${color}`,
                border: '2px solid #fff', boxShadow: '0 0 6px rgba(0,0,0,0.6)',
                pointerEvents: 'none',
              }}
            />
          </div>
        </div>

        <div style={{ ...S.rowBetween, marginBottom: 6 }}>
          <span style={S.label}>Brillo · {val}%</span>
          <span style={{ ...S.value, fontSize: 13 }}>#{color}</span>
        </div>
        <input
          type="range"
          min={5}
          max={100}
          step={5}
          value={val}
          onChange={(e) => setVal(Number(e.target.value))}
          onPointerUp={() => apply(hsvToHex(hue, sat, val / 100))}
          onKeyUp={() => apply(hsvToHex(hue, sat, val / 100))}
          style={{ width: '100%', accentColor: T.accent, marginBottom: 14 }}
        />

        {target !== 'pc' && (
          <>
            <div style={{ ...S.rowBetween, marginBottom: 6 }}>
              <span style={S.label}>Brillo teclado</span>
              <span style={{ ...S.value, fontSize: 13 }}>{kb} / 5</span>
            </div>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={kb}
              onChange={(e) => setKb(Number(e.target.value))}
              onPointerUp={() => apply(color, 'color', kb)}
              onKeyUp={() => apply(color, 'color', kb)}
              style={{ width: '100%', accentColor: T.accent, marginBottom: 14 }}
            />
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input
            style={{ ...S.input, minHeight: 40, fontSize: 14, fontFamily: T.mono }}
            value={hex}
            placeholder="#RRGGBB"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && HEX_RE.test(hex)) apply(hex.replace('#', ''), 'hex') }}
          />
          <button
            style={{ ...S.btnGhost, minHeight: 40, opacity: HEX_RE.test(hex) ? 1 : 0.4 }}
            onClick={() => HEX_RE.test(hex) && apply(hex.replace('#', ''), 'hex')}
          >
            {busy === 'hex' ? '…' : 'Aplicar'}
          </button>
        </div>

        <button
          style={{ ...S.btn, width: '100%', opacity: busy === 'off' ? 0.5 : 1 }}
          onClick={() => apply('off', 'off')}
        >
          Apagar luces
        </button>

        {presets && presets.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ ...S.hint, marginBottom: 8 }}>Presets</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {presets.map((name) => (
                <button
                  key={name}
                  style={{ ...S.btnGhost, opacity: busy === `p:${name}` ? 0.5 : 1 }}
                  onClick={() => applyPreset(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
