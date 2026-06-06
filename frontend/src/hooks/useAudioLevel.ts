import { useEffect, useRef, useState } from 'react'

interface Options {
  enabled: boolean
  smoothing?: number
}

export function useAudioLevel({ enabled, smoothing = 0.65 }: Options): number {
  const [level, setLevel] = useState(0)
  const levelRef = useRef(0)

  useEffect(() => {
    if (!enabled) { setLevel(0); levelRef.current = 0; return }

    let stream: MediaStream | null = null
    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let raf = 0
    let cancelled = false
    const buffer = new Uint8Array(256)

    const tick = () => {
      if (!analyser) return
      analyser.getByteTimeDomainData(buffer)
      let peak = 0
      for (let i = 0; i < buffer.length; i++) {
        const v = Math.abs(buffer[i] - 128) / 128
        if (v > peak) peak = v
      }
      const normalized = Math.min(1, peak * 2.2)
      const next = levelRef.current * smoothing + normalized * (1 - smoothing)
      levelRef.current = next
      setLevel(next)
      raf = requestAnimationFrame(tick)
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        stream = s
        audioCtx = new AudioContext()
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        audioCtx.createMediaStreamSource(s).connect(analyser)
        raf = requestAnimationFrame(tick)
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      audioCtx?.close()
    }
  }, [enabled, smoothing])

  return level
}
