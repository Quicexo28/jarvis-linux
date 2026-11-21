import { useEffect, useRef } from 'react'

interface Props {
  onComplete: () => void
}

export function RadialTransition({ onComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // En una ref: si fuera dependencia del efecto, cada render de App (el padre pasa una flecha nueva)
  // reiniciaría la animación y saldría dos veces.
  const done = useRef(onComplete)
  done.current = onComplete

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = window.innerWidth
    const h = window.innerHeight
    canvas.width = w
    canvas.height = h

    const ox = w / 2
    const oy = h / 2
    // Desde el centro, llegar a las esquinas pide media diagonal.
    const maxRadius = Math.sqrt(w * w + h * h) / 2

    const startTime = performance.now()
    let rafId = 0

    const draw = (now: number) => {
      const elapsed = now - startTime
      ctx.clearRect(0, 0, w, h)

      if (elapsed > 60 && elapsed < 460) {
        const progress = Math.min(1, (elapsed - 60) / 340)
        const radius = maxRadius * Math.pow(progress, 0.65)

        const gradient = ctx.createRadialGradient(ox, oy, 0, ox, oy, radius)
        gradient.addColorStop(0, '#00f0ff')
        gradient.addColorStop(0.35, '#0059ff')
        gradient.addColorStop(1, '#03080d')

        ctx.beginPath()
        ctx.arc(ox, oy, radius, 0, Math.PI * 2)
        ctx.fillStyle = gradient
        ctx.fill()

        ctx.beginPath()
        ctx.arc(ox, oy, radius, 0, Math.PI * 2)
        ctx.strokeStyle = '#00f0ff'
        ctx.lineWidth = 2
        ctx.shadowBlur = 20
        ctx.shadowColor = '#00f0ff'
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      if (elapsed >= 380) {
        canvas.style.opacity = String(Math.max(0, 1 - (elapsed - 380) / 140))
      }

      if (elapsed < 520) {
        rafId = requestAnimationFrame(draw)
      } else {
        done.current()
      }
    }

    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' }}
    />
  )
}
