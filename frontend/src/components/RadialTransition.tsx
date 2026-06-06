import { useEffect, useRef } from 'react'

interface Props {
  onComplete: () => void
}

export function RadialTransition({ onComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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
    const oy = h - 24
    const maxRadius = Math.sqrt(w * w + h * h)

    const startTime = performance.now()
    let rafId = 0

    const draw = (now: number) => {
      const elapsed = now - startTime
      ctx.clearRect(0, 0, w, h)

      if (elapsed > 100 && elapsed < 700) {
        const progress = Math.min(1, (elapsed - 100) / 500)
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

      if (elapsed >= 600) {
        canvas.style.opacity = String(Math.max(0, 1 - (elapsed - 600) / 200))
      }

      if (elapsed < 800) {
        rafId = requestAnimationFrame(draw)
      } else {
        onComplete()
      }
    }

    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [onComplete])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'none' }}
    />
  )
}
