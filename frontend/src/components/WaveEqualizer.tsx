/**
 * Real-time SMOOTH waveform on a SINGLE 2D <canvas> cleared every frame
 * (ctx.clearRect). No WebGL / Three.js — a transparent always-on-top WebGL
 * surface on Wayland/WebKitGTK accumulates frames until it saturates and
 * freezes. A 2D canvas we clear ourselves cannot accumulate.
 *
 * NO ctx.shadowBlur: on a transparent WebKitGTK canvas the blurred glow is NOT
 * fully cleared by clearRect and builds up into a trail ("estela"). Glow is
 * faked with stacked translucent stroke passes sharing the SAME path.
 *
 * Not a raw oscilloscope (raw mic samples cross zero many times → looks like a
 * scribble of overlapping lines). Instead one clean smooth wave whose AMPLITUDE
 * is driven by the live mic RMS: silence → a straight line; speech → it swells.
 */
import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { acquireMic, releaseMic } from '../audio/micFeed'

const POINTS    = 120        // sampled points across the line
const WAVE_W    = 240        // total drawn width of the wave (px)
const AMP       = 30         // max vertical excursion (px) at full scale
const GAIN      = 14         // mic RMS → 0..1 level multiplier
const GATE      = 0.006      // RMS below this → 0 (flat on true silence)
const SMOOTH    = 0.8        // analyser smoothingTimeConstant

interface WaveEqualizerProps {
  label?: string             // drawn in-canvas below the wave (uppercased)
  active?: boolean           // false → forced flat line
  reactive?: boolean         // open mic and react to voice (default true)
  style?: CSSProperties
}

export function WaveEqualizer({ label, active = true, reactive = true, style }: WaveEqualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const labelRef = useRef(label)
  labelRef.current = label

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let W = 0, H = 0, dpr = 1

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      W = canvas.clientWidth
      H = canvas.clientHeight
      canvas.width  = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    // ── Mic (Web Audio time-domain) ────────────────────────────────────────
    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let buf: Uint8Array<ArrayBuffer> | null = null
    let micReady = false

    let held = false
    let cancelled = false

    // Micro COMPARTIDO (audio/micFeed.ts). Este componente está montado en
    // permanencia dentro de ListeningOverlay: con getUserMedia propio sumaba un
    // stream más al churn que hace SIGSEGV al cliente PipeWire de WebKitGTK.
    if (reactive) {
      acquireMic()
        .then((s) => {
          if (cancelled) { releaseMic(); return }
          held = true
          audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
          const src = audioCtx.createMediaStreamSource(s)
          analyser = audioCtx.createAnalyser()
          analyser.fftSize = 2048
          analyser.smoothingTimeConstant = SMOOTH
          buf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
          src.connect(analyser)
          // WebKitGTK/overlay windows start the context 'suspended' (no user
          // gesture) → analyser yields silence → flat line. Force resume.
          audioCtx.resume().catch(() => {})
          micReady = true
        })
        .catch(() => { micReady = false })   // denied → stays flat
    }

    let level = 0   // smoothed 0..1 mic loudness

    // Current mic loudness (RMS of time-domain), gated + amplified, 0..1.
    const readLevel = (): number => {
      if (!activeRef.current || !micReady || !analyser || !buf) return 0
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      let rms = Math.sqrt(sum / buf.length)
      if (rms < GATE) rms = 0
      return Math.min(1, rms * GAIN)
    }

    // One clean smooth wave: two slow sines, edge-tapered, scaled by `level`.
    const waveY = (p: number, t: number) => {
      const env = Math.sin(Math.PI * p) ** 2          // anchor both ends
      const s =
        Math.sin(p * 9 + t * 2.2) * 0.6 +
        Math.sin(p * 15 - t * 1.5) * 0.4
      return env * s * level
    }

    const strokePath = (t: number, cy: number, ww: number, width: number, color: string | CanvasGradient) => {
      const x0 = W / 2 - ww / 2
      ctx.beginPath()
      for (let i = 0; i <= POINTS; i++) {
        const p = i / POINTS
        const x = x0 + p * ww
        const y = cy + waveY(p, t) * AMP
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.lineWidth   = width
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.strokeStyle = color
      ctx.stroke()
    }

    const draw = (now: number) => {
      const t = now / 1000
      // Hard reset the backing store (clears pixels + alpha + transform).
      canvas.width = canvas.width
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const cx = W / 2
      const cy = H / 2
      const ww = Math.min(WAVE_W, W * 0.92)   // fit narrow boxes too

      // CRITICAL: a transparent always-on-top WebKitGTK window does NOT push
      // cleared-to-transparent pixels to the Wayland compositor (no "damage"),
      // so old strokes ghost into trails / stacked lines. Painting an OPAQUE
      // card over the whole drawable every frame forces a full repaint → no
      // trails. The card also makes this read as a proper "card".
      const cardCol = 'rgba(6, 14, 22, 0.82)'
      ctx.fillStyle = cardCol
      roundRect(ctx, 1, 1, W - 2, H - 2, 16)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.22)'
      ctx.lineWidth = 1
      roundRect(ctx, 1, 1, W - 2, H - 2, 16)
      ctx.stroke()

      // Smooth the loudness: fast attack, slow release → fluid, never jittery.
      const target = readLevel()
      level += (target - level) * (target > level ? 0.45 : 0.12)

      const grad = ctx.createLinearGradient(cx - ww / 2, 0, cx + ww / 2, 0)
      grad.addColorStop(0,   'rgba(61, 240, 255, 0.2)')
      grad.addColorStop(0.5, 'rgba(150, 252, 255, 1)')
      grad.addColorStop(1,   'rgba(61, 240, 255, 0.2)')

      // Same geometry for both passes → one glowing line (no separate lines).
      strokePath(t, cy, ww, 3, 'rgba(61, 240, 255, 0.12)')   // soft glow
      strokePath(t, cy, ww, 1.4, grad)                        // bright core

      const lbl = labelRef.current
      if (lbl) {
        ctx.fillStyle = 'rgba(0, 229, 255, 0.75)'
        ctx.font = '8px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(lbl.toUpperCase().split('').join(' '), cx, cy + AMP + 6)
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      ro.disconnect()
      if (held) releaseMic()   // compartido: no parar tracks ajenos
      audioCtx?.close().catch(() => {})
    }
    // `label` NO va en deps: cambia ('Escuchando' ↔ 'PTT') al cambiar de modo y
    // rehacía todo el efecto — reabriendo el micro en el peor momento posible.
    // Se lee por ref dentro del bucle de dibujo.
  }, [reactive])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height: '100%', background: 'transparent', ...style }}
    />
  )
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y,     x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x,     y + h, rr)
  ctx.arcTo(x,     y + h, x,     y,     rr)
  ctx.arcTo(x,     y,     x + w, y,     rr)
  ctx.closePath()
}
