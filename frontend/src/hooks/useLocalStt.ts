/**
 * React hook for local STT — replaces webkitSpeechRecognition.
 *
 * Streams microphone audio to the backend faster-whisper service via WebSocket.
 * Returns real-time transcripts with speaker confidence.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { startLocalStt, type LocalSttSession, type SttTranscript, type SttFinalMeta } from '../audio/localStt'

export interface UseLocalSttOptions {
  enabled: boolean
  onFinalTranscript?: (text: string, speakerConfidence: number, speakerName?: string, meta?: SttFinalMeta) => void
  onInterimTranscript?: (text: string) => void
}

export interface UseLocalSttResult {
  listening: boolean
  transcript: string
  speakerConfidence: number
  start: () => void
  stop: () => void
}

export function useLocalStt({
  enabled,
  onFinalTranscript,
  onInterimTranscript,
}: UseLocalSttOptions): UseLocalSttResult {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [speakerConfidence, setSpeakerConfidence] = useState(0)
  const sessionRef = useRef<LocalSttSession | null>(null)
  // Monotonic token: each start()/stop() bumps it. A start() only keeps its
  // session if its token is still current when the async open resolves — so a
  // StrictMode mount→unmount→mount can't leave two live mic sessions.
  const startTokenRef = useRef(0)
  const onFinalRef = useRef(onFinalTranscript)
  const onInterimRef = useRef(onInterimTranscript)

  onFinalRef.current = onFinalTranscript
  onInterimRef.current = onInterimTranscript

  const handleTranscript = useCallback((t: SttTranscript) => {
    setTranscript(t.text)
    setSpeakerConfidence(t.speakerConfidence)

    if (t.isFinal) {
      onFinalRef.current?.(t.text, t.speakerConfidence, t.speakerName, {
        avgLogprob: t.avgLogprob,
        confidence: t.confidence,
      })
    } else {
      onInterimRef.current?.(t.text)
    }
  }, [])

  const start = useCallback(async () => {
    if (sessionRef.current?.isActive()) return
    const myToken = ++startTokenRef.current
    try {
      const session = await startLocalStt(handleTranscript)
      // Stale (a stop() or newer start() happened while opening) → discard.
      if (myToken !== startTokenRef.current) { session.stop(); return }
      sessionRef.current = session
      setListening(true)
    } catch (err) {
      console.error('[useLocalStt] failed to start:', err)
      setListening(false)
    }
  }, [handleTranscript])

  const stop = useCallback(() => {
    startTokenRef.current++
    sessionRef.current?.stop()
    sessionRef.current = null
    setListening(false)
  }, [])

  // Auto-start/stop based on enabled prop
  useEffect(() => {
    if (enabled) {
      start()
    } else {
      stop()
    }
    return () => { stop() }
  }, [enabled, start, stop])

  return { listening, transcript, speakerConfidence, start, stop }
}
