/**
 * Mando — control directo del PC desde el móvil.
 *
 * Todo aquí pega a las rutas de escritorio (`/api/skills/system/*`) SIN pasar
 * por el modelo: un botón de pausa no puede tardar un turno de voz. Lo que no
 * cabe en un botón (apagar, abrir apps, mirar la pantalla) se le pide a Jarvis
 * en la pestaña principal — esas rutas son local-only en remoto a propósito.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { S, T } from './theme'
import {
  media, volume, listWindows, windowAction, gotoWorkspace,
  clipboardGet, clipboardSet, dnd,
  type MediaState, type VolumeState, type PcWindow,
} from './api'

type Notify = (text: string) => void

const WORKSPACES = [1, 2, 3, 4, 5]

function Icon({ d, size = 22 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', margin: '0 auto' }}>
      <path d={d} />
    </svg>
  )
}

const ICON = {
  prev:  'M19 5v14L8 12zM5 5v14',
  next:  'M5 5v14l11-7zM19 5v14',
  play:  'M7 4v16l13-8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  minus: 'M5 12h14',
  plus:  'M12 5v14M5 12h14',
  mute:  'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  sound: 'M4 9h4l5-4v14l-5-4H4zM17 8a5 5 0 0 1 0 8',
  close: 'M6 6l12 12M18 6 6 18',
  sync:  'M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M20 20v-4h-4',
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ ...S.rowBetween, marginBottom: 2 }}>
        <div style={S.sectionTitle}>{title}</div>
        {action}
      </div>
      <div style={S.card}>{children}</div>
    </section>
  )
}

/** Wrap an action: report failures as a toast instead of throwing into React. */
function useRunner(onNotice: Notify) {
  return useCallback(async <R,>(fn: () => Promise<R>): Promise<R | null> => {
    try { return await fn() } catch (e) { onNotice((e as Error).message); return null }
  }, [onNotice])
}

