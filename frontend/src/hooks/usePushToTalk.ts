import { useEffect, useRef } from 'react'
import { useJarvisStore } from '../state/jarvisStore'

/**
 * In-app push-to-talk key handling. While `pttEnabled`, holding `pttKey`
 * (KeyboardEvent.code) sets `pttActive`; releasing it clears it after a short
 * grace period so the STT VAD (~960 ms of silence) can finalize the last
 * segment before the mic closes. The global Hyprland bind takes the other
 * path: POST /api/jarvis/ptt/start|stop → skill bus `ptt_set` → same store.
 */

const RELEASE_GRACE_MS = 1500

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
    || (t instanceof HTMLElement && t.isContentEditable)
}

export function usePushToTalk() {
  const pttEnabled = useJarvisStore((s) => s.pttEnabled)
  const pttKey = useJarvisStore((s) => s.pttKey)
  const setPttActive = useJarvisStore((s) => s.setPttActive)
  const releaseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!pttEnabled) return

    const clearReleaseTimer = () => {
      if (releaseTimerRef.current !== null) {
        window.clearTimeout(releaseTimerRef.current)
        releaseTimerRef.current = null
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== pttKey || e.repeat || isTypingTarget(e.target)) return
      e.preventDefault()
      clearReleaseTimer()
      setPttActive(true)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== pttKey) return
      clearReleaseTimer()
      releaseTimerRef.current = window.setTimeout(() => {
        releaseTimerRef.current = null
        setPttActive(false)
      }, RELEASE_GRACE_MS)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      clearReleaseTimer()
      setPttActive(false)
    }
  }, [pttEnabled, pttKey, setPttActive])
}