function MediaCard({ onNotice }: { onNotice: Notify }) {
  const [state, setState] = useState<MediaState | null>(null)
  const [none, setNone] = useState(false)

  const load = useCallback(async (action: Parameters<typeof media>[0] = 'status', quiet = false) => {
    try {
      setState(await media(action)); setNone(false)
    } catch (e) {
      setNone(true)
      if (!quiet) onNotice((e as Error).message)
    }
  }, [onNotice])

  // Poll while the tab is open: what plays on the PC changes without us.
  useEffect(() => {
    load('status', true)
    const t = setInterval(() => load('status', true), 5000)
    return () => clearInterval(t)
  }, [load])

  // Los proxies MPRIS de KDE Connect son el propio MÓVIL: si es lo único
  // abierto, el mando pausaría el teléfono con el que se está manejando.
  const phoneOnly = !!state && /^kdeconnect/i.test(state.player)
  const idle = none || !state || phoneOnly
  const playing = !idle && /playing/i.test(state?.status ?? '')
  const bigBtn = { ...S.btn, flex: 1, minHeight: 56 }

  return (
    <Section title="Música">
      <div style={{ minHeight: 40, marginBottom: 12 }}>
        {idle ? (
          <div style={S.hint}>No hay nada reproduciendo en el PC.</div>
        ) : (
          <>
            <div style={{ fontSize: 16, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {state!.title || 'Sin título'}
            </div>
            <div style={S.hint}>{[state!.artist, state!.player].filter(Boolean).join(' · ')}</div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={bigBtn} aria-label="Anterior" disabled={idle} onClick={() => load('previous')}><Icon d={ICON.prev} /></button>
        <button style={{ ...bigBtn, ...S.btnAccent, minHeight: 56 }} aria-label={playing ? 'Pausa' : 'Reproducir'} disabled={idle} onClick={() => load('toggle')}>
          <Icon d={playing ? ICON.pause : ICON.play} size={26} />
        </button>
        <button style={bigBtn} aria-label="Siguiente" disabled={idle} onClick={() => load('next')}><Icon d={ICON.next} /></button>
      </div>
    </Section>
  )
}

function VolumeCard({ onNotice }: { onNotice: Notify }) {
  const run = useRunner(onNotice)
  const [vol, setVol] = useState<VolumeState | null>(null)
  // Slider position while the finger is down; applied on release, not per
  // move, so a drag doesn't fire dozens of pamixer calls.
  const [draft, setDraft] = useState<number | null>(null)

  useEffect(() => { run(() => volume('get')).then((v) => v && setVol(v)) }, [run])

  const act = async (action: Parameters<typeof volume>[0], value?: number) => {
    const v = await run(() => volume(action, value))
    if (v) setVol(v)
    setDraft(null)
  }

  const level = draft ?? vol?.level ?? 0
  return (
    <Section title="Volumen">
      <div style={{ ...S.rowBetween, marginBottom: 10 }}>
        <span style={{ ...S.value, fontSize: 22, color: vol?.muted ? T.faint : T.text }}>
          {vol?.level == null ? '—' : `${level}%`}
        </span>
        <button style={{ ...S.btn, color: vol?.muted ? T.warn : T.dim }} aria-label="Silenciar" onClick={() => act('toggle')}>
          <Icon d={vol?.muted ? ICON.mute : ICON.sound} size={20} />
        </button>
      </div>
      <input
        type="range" min={0} max={100} value={level}
        style={{ width: '100%', accentColor: T.accent, height: 32 }}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => draft != null && act('set', draft)}
        onTouchEnd={() => draft != null && act('set', draft)}
        onKeyUp={() => draft != null && act('set', draft)}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button style={{ ...S.btn, flex: 1 }} aria-label="Bajar volumen" onClick={() => act('down')}><Icon d={ICON.minus} /></button>
        <button style={{ ...S.btn, flex: 1 }} aria-label="Subir volumen" onClick={() => act('up')}><Icon d={ICON.plus} /></button>
      </div>
    </Section>
  )
}

function WindowsCard({ onNotice }: { onNotice: Notify }) {
  const run = useRunner(onNotice)
  const [wins, setWins] = useState<PcWindow[] | null>(null)
  // Closing loses unsaved work; the ✕ asks once before acting.
  const [armed, setArmed] = useState<string | null>(null)

  const load = useCallback(() => run(listWindows).then((w) => w && setWins(w)), [run])
  useEffect(() => { load() }, [load])

  const focus = async (w: PcWindow) => {
    if (await run(() => windowAction('focus', w.address))) onNotice(`Enfocada: ${w.class}`)
  }
  const close = async (w: PcWindow) => {
    if (armed !== w.address) { setArmed(w.address); return }
    setArmed(null)
    if (await run(() => windowAction('close', w.address))) load()
  }

  return (
    <Section
      title="Ventanas"
      action={<button style={{ ...S.btnGhost, minHeight: 30 }} aria-label="Actualizar" onClick={load}><Icon d={ICON.sync} size={16} /></button>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 12 }}>
        {WORKSPACES.map((n) => (
          <button key={n} style={{ ...S.btn, padding: 0 }} onClick={async () => { if (await run(() => gotoWorkspace(n))) load() }}>
            {n}
          </button>
        ))}
      </div>
      {wins === null && <div style={S.hint}>Cargando…</div>}
      {wins?.length === 0 && <div style={S.hint}>No hay ventanas abiertas.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {wins?.map((w) => (
          <div key={w.address} style={{ display: 'flex', gap: 6 }}>
            <button
              style={{ ...S.btn, flex: 1, minWidth: 0, textAlign: 'left', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '6px 12px' }}
              onClick={() => focus(w)}
            >
              <span style={{ fontSize: 14 }}>{w.class} <span style={{ color: T.faint, fontSize: 12 }}>· {w.workspace}</span></span>
              <span style={{ ...S.hint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>{w.title}</span>
            </button>
            <button
              style={{ ...S.btn, width: armed === w.address ? 84 : 48, padding: 0, color: armed === w.address ? T.bad : T.faint, fontSize: 12 }}
              aria-label="Cerrar ventana"
              onClick={() => close(w)}
            >
              {armed === w.address ? '¿Cerrar?' : <Icon d={ICON.close} size={18} />}
            </button>
          </div>
        ))}
      </div>
    </Section>
  )
}

function ClipboardCard({ onNotice }: { onNotice: Notify }) {
  const run = useRunner(onNotice)
  const [text, setText] = useState('')

  const pull = async () => {
    const r = await run(clipboardGet)
    if (!r) return
    if (!r.text) { onNotice(r.detail ?? 'El portapapeles del PC está vacío.'); return }
    setText(r.text)
    // Best effort: needs a secure context and a user gesture, both true here.
    try { await navigator.clipboard.writeText(r.text); onNotice('Copiado en el móvil.') } catch { /* queda en la caja */ }
  }
  const pasteFromPhone = async () => {
    try { setText(await navigator.clipboard.readText()) } catch { onNotice('El móvil no deja leer su portapapeles; pega a mano.') }
  }
  const push = async () => {
    if (!text.trim()) return
    const r = await run(() => clipboardSet(text))
    if (r) onNotice('Enviado al portapapeles del PC.')
  }

  return (
    <Section title="Portapapeles">
      <textarea
        value={text}
        placeholder="Texto para mandar al PC…"
        onChange={(e) => setText(e.target.value)}
        style={{ ...S.input, width: '100%', minHeight: 72, padding: 12, resize: 'vertical', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button style={{ ...S.btn, flex: 1 }} onClick={pull}>Traer del PC</button>
        <button style={{ ...S.btn, flex: 1 }} onClick={pasteFromPhone}>Pegar</button>
        <button style={{ ...S.btnAccent, flex: 1 }} onClick={push} disabled={!text.trim()}>Enviar</button>
      </div>
    </Section>
  )
}

function DndRow({ onNotice }: { onNotice: Notify }) {
  const run = useRunner(onNotice)
  const [active, setActive] = useState<boolean | null>(null)
  useEffect(() => { run(() => dnd('status')).then((r) => r && setActive(r.active)) }, [run])
  const toggle = async () => { const r = await run(() => dnd('toggle')); if (r) setActive(r.active) }
  return (
    <div style={{ ...S.card, ...S.rowBetween }}>
      <div>
        <div style={{ fontSize: 15 }}>No molestar</div>
        <div style={S.hint}>Silencia las notificaciones del PC.</div>
      </div>
      <button
        style={{ ...(active ? S.btnAccent : S.btn), minWidth: 84 }}
        aria-pressed={!!active}
        onClick={toggle}
      >
        {active == null ? '…' : active ? 'Activo' : 'Apagado'}
      </button>
    </div>
  )
}

export function MandoTab({ onNotice }: { onNotice: Notify }) {
  return (
    <div>
      <MediaCard onNotice={onNotice} />
      <VolumeCard onNotice={onNotice} />
      <WindowsCard onNotice={onNotice} />
      <ClipboardCard onNotice={onNotice} />
      <DndRow onNotice={onNotice} />
      <div style={{ ...S.hint, textAlign: 'center', padding: '4px 12px' }}>
        Apagar, abrir apps o mirar la pantalla: pídeselo a Jarvis.
      </div>
    </div>
  )
}
